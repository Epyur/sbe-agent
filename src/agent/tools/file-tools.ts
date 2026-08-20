import type { AgentToolContext } from '../tools-registry';
import type { ToolCallResult } from '../../types/agent';
import { request, assertOk, buildMultipart } from '../http';
import { errorMessage } from '../../../../sbe-core/src/utils/errors';

/** Генерация файла через agent-service → S3 → ссылка на скачивание. */
export async function generateFile(
  ctx: AgentToolContext,
  format: 'docx' | 'xlsx' | 'pdf' | 'json',
  spec: Record<string, unknown>,
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
    const data = JSON.parse(res.text) as { url: string; expires_at: string; file_name: string };
    const ext = format.toUpperCase();
    return {
      ok: true,
      summary: `Файл **${data.file_name}** (${ext}) сформирован. Скачивание доступно до ${new Date(data.expires_at).toLocaleString('ru-RU')}:\n${data.url}`,
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
    let summary = `Файл **${fileName}** разобран (${parsed.kind}).`;
    if (parsed.text) {
      const snippet = parsed.text.slice(0, 600);
      summary += `\n\n\`\`\`\n${snippet}${parsed.text.length > 600 ? '\n…' : ''}\n\`\`\``;
    }
    if (parsed.sheets) {
      summary += ` Листов: ${parsed.sheets.length}.`;
    }
    return { ok: true, summary, data: parsed };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}
