import type { AgentToolContext } from '../tools-registry';
import type { ToolCallResult } from '../../types/agent';
import { request, assertOk } from '../http';
import { errorMessage } from '../../../../sbe-core/src/utils/errors';

interface EmailItem {
  id: number;
  number?: string;
  topic?: string;
  text?: string;
  author?: string;
  direction_name?: string;
  created_at?: string;
  updated_at?: string;
}

interface DocItem {
  id: number;
  title?: string;
  doc_type?: string;
  curator_email?: string;
  completed?: boolean;
  updated_at?: string;
}

interface LimsRequestItem {
  id: number;
  customer_number?: string;
  lab_number?: string;
  status?: string;
  updated_at?: string;
}

/** Общий pull из plugin-service + фильтр по строке + limit. */
async function pullItems(
  ctx: AgentToolContext,
  appId: 'mailer' | 'documents' | 'lab',
  listKey: string,
  filterKeys: string[],
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

function matchesQuery(item: Record<string, unknown>, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return Object.entries(item).some(([k, v]) => {
    if (typeof v !== 'string') return false;
    return k !== 'text' && v.toLowerCase().includes(q);
  });
}

function limitItems(items: Record<string, unknown>[], limit: number): Record<string, unknown>[] {
  return items.slice(0, Math.max(1, Math.min(limit || 10, 50)));
}

export async function getEmails(
  ctx: AgentToolContext,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const query = String(args.query || '').trim();
    const limit = Number(args.limit) || 10;
    const direction = String(args.direction || '').trim();
    let items = await pullItems(ctx, 'mailer', 'emails', []);
    if (direction) {
      items = items.filter(i => {
        const name = String(i.direction_name || '');
        const num = String(i.direction_id || '');
        return name.toLowerCase().includes(direction.toLowerCase()) || num === direction;
      });
    }
    items = items.filter(i => matchesQuery(i, query));
    const picked = limitItems(items, limit).map(i => ({
      id: i.id,
      number: i.number,
      topic: i.topic,
      author: i.author,
      direction_name: i.direction_name,
      created_at: i.created_at,
    }));
    return {
      ok: true,
      summary: `Письма: найдено ${items.length}, показано ${picked.length}.`,
      data: picked,
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
    const limit = Number(args.limit) || 10;
    let items = await pullItems(ctx, 'documents', 'documents', []);
    items = items.filter(i => matchesQuery(i, query));
    const picked = limitItems(items, limit).map(i => ({
      id: i.id,
      title: i.title,
      doc_type: i.doc_type,
      curator_email: i.curator_email,
      completed: i.completed,
      updated_at: i.updated_at,
    }));
    return {
      ok: true,
      summary: `Документы: найдено ${items.length}, показано ${picked.length}.`,
      data: picked,
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
    const limit = Number(args.limit) || 10;
    let items = await pullItems(ctx, 'lab', 'requests', []);
    if (status) {
      items = items.filter(i => String(i.status || '').toLowerCase() === status.toLowerCase());
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
      summary: `Заявки ЛИМС: найдено ${items.length}, показано ${picked.length}.`,
      data: picked,
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

export type { EmailItem, DocItem, LimsRequestItem };
