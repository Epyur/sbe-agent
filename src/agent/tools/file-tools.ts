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

    // Большие документы: управляемое усечение (начало + конец), чтобы текст
    // гарантированно помещался в контекст LLM. Полный текст — в исходном файле.
    const PARSE_TEXT_LIMIT = 24000;
    if (parsed.text && parsed.text.length > PARSE_TEXT_LIMIT) {
      const total = parsed.text.length;
      const head = PARSE_TEXT_LIMIT - 1000;
      const tail = 800;
      parsed.text =
        parsed.text.slice(0, head) +
        `\n…[текст сокращён для анализа: показано начало и конец из ${total} символов; полный текст — в исходном файле]…\n` +
        parsed.text.slice(-tail);
    }

    let summary = `Файл **${fileName}** разобран (${parsed.kind}).`;
    const textLen = parsed.text ? parsed.text.length : 0;
    summary += ` Символов текста: ${textLen}.`;
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
