import type { AgentToolContext } from '../tools-registry';
import type { ToolCallResult } from '../../types/agent';
import { errorMessage } from '../../../../sbe-core/src/utils/errors';

const TASKS_CACHE_PATH = 'yourbase/sbe_tasks/tasks_cache.json';

interface CachedTask {
  id: string;
  title?: string;
  description?: string;
  columnTitle?: string;
  projectTitle?: string;
  completed?: boolean;
  assigned?: string[];
  deadline?: number;
  subtasks?: Array<{ id: string; title?: string }>;
}

/** Чтение локальной базы задач (кэш sbe-tasks). Всегда доступно. */
export async function getTasks(
  ctx: AgentToolContext,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const query = String(args.query || '').trim();
    const project = String(args.project || '').trim();
    const completedOnly = args.completed === true;
    const limit = Number(args.limit) || 10;

    let raw: { tasks?: CachedTask[] };
    try {
      const text = await ctx.readVaultText(TASKS_CACHE_PATH);
      raw = JSON.parse(text) as { tasks?: CachedTask[] };
    } catch {
      return { ok: false, summary: '', error: 'Локальная база задач не найдена. Откройте плагин «Задачи», чтобы сформировать кэш.' };
    }
    const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
    const q = query.toLowerCase();

    let filtered = tasks.filter(t => {
      if (project) {
        const pt = String(t.projectTitle || '');
        if (!pt.toLowerCase().includes(project.toLowerCase())) return false;
      }
      if (completedOnly && !t.completed) return false;
      if (query) {
        const hay = `${t.title || ''} ${t.description || ''} ${t.columnTitle || ''} ${(t.assigned || []).join(' ')}`;
        if (!hay.toLowerCase().includes(q)) return false;
      }
      return true;
    });

    filtered = filtered.slice(0, Math.max(1, Math.min(limit || 10, 50)));
    const picked = filtered.map(t => ({
      id: t.id,
      title: t.title,
      columnTitle: t.columnTitle,
      projectTitle: t.projectTitle,
      completed: !!t.completed,
      assigned: t.assigned || [],
      deadline: t.deadline || 0,
      subtasks: (t.subtasks || []).length,
    }));

    return {
      ok: true,
      summary: `Задачи: найдено ${filtered.length}, показано ${picked.length}.`,
      data: picked,
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}
