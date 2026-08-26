import type { AgentToolContext } from '../tools-registry';
import type { ToolCallResult, FileGenerateResponse } from '../../types/agent';
import { request, assertOk, buildMultipart } from '../http';
import { errorMessage } from '../../../../sbe-core/src/utils/errors';

/** Генерация файла через agent-service → S3 → ссылка на скачивание.
 *  format: docx|xlsx|pdf|json|mermaid|png|html; label — человекочитаемое имя формата. */
export async function generateFile(
  ctx: AgentToolContext,
  format: string,
  spec: Record<string, unknown>,
  label: string,
): Promise<ToolCallResult> {
  try {
    const token = await ctx.getToken('agent');
    const res = await request({
      url: `${ctx.getApiUrl()}/api/agent/file/generate`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ format, spec }),
    }, 120000);
    assertOk(res, 'агент');
    const data = JSON.parse(res.text) as FileGenerateResponse;
    const until = new Date(data.expires_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    let summary = `Файл **${data.file_name}** (${label}) сформирован. Скачивание доступно до ${until}.`;
    if (data.extra) {
      if (data.extra.svg) summary += `\nSVG-версия: ${data.extra.svg}`;
      if (data.extra.mmd) summary += `\nИсходник mermaid (.mmd): ${data.extra.mmd}`;
    }
    return {
      ok: true,
      summary,
      link: { url: data.url, label: `⬇ Скачать файл ${label}` },
      data,
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

/** Разбор прикреплённого файла через agent-service. */
export async function parseFile(
  ctx: AgentToolContext,
  data: ArrayBuffer,
  fileName: string,
): Promise<ToolCallResult> {
  try {
    const token = await ctx.getToken('agent');
    const boundary = '----sbe-agent-' + Date.now().toString(36);
    const body = buildMultipart(data, fileName, boundary);
    const res = await request({
      url: `${ctx.getApiUrl()}/api/agent/file/parse`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    }, 120000);
    assertOk(res, 'агент');
    const parsed = JSON.parse(res.text) as {
      kind: string;
      text?: string;
      sheets?: Array<{ name: string; rows: unknown[][] }>;
      data?: unknown;
    };

    // Полнотекстовый анализ больших документов (2026-08-26): полный извлечённый
    // текст сохраняем в вольт (yourbase/sbe_agent/parsed/), в контекст кладём
    // управляемое усечение (начало), а путь/объём сообщаем — LLM читает остальное
    // тулом read_text_part (по частям, включая «продолжай» после перезапуска).
    const PARSE_TEXT_LIMIT = 24000;
    let fullPath = '';
    if (parsed.text && parsed.text.length > PARSE_TEXT_LIMIT) {
      const total = parsed.text.length;
      const safe = sanitizeParsedName(fileName);
      fullPath = `yourbase/sbe_agent/parsed/${safe}.txt`;
      await ctx.writeVaultFile(fullPath, parsed.text);
      const head = PARSE_TEXT_LIMIT - 1000;
      const tail = 800;
      parsed.text =
        parsed.text.slice(0, head) +
        `\n…[текст сокращён для анализа: показано начало и конец из ${total} символов; ПОЛНЫЙ текст сохранён: ${fullPath} — читай его частями через read_text_part(path, start)]…\n` +
        parsed.text.slice(-tail);
    }

    let summary = `Файл **${fileName}** разобран (${parsed.kind}).`;
    const textLen = parsed.text ? parsed.text.length : 0;
    summary += ` Символов текста: ${textLen}.`;
    if (fullPath) {
      summary += `\nДокумент большой — полный текст сохранён: ${fullPath}. Читай его частями: вызови read_text_part с path="${fullPath}" и start=0, затем повторяй с увеличивающимся start, пока не получишь «конец документа».`;
    }
    if (parsed.text) {
      const snippet = parsed.text.slice(0, 600);
      summary += `\n\n\`\`\`\n${snippet}${parsed.text.length > 600 ? '\n…' : ''}\n\`\`\``;
    }
    if (parsed.sheets) {
      summary += ` Листов: ${parsed.sheets.length}.`;
    }
    if (parsed.kind === 'json' && parsed.data !== undefined) {
      let jsonSnippet = '';
      try {
        jsonSnippet = JSON.stringify(parsed.data);
      } catch {
        jsonSnippet = String(parsed.data);
      }
      summary += `\n\n\`\`\`json\n${jsonSnippet.slice(0, 600)}${jsonSnippet.length > 600 ? '\n…' : ''}\n\`\`\``;
    }
    return { ok: true, summary, data: parsed };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

/** Безопасное имя файла для сохранённого текста (без путей и недопустимых символов). */
function sanitizeParsedName(fileName: string): string {
  const base = (fileName || 'file').replace(/\.[^.]+$/, '');
  const clean = base.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/_+/g, '_').slice(0, 80);
  return clean || 'document';
}

/** Чтение части сохранённого текста документа (полнотекстовый анализ). */
export async function readTextPart(ctx: AgentToolContext, args: Record<string, unknown>): Promise<ToolCallResult> {
  const path = String(args.path || '').trim();
  if (!path) {
    return { ok: false, summary: '', error: 'Требуется path (путь к сохранённому тексту из parse_file).' };
  }
  if (!path.startsWith('yourbase/sbe_agent/parsed/')) {
    return { ok: false, summary: '', error: 'Можно читать только файлы в yourbase/sbe_agent/parsed/.' };
  }
  const start = Math.max(0, Math.floor(Number(args.start) || 0));
  const length = Math.min(24000, Math.max(500, Math.floor(Number(args.length) || 24000)));
  try {
    if (!(await ctx.vaultExists(path))) {
      return { ok: false, summary: '', error: `Файл не найден: ${path}` };
    }
    const text = await ctx.readVaultText(path);
    if (start >= text.length) {
      return { ok: true, summary: 'Достигнут конец документа.' };
    }
    const end = Math.min(start + length, text.length);
    const slice = text.slice(start, end);
    const remaining = text.length - end;
    const tail = remaining > 0
      ? `\n…(осталось ${remaining} символов; вызови read_text_part с start=${end})`
      : '\n(конец документа)';
    return {
      ok: true,
      summary: `Символы ${start}–${end} из ${text.length}:\n\`\`\`\n${slice}\n\`\`\`${tail}`,
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}
