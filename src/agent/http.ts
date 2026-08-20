import { requestUrl, RequestUrlParam } from 'obsidian';

export interface HttpResponse {
  status: number;
  text: string;
}

/** requestUrl в Obsidian не имеет таймаута — обёртка с лимитом времени. */
export async function request(
  param: RequestUrlParam,
  timeoutMs = 60000,
): Promise<HttpResponse> {
  let timer: number | undefined;
  try {
    const response = await Promise.race([
      requestUrl({ ...param, throw: false }),
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(
          () => reject(new Error(`Сервер не ответил за ${Math.round(timeoutMs / 1000)} сек`)),
          timeoutMs,
        );
      }),
    ]);
    return { status: response.status, text: response.text };
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

export function assertOk(res: HttpResponse, appName: string): void {
  if (res.status === 401) throw new Error('Ключ доступа недействителен. Запросите новый ключ в ЦУП.');
  if (res.status === 403) throw new Error(`Нет прав доступа (${appName}). Обратитесь к администратору.`);
  if (res.status !== 200) {
    let errText = '';
    try {
      const parsed = JSON.parse(res.text) as { error?: string };
      errText = parsed.error || '';
    } catch {
      errText = '';
    }
    throw new Error(errText || `Сервер вернул HTTP ${res.status}`);
  }
}

/** Собирает multipart/form-data тело с одним файлом. */
export function buildMultipart(data: ArrayBuffer, fileName: string, boundary: string): ArrayBuffer {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  parts.push(new Uint8Array(data));
  parts.push(enc.encode(`\r\n--${boundary}--\r\n`));

  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out.buffer;
}
