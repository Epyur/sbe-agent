import type { AgentToolContext } from '../tools-registry';
import type { ToolCallResult } from '../../types/agent';
import { errorMessage } from '../../../../sbe-core/src/utils/errors';

const TASKS_CACHE_PATHS = ['yourbase/sbe_tasks/tasks_cache.json', 'yourbase/yougile_cache.json'];

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

/** Чтение локальной базы задач (кэш sbe-tasks, fallback — кэш монолита yougile_cache.json). */
export async function getTasks(
  ctx: AgentToolContext,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const query = String(args.query || '').trim();
    const project = String(args.project || '').trim();
    const completedOnly = args.completed === true;
    const limit = Number(args.limit) || 50;

    let raw: { tasks?: CachedTask[] } = {};
    let sourcePath = '';
    for (const path of TASKS_CACHE_PATHS) {
      try {
        const text = await ctx.readVaultText(path);
        raw = JSON.parse(text) as { tasks?: CachedTask[] };
        if (Array.isArray(raw.tasks) && raw.tasks.length > 0) {
          sourcePath = path;
          break;
        }
      } catch {
        // пробуем следующий файл
      }
    }
    if (!sourcePath) {
      return { ok: false, summary: '', error: 'Локальная база задач не найдена. Откройте плагин «Задачи» или монолит, чтобы сформировать кэш.' };
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

    // Агрегаты — чтобы агент мог отвечать на вопросы «сколько задач…» (как дашборд монолита).
    const byProject = new Map<string, number>();
    const byColumn = new Map<string, number>();
    let completed = 0;
    for (const t of filtered) {
      const p = String(t.projectTitle || 'Без проекта');
      byProject.set(p, (byProject.get(p) || 0) + 1);
      const c = String(t.columnTitle || 'Без колонки');
      byColumn.set(c, (byColumn.get(c) || 0) + 1);
      if (t.completed) completed++;
    }
    const sortCounts = (m: Map<string, number>): Array<{ key: string; count: number }> =>
      Array.from(m.entries())
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count);

    const picked = filtered.slice(0, Math.max(1, Math.min(limit || 50, 200))).map(t => ({
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
      summary: `Задачи (${sourcePath.split('/').pop()}): всего ${filtered.length}, показано ${picked.length}.`,
      data: {
        source: sourcePath,
        total: filtered.length,
        completed,
        open: filtered.length - completed,
        byProject: sortCounts(byProject),
        byColumn: sortCounts(byColumn),
        items: picked,
      },
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}
