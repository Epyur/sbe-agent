import type { Dialog, AgentMessage, LlmTurn } from '../types/agent';
import type { AgentTool, AgentToolContext, AgentAttachment } from './tools-registry';
import { SYSTEM_PROMPT_PATH, SYSTEM_PROMPT_TEMPLATE, renderSystemPrompt } from './system-prompt';
import { loadAllRules } from './tools/rules-tools';
import { errorMessage } from '../../../sbe-core/src/utils/errors';

const DEFAULT_MAX_ITERATIONS = 15;

/** Идемпотентные чтение/навигация — повтор одного вызова не считается зацикливанием
 *  (напр. повторное открытие страницы, ожидание пользователя). Общий лимит шагов
 *  всё равно ограничивает (maxIterations). fetch_url НЕ исключён: повторный запрос
 *  с теми же параметрами возвращает тот же результат — это и есть зацикливание. */
const IDEMPOTENT_TOOLS = new Set([
  'browser_open', 'browser_wait', 'browser_extract', 'browser_links', 'browser_screenshot',
]);

export interface RunAgentParams {
  dialog: Dialog;
  userMessage: string;
  attachment: AgentAttachment | null;
  model?: string;
  onToolResult: (message: AgentMessage) => void;
  onAssistant: (text: string) => void;
  /** Статус работы агента для индикатора в чате (что агент делает сейчас). */
  onProgress: (status: string) => void;
}

/** Цикл агента: контекст → LLM → tool_call/final → исполнение → повтор. */
export class AgentEngine {
  private llm: {
    complete: (system: string, user: string, opts?: { model?: string }) => Promise<string>;
    completeJson: (system: string, user: string, opts?: { model?: string }) => Promise<unknown>;
  };
  private tools: AgentTool[];
  private ctx: AgentToolContext;
  private maxIterations: number;

  constructor(
    llm: {
      complete: (system: string, user: string, opts?: { model?: string }) => Promise<string>;
      completeJson: (system: string, user: string, opts?: { model?: string }) => Promise<unknown>;
    },
    tools: AgentTool[],
    ctx: AgentToolContext,
    maxIterations = DEFAULT_MAX_ITERATIONS,
  ) {
    this.llm = llm;
    this.tools = tools;
    this.ctx = ctx;
    this.maxIterations = maxIterations;
  }

  private async buildSystemPrompt(): Promise<string> {
    let template = SYSTEM_PROMPT_TEMPLATE;
    try {
      if (await this.ctx.vaultExists(SYSTEM_PROMPT_PATH)) {
        const fileContent = await this.ctx.readVaultText(SYSTEM_PROMPT_PATH);
        if (fileContent && fileContent.trim()) {
          template = fileContent;
        }
      }
    } catch (e: unknown) {
      console.warn('LogicTEAM.007: не удалось прочитать контекст агента, использую встроенный:', errorMessage(e));
    }
    return renderSystemPrompt(template, this.ctx, this.tools) + await this.buildRulesBlock();
  }

  /** Правила пользователя из файлов правил — автоприменение в каждом запуске. */
  private async buildRulesBlock(): Promise<string> {
    const rules = await loadAllRules(this.ctx);
    if (!rules) return '';
    return `\n\nПравила пользователя (из файлов правил в yourbase/sbe_agent/rules/, обязательны к исполнению):\n${rules}`;
  }

  private serializeHistory(dialog: Dialog): string {
    const lines: string[] = [];
    for (const m of dialog.messages) {
      if (m.role === 'user') {
        const files = m.files?.length ? ` (прикреплён файл: ${m.files.join(', ')})` : '';
        lines.push(`[Пользователь] ${m.content}${files}`);
      } else if (m.role === 'assistant') {
        lines.push(`[Ассистент] ${m.content}`);
      } else if (m.role === 'tool') {
        lines.push(`[Результат тула ${m.tool || ''} (${m.toolOk ? 'ok' : 'ошибка'})] ${m.content.slice(0, 15000)}`);
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
    const system = await this.buildSystemPrompt();

    let transcript = this.serializeHistory(params.dialog);
    const seenCalls = new Map<string, number>();

    for (let i = 0; i < this.maxIterations; i++) {
      params.onProgress('Агент думает…');
      let turns: LlmTurn[];
      try {
        // Ленивый разбор хода (не жёсткий completeJson): сырой текст ответа LLM;
        // извлекаем все подряд идущие JSON-объекты и исполняем их по порядку —
        // модель иногда возвращает сразу несколько tool_call в одном ответе
        // (частый случай после чтения больших документов). Если JSON нет вовсе —
        // текст становится финальным ответом, а не ошибкой.
        const raw = await this.llm.complete(system, transcript, params.model ? { model: params.model } : undefined);
        turns = this.parseTurns(raw);
      } catch (e: unknown) {
        params.onAssistant(`Ошибка обращения к LLM: ${errorMessage(e)}`);
        return;
      }

      for (const turn of turns) {
        if (turn.type === 'final') {
          params.onAssistant(turn.text || 'Готово.');
          return;
        }

        params.onProgress(`Вызываю инструмент «${turn.tool || '…'}»…`);
        const tool = this.findTool(turn.tool || '');
        if (!tool) {
          params.onToolResult(this.toolMessage(turn.tool || '?', false, `Неизвестный инструмент «${turn.tool}»`));
          transcript += `\n[Результат тула ${turn.tool} (ошибка)] Неизвестный инструмент\nТвой ход (только JSON):`;
          continue;
        }

        // защита от зацикливания на одном и том же вызове (кроме идемпотентных
        // навигации/чтения — их повтор допустим, предел даёт maxIterations)
        const callKey = `${turn.tool}:${JSON.stringify(turn.arguments || {})}`;
        const count = (seenCalls.get(callKey) || 0) + 1;
        seenCalls.set(callKey, count);
        if (!IDEMPOTENT_TOOLS.has(turn.tool) && count > 2) {
          params.onAssistant(`Защита от зацикливания: инструмент «${turn.tool}» вызван одинаково ${count} раз. Измените параметры или уточните задачу.`);
          return;
        }

        const result = await tool.execute(this.ctx, turn.arguments || {}, params.attachment);
        params.onToolResult(this.toolMessage(turn.tool, result.ok, result.ok ? result.summary : (result.error || 'ошибка'), result.link));

        transcript += `\n${result.ok
          ? `[Результат тула ${turn.tool} (ok)] ${this.summaryForLlm(result.summary, result.data)}`
          : `[Результат тула ${turn.tool} (ошибка)] ${result.error || 'ошибка'}`}\nТвой ход (только JSON):`;
      }
    }

    params.onAssistant(`Превышено число шагов агента (${this.maxIterations}). Попробуйте сформулировать задачу более конкретно, либо увеличьте лимит шагов в настройках агента.`);
  }

  /** Ленивый разбор хода LLM в список ходов: все подряд идущие JSON-объекты
   *  (tool_call/final) + обычный текст как финальный ответ, если JSON не найден. */
  private parseTurns(text: string): LlmTurn[] {
    const turns: LlmTurn[] = [];
    let rest = text.trim();
    const fence = rest.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) rest = fence[1].trim();

    while (true) {
      const start = rest.indexOf('{');
      if (start === -1) break;
      // первый сбалансированный объект {…} (с учётом строк и экранирования)
      let depth = 0;
      let inStr = false;
      let esc = false;
      let objEnd = -1;
      for (let i = start; i < rest.length; i++) {
        const ch = rest[i];
        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) { objEnd = i; break; }
        }
      }
      if (objEnd === -1) break;
      const objStr = rest.substring(start, objEnd + 1);
      rest = rest.slice(objEnd + 1);

      let parsed: unknown;
      try {
        parsed = JSON.parse(objStr);
      } catch {
        continue;
      }
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        if (obj.type === 'final') {
          turns.push({ type: 'final', text: typeof obj.text === 'string' ? obj.text : '' });
          return turns;
        }
        if (obj.type === 'tool_call') {
          turns.push({
            type: 'tool_call',
            tool: typeof obj.tool === 'string' ? obj.tool : '',
            arguments: obj.arguments && typeof obj.arguments === 'object'
              ? (obj.arguments as Record<string, unknown>)
              : {},
          });
          continue;
        }
        if (typeof (obj as { text?: unknown }).text === 'string') {
          turns.push({ type: 'final', text: (obj as { text: string }).text });
          return turns;
        }
      }
    }

    if (turns.length === 0) {
      // не JSON — показываем исходный текст модели пользователю
      turns.push({ type: 'final', text: text.trim() });
    }
    return turns;
  }

  private toolMessage(tool: string, ok: boolean, content: string, link?: { url: string; label: string }): AgentMessage {
    return {
      role: 'tool',
      tool,
      toolOk: ok,
      content,
      link,
      created_at: new Date().toISOString(),
    };
  }

  /** Для LLM показываем и summary, и (компактно) data. */
  private summaryForLlm(summary: string, data?: unknown): string {
    if (data === undefined) return summary || '';
    let json = '';
    try {
      json = JSON.stringify(data);
      if (json.length > 30000) json = json.slice(0, 30000) + '\n…(обрезано)';
    } catch {
      json = String(data);
    }
    return `${summary}\nДанные: ${json}`;
  }
}
