import type { AgentToolContext } from '../tools-registry';
import type { ToolCallResult } from '../../types/agent';
import { request, assertOk } from '../http';
import { readLocalList } from './local-cache';
import { errorMessage } from '../../../../sbe-core/src/utils/errors';

/** Общий pull из plugin-service + фильтр по строке + limit (fallback, если нет локального кэша). */
async function pullItems(
  ctx: AgentToolContext,
  appId: 'mailer' | 'documents' | 'lab' | 'contacts',
  listKey: string,
): Promise<Record<string, unknown>[]> {
  const token = await ctx.getToken(appId);
  const res = await request({
    url: `${ctx.getApiUrl()}/api/${appId}/sync/pull`,
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  }, 120000);
  assertOk(res, 'источник данных');
  const parsed = JSON.parse(res.text) as Record<string, unknown>;
  const items = Array.isArray(parsed[listKey]) ? parsed[listKey] : [];
  return items as Record<string, unknown>[];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function matchesQuery(item: Record<string, unknown>, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return Object.entries(item).some(([, v]) => typeof v === 'string' && v.toLowerCase().includes(q));
}

function limitItems(items: Record<string, unknown>[], limit: number): Record<string, unknown>[] {
  return items.slice(0, Math.max(1, Math.min(limit || 20, 200)));
}

function truncate(v: string, max: number): string {
  if (v.length <= max) return v;
  return v.slice(0, max) + '\n…';
}

/** Локальный кэш (для быстрого поиска) → БД (если локально ничего не нашлось или
 * кэша нет вовсе). Только для категорий, у которых ЕСТЬ локальный кэш и он может
 * реально пригодиться (документы/письма/контакты) — фотобанк и ЛИМС всегда идут
 * напрямую в БД, см. getPhotos/getLimsRequests. */
async function withServerFallback(
  ctx: AgentToolContext,
  cacheName: string,
  appId: 'mailer' | 'documents' | 'contacts',
  listKey: string,
  filter: (items: Record<string, unknown>[]) => Record<string, unknown>[],
): Promise<{ source: string; items: Record<string, unknown>[] }> {
  const local = await readLocalList(ctx, cacheName);
  if (local) {
    const filtered = filter(local.items);
    if (filtered.length > 0) {
      return { source: `local (${local.path})`, items: filtered };
    }
  }
  const serverItems = await pullItems(ctx, appId, listKey);
  return {
    source: local ? 'server (в локальном кэше ничего не нашлось)' : 'server',
    items: filter(serverItems),
  };
}

export async function getEmails(
  ctx: AgentToolContext,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const query = String(args.query || '').trim();
    const limit = Number(args.limit) || 20;
    const direction = String(args.direction || '').trim();

    const applyFilters = (list: Record<string, unknown>[]): Record<string, unknown>[] => {
      let out = list;
      if (direction) out = out.filter(i => str(i.direction_name).toLowerCase().includes(direction.toLowerCase()));
      return out.filter(i => matchesQuery(i, query));
    };

    const { source, items } = await withServerFallback(ctx, 'mailer', 'mailer', 'emails', applyFilters);

    const picked = limitItems(items, limit).map(i => ({
      id: i.id,
      number: i.number,
      topic: str(i.subject || i.topic),
      author: i.author,
      direction_name: i.direction_name,
      date: str(i.date || i.created_at),
      text: truncate(str(i.text), 3000),
    }));

    return {
      ok: true,
      summary: `Письма (источник: ${source}): найдено ${items.length}, показано ${picked.length}.`,
      data: { source, total: items.length, items: picked },
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

export async function getDocuments(
  ctx: AgentToolContext,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const query = String(args.query || '').trim();
    const limit = Number(args.limit) || 20;

    const { source, items } = await withServerFallback(
      ctx, 'documents', 'documents', 'documents',
      list => list.filter(i => matchesQuery(i, query)),
    );

    const picked = limitItems(items, limit).map(i => ({
      id: i.id,
      title: i.title,
      doc_type: i.doc_type,
      curator_email: i.curator_email,
      deadline: i.deadline,
      file_name: i.file_name,
      file_key: i.file_key,
      link_url: i.link_url,
      parent_id: i.parent_id,
      completed: i.completed,
      updated_at: i.updated_at,
    }));

    return {
      ok: true,
      summary: `Документы (источник: ${source}): найдено ${items.length}, показано ${picked.length}.`,
      data: { source, total: items.length, items: picked },
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

/** Временная ссылка на загруженный файл документа (presigned, действует ~7 дней) —
 * карточка может нести файл ДВУМЯ разными способами: внешняя ссылка (link_url) или
 * загруженный в систему файл (file_key, link_url тогда пусто) — без этого тула
 * второй случай выглядел как «файла нет», хотя он есть. */
export async function getDocumentLink(
  ctx: AgentToolContext,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const fileKey = String(args.file_key || '').trim();
    if (!fileKey) {
      return { ok: false, summary: '', error: 'Требуется поле file_key (из get_documents).' };
    }
    const token = await ctx.getToken('documents');
    const res = await request({
      url: `${ctx.getApiUrl()}/api/documents/file-link?key=${encodeURIComponent(fileKey)}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, 60000);
    assertOk(res, 'документы');
    const parsed = JSON.parse(res.text) as { url?: string };
    const url = parsed.url || '';
    if (!url) return { ok: false, summary: '', error: 'Сервер не вернул ссылку на файл.' };
    return {
      ok: true,
      summary: 'Ссылка на файл документа получена. Скажи пользователю, что файл можно открыть по ссылке (действует ~7 дней); НЕ вставляй длинный URL в текст ответа без необходимости.',
      data: { url },
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

export async function getContacts(
  ctx: AgentToolContext,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const query = String(args.query || '').trim();
    const limit = Number(args.limit) || 20;

    const { source, items } = await withServerFallback(
      ctx, 'contacts', 'contacts', 'contacts',
      list => list.filter(i => matchesQuery(i, query)),
    );

    const picked = limitItems(items, limit).map(i => ({
      id: i.id,
      name: i.name,
      phone: i.phone,
      email: i.email,
      organization: i.organization,
      position: i.position,
      org_type: i.org_type,
      notes: i.notes,
      curator_email: i.curator_email,
    }));

    return {
      ok: true,
      summary: `Контакты (источник: ${source}): найдено ${items.length}, показано ${picked.length}.`,
      data: { source, total: items.length, items: picked },
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

/** ЛИМС — всегда напрямую из БД (lab-service), без локального кэша: у пользователя
 * может не быть свежих данных локально (заявки правят несколько человек), а
 * статус — то, ради чего почти всегда и спрашивают. */
export async function getLimsRequests(
  ctx: AgentToolContext,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const status = String(args.status || '').trim();
    const limit = Number(args.limit) || 20;

    let items = await pullItems(ctx, 'lab', 'requests');

    if (status) {
      items = items.filter(i => str(i.status).toLowerCase() === status.toLowerCase());
    }
    const picked = limitItems(items, limit).map(i => ({
      id: i.id,
      customer_number: i.customer_number,
      lab_number: i.lab_number,
      status: i.status,
      updated_at: i.updated_at,
    }));

    return {
      ok: true,
      summary: `Заявки ЛИМС (источник: server): найдено ${items.length}, показано ${picked.length}.`,
      data: { source: 'server', total: items.length, items: picked },
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}
