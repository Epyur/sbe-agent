import type { AgentToolContext } from '../tools-registry';
import type { ToolCallResult } from '../../types/agent';
import { errorMessage } from '../../../../sbe-core/src/utils/errors';

/** Папка правил агента в вольте (файлы *.md автозагружаются в контекст агента). */
export const RULES_DIR = 'yourbase/sbe_agent/rules';

function normalizePath(p: string): string {
  let clean = (p || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  clean = clean.replace(/\.\./g, '');
  if (clean && !clean.toLowerCase().endsWith('.md')) {
    clean += '.md';
  }
  return clean;
}

/** Создаёт/обновляет файл правил (AGENTS.md или другой .md) по указанию пользователя. */
export async function saveRule(ctx: AgentToolContext, args: Record<string, unknown>): Promise<ToolCallResult> {
  const content = String(args.content || '').trim();
  if (!content) {
    return { ok: false, summary: '', error: 'Требуется content (текст правил).' };
  }
  const path = normalizePath(String(args.path || '').trim()) || `${RULES_DIR}/правила.md`;
  const append = args.append === true;

  try {
    let final = content;
    if (append) {
      try {
        if (await ctx.vaultExists(path)) {
          const existing = await ctx.readVaultText(path);
          final = existing.replace(/\s+$/, '') + '\n\n' + content;
        }
      } catch {
        // если файла нет — просто создаём
      }
    }
    await ctx.writeVaultFile(path, final);
    const inRules = path.startsWith(RULES_DIR);
    const note = inRules
      ? ' Файл в папке правил — правила будут автоматически применяться агентом.'
      : ' Для автоприменения поместите файл в yourbase/sbe_agent/rules/ или укажите его агенту через read_rule.';
    return { ok: true, summary: `Файл правил сохранён: ${path}.${note}`, data: { path } };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

/** Список файлов правил (из папки правил агента). */
export async function listRules(ctx: AgentToolContext): Promise<ToolCallResult> {
  try {
    const files = await ctx.listVaultDir(RULES_DIR);
    const md = files.filter(f => f.endsWith('.md')).sort();
    if (md.length === 0) {
      return { ok: true, summary: 'Файлов правил нет. Создайте через save_rule (например, попросите агента сохранить правила в AGENTS.md).', data: [] };
    }
    const list: Array<{ path: string; summary: string }> = [];
    for (const f of md) {
      let summary = '';
      try {
        const content = await ctx.readVaultText(f);
        summary = content.split('\n').find(l => l.trim() && !l.trim().startsWith('#')) || '';
        summary = summary.trim().slice(0, 100);
      } catch {
        // игнорируем битые
      }
      list.push({ path: f, summary });
    }
    return {
      ok: true,
      summary: `Файлы правил (${md.length}):\n` + list.map(r => `- **${r.path}**: ${r.summary || '—'}`).join('\n'),
      data: list,
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

/** Читает файл правил (или любой .md) в контекст агента. */
export async function readRule(ctx: AgentToolContext, args: Record<string, unknown>): Promise<ToolCallResult> {
  const path = normalizePath(String(args.path || '').trim());
  if (!path) {
    return { ok: false, summary: '', error: 'Требуется path (например AGENTS.md или yourbase/sbe_agent/rules/менеджмент.md).' };
  }
  try {
    if (!(await ctx.vaultExists(path))) {
      return { ok: false, summary: '', error: `Файл не найден: ${path}` };
    }
    const content = await ctx.readVaultText(path);
    return { ok: true, summary: `Содержимое ${path}:`, data: { path, content } };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

/** Автозагрузка всех правил из папки правил для системного промпта. */
export async function loadAllRules(ctx: AgentToolContext): Promise<string> {
  try {
    const files = await ctx.listVaultDir(RULES_DIR);
    const md = files.filter(f => f.endsWith('.md')).sort();
    if (md.length === 0) return '';
    const parts: string[] = [];
    for (const f of md) {
      try {
        const content = await ctx.readVaultText(f);
        const trimmed = content.trim();
        if (trimmed) parts.push(`### ${f}\n${trimmed}`);
      } catch {
        // игнорируем непрочитанные
      }
    }
    return parts.join('\n\n');
  } catch (e: unknown) {
    console.warn('LogicTEAM.007: не удалось загрузить правила:', errorMessage(e));
    return '';
  }
}
