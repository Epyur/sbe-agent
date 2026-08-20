import type { Dialog, AgentMessage, LlmTurn } from '../types/agent';
import type { AgentTool, AgentToolContext, AgentAttachment } from './tools-registry';
import { errorMessage } from '../../../sbe-core/src/utils/errors';

const MAX_ITERATIONS = 6;

export interface RunAgentParams {
  dialog: Dialog;
  userMessage: string;
  attachment: AgentAttachment | null;
  model?: string;
  onToolResult: (message: AgentMessage) => void;
  onAssistant: (text: string) => void;
}

/** Цикл агента: контекст → LLM → tool_call/final → исполнение → повтор. */
export class AgentEngine {
  private llm: { completeJson: (system: string, user: string, opts?: { model?: string }) => Promise<unknown> };
  private tools: AgentTool[];
  private ctx: AgentToolContext;

  constructor(
    llm: { completeJson: (system: string, user: string, opts?: { model?: string }) => Promise<unknown> },
    tools: AgentTool[],
    ctx: AgentToolContext,
  ) {
    this.llm = llm;
    this.tools = tools;
    this.ctx = ctx;
  }

  private buildSystemPrompt(): string {
    const sources = this.ctx.getSources();
    const sourceList = sources.length > 0
      ? sources.map(s => `- ${s.name}${s.available ? (s.role ? ` (${s.role})` : '') : ' (нет доступа)'}`).join('\n')
      : '- локальная база задач (всегда доступна)';

    const toolLines = this.tools.map(t => JSON.stringify({
      name: t.schema.name,
      description: t.schema.description,
      input_schema: t.schema.input_schema,
    }));

    return [
      `Ты — LogicTEAM.007, корпоративный ИИ-агент компании «СБЕ ПМиПИР».`,
      `Пользователь: ${this.ctx.getUserName() || '—'} (${this.ctx.getEmail() || '—'}).`,
      `Доступные источники данных (по правам пользователя):`,
      sourceList,
      ``,
      `Ты можешь вызывать инструменты для доступа к данным и создания файлов.`,
      `Правила:`,
      `1. Для ответа сначала собери нужные данные через тулы (например, get_tasks / get_emails).`,
      `2. Для генерации документа (Word/Excel/PDF/JSON) сформируй spec и вызови create_* — получишь ссылку на скачивание.`,
      `3. Прикреплённый пользователем файл можно прочитать тулом parse_file.`,
      `4. Если данных недостаточно или прав нет — честно скажи об этом.`,
      `5. НЕ выдумывай данные, которых не получил из тулов.`,
      ``,
      `Инструменты (JSON-схемы):`,
      toolLines.join('\n'),
      ``,
      `Формат ответа — СТРОГО один JSON-объект одного из двух видов:`,
      `{"type":"final","text":"<ответ пользователю>"}`,
      `{"type":"tool_call","tool":"<имя тула>","arguments":{...}}`,
      ``,
      `Начинай с tool_call, если нужно собрать данные. Завершай ответом final на русском языке.`,
    ].join('\n');
  }

  private serializeHistory(dialog: Dialog): string {
    const lines: string[] = [];
    for (const m of dialog.messages) {
      if (m.role === 'user') {
        lines.push(`[Пользователь] ${m.content}`);
      } else if (m.role === 'assistant') {
        lines.push(`[Ассистент] ${m.content}`);
      } else if (m.role === 'tool') {
        lines.push(`[Результат тула ${m.tool || ''} (${m.toolOk ? 'ok' : 'ошибка'})] ${m.content.slice(0, 4000)}`);
      }
    }
    lines.push('');
    lines.push('Твой ход (только JSON):');
    return lines.join('\n');
  }

  private findTool(name: string): AgentTool | undefined {
    return this.tools.find(t => t.schema.name === name);
  }

  async run(params: RunAgentParams): Promise<void> {
    const system = this.buildSystemPrompt();

    let transcript = this.serializeHistory(params.dialog);
    const seenCalls = new Map<string, number>();

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      let turn: LlmTurn;
      try {
        const parsed = await this.llm.completeJson(system, transcript, params.model ? { model: params.model } : undefined);
        turn = this.normalizeTurn(parsed);
      } catch (e: unknown) {
        params.onAssistant(`Ошибка обращения к LLM: ${errorMessage(e)}`);
        return;
      }

      if (turn.type === 'final') {
        params.onAssistant(turn.text || 'Готово.');
        return;
      }

      const tool = this.findTool(turn.tool || '');
      if (!tool) {
        params.onToolResult(this.toolMessage(turn.tool || '?', false, `Неизвестный инструмент «${turn.tool}»`));
        transcript += `\n[Результат тула ${turn.tool} (ошибка)] Неизвестный инструмент\nТвой ход (только JSON):`;
        continue;
      }

      // защита от зацикливания на одном и том же вызове
      const callKey = `${turn.tool}:${JSON.stringify(turn.arguments || {})}`;
      const count = (seenCalls.get(callKey) || 0) + 1;
      seenCalls.set(callKey, count);
      if (count > 2) {
        params.onAssistant('Достигнут лимит повторных вызовов инструмента. Уточните задачу.');
        return;
      }

      const result = await tool.execute(this.ctx, turn.arguments || {}, params.attachment);
      params.onToolResult(this.toolMessage(turn.tool, result.ok, result.ok ? this.summaryForLlm(result.summary, result.data) : (result.error || 'ошибка')));

      transcript += `\n${result.ok
        ? `[Результат тула ${turn.tool} (ok)] ${this.summaryForLlm(result.summary, result.data)}`
        : `[Результат тула ${turn.tool} (ошибка)] ${result.error || 'ошибка'}`}\nТвой ход (только JSON):`;
    }

    params.onAssistant('Превышено число шагов агента (6). Попробуйте сформулировать задачу уже. Более точный вопрос ускорит работу.');
  }

  private normalizeTurn(parsed: unknown): LlmTurn {
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (obj.type === 'final') {
        return { type: 'final', text: typeof obj.text === 'string' ? obj.text : '' };
      }
      if (obj.type === 'tool_call') {
        return {
          type: 'tool_call',
          tool: typeof obj.tool === 'string' ? obj.tool : '',
          arguments: obj.arguments && typeof obj.arguments === 'object'
            ? (obj.arguments as Record<string, unknown>)
            : {},
        };
      }
    }
    return { type: 'final', text: String(parsed ?? '') };
  }

  private toolMessage(tool: string, ok: boolean, content: string): AgentMessage {
    return {
      role: 'tool',
      tool,
      toolOk: ok,
      content,
      created_at: new Date().toISOString(),
    };
  }

  /** Для LLM показываем и summary, и (компактно) data. */
  private summaryForLlm(summary: string, data?: unknown): string {
    if (data === undefined) return summary || '';
    let json = '';
    try {
      json = JSON.stringify(data);
      if (json.length > 8000) json = json.slice(0, 8000) + '\n…(обрезано)';
    } catch {
      json = String(data);
    }
    return `${summary}\nДанные: ${json}`;
  }
}
