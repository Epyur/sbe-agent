import type { AgentToolContext } from '../tools-registry';
import type { ToolCallResult } from '../../types/agent';
import { request, assertOk } from '../http';
import { errorMessage } from '../../../../sbe-core/src/utils/errors';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Поиск фотографий в фотобанке — всегда напрямую из БД (photo-service), без
 * локального кэша: у разных пользователей разная видимость папок/файлов, а
 * локальный кэш метаданных синхронизируется только внутри Obsidian-плагина
 * «Фотобанк» на этом устройстве и может не совпадать с тем, что реально в БД. */
export async function getPhotos(
  ctx: AgentToolContext,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const query = String(args.query || '').trim();
    const kind = String(args.kind || '').trim();
    const limit = Number(args.limit) || 20;

    const token = await ctx.getToken('photo');
    const res = await request({
      url: `${ctx.getApiUrl()}/api/photo/sync/pull`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, 120000);
    assertOk(res, 'фотобанк');
    const parsed = JSON.parse(res.text) as Record<string, unknown>;
    let items: Record<string, unknown>[] = Array.isArray(parsed.photos) ? parsed.photos : [];

    if (kind) {
      items = items.filter(i => str(i.kind).toLowerCase() === kind.toLowerCase());
    }
    if (query) {
      const q = query.toLowerCase();
      items = items.filter(i => Object.entries(i).some(([k, v]) => {
        if (k === 'custom') return false;
        return typeof v === 'string' && v.toLowerCase().includes(q);
      }) || (Array.isArray(i.tags) && i.tags.some((t: unknown) => typeof t === 'string' && t.toLowerCase().includes(q))));
    }

    const picked = items.slice(0, Math.max(1, Math.min(limit, 200))).map(i => ({
      id: i.id,
      title: i.title,
      description: str(i.description),
      tags: i.tags,
      folder_id: i.folder_id,
      folder_name: i.folder_name,
      kind: i.kind,
      file_key: i.file_key,
      file_name: i.file_name,
      mime_type: i.mime_type,
      width: i.width,
      height: i.height,
      location: i.location,
      author_email: i.author_email,
      created_at: i.created_at,
    }));

    return {
      ok: true,
      summary: `Фотобанк (источник: server): найдено ${items.length}, показано ${picked.length}.`,
      data: { source: 'server', total: items.length, items: picked },
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

/** Временная публичная ссылка на файл фотобанка (presigned, действует ~7 дней). */
export async function getPhotoLink(
  ctx: AgentToolContext,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const fileKey = String(args.file_key || '').trim();
    if (!fileKey) {
      return { ok: false, summary: '', error: 'Требуется поле file_key (из get_photos).' };
    }
    const token = await ctx.getToken('photo');
    const res = await request({
      url: `${ctx.getApiUrl()}/api/photo/file-link?key=${encodeURIComponent(fileKey)}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, 60000);
    assertOk(res, 'фотобанк');
    const parsed = JSON.parse(res.text) as { url?: string };
    const url = parsed.url || '';
    if (!url) return { ok: false, summary: '', error: 'Сервер не вернул ссылку на файл.' };
    return {
      ok: true,
      summary: 'Ссылка на файл получена. Скажи пользователю, что фото можно открыть по ссылке (действует ~7 дней); НЕ вставляй длинный URL в текст ответа без необходимости.',
      data: { url },
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}
