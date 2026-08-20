import type { AgentToolContext } from '../tools-registry';
import type { ToolCallResult } from '../../types/agent';
import { request, assertOk } from '../http';
import { readLocalList } from './local-cache';
import { errorMessage } from '../../../../sbe-core/src/utils/errors';

/** Общий pull из plugin-service + фильтр по строке + limit (fallback, если нет локального кэша). */
async function pullItems(
  ctx: AgentToolContext,
  appId: 'mailer' | 'documents' | 'lab',
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

export async function getEmails(
  ctx: AgentToolContext,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const query = String(args.query || '').trim();
    const limit = Number(args.limit) || 20;
    const direction = String(args.direction || '').trim();

    let source = 'server';
    let items: Record<string, unknown>[] | null = null;
    const local = await readLocalList(ctx, 'mailer');
    if (local) {
      source = 'local';
      items = local.items;
    } else {
      items = await pullItems(ctx, 'mailer', 'emails');
    }

    if (direction) {
      items = items.filter(i => str(i.direction_name).toLowerCase().includes(direction.toLowerCase()));
    }
    items = items.filter(i => matchesQuery(i, query));

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
      summary: `Письма (источник: ${source}, ${local ? local.path : 'сервер'}): найдено ${items.length}, показано ${picked.length}.`,
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

    let source = 'server';
    let items: Record<string, unknown>[] | null = null;
    const local = await readLocalList(ctx, 'documents');
    if (local) {
      source = 'local';
      items = local.items;
    } else {
      items = await pullItems(ctx, 'documents', 'documents');
    }

    items = items.filter(i => matchesQuery(i, query));
    const picked = limitItems(items, limit).map(i => ({
      id: i.id,
      title: i.title,
      doc_type: i.doc_type,
      curator_email: i.curator_email,
      deadline: i.deadline,
      file_name: i.file_name,
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

export async function getLimsRequests(
  ctx: AgentToolContext,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const status = String(args.status || '').trim();
    const limit = Number(args.limit) || 20;

    let source = 'server';
    let items: Record<string, unknown>[] | null = null;
    const local = await readLocalList(ctx, 'requests');
    if (local) {
      source = 'local';
      items = local.items;
    } else {
      items = await pullItems(ctx, 'lab', 'requests');
    }

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
      summary: `Заявки ЛИМС (источник: ${source}): найдено ${items.length}, показано ${picked.length}.`,
      data: { source, total: items.length, items: picked },
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}
