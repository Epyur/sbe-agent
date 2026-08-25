import type { AgentToolContext } from '../tools-registry';
import type { ToolCallResult } from '../../types/agent';
import { requestUrl } from 'obsidian';
import JSZip from 'jszip';
import { errorMessage } from '../../../../sbe-core/src/utils/errors';

const SKILLS_ROOT = 'yourbase/sbe_agent/skills';

function parseRepoUrl(url: string): { owner: string; repo: string } {
  const clean = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const m = clean.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (m) return { owner: m[1], repo: m[2] };
  const m2 = clean.match(/^([^/]+)\/([^/]+)$/);
  if (m2) return { owner: m2[1], repo: m2[2] };
  throw new Error('Не распознан GitHub-репозиторий: ' + url);
}

async function downloadZip(ctx: AgentToolContext, owner: string, repo: string): Promise<ArrayBuffer> {
  for (const branch of ['main', 'master']) {
    const url = `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${branch}`;
    const res = await requestUrl({ url, method: 'GET', throw: false });
    if (res.status === 200 && res.arrayBuffer.byteLength > 1000) {
      return res.arrayBuffer;
    }
  }
  throw new Error(`Не удалось скачать репозиторий ${owner}/${repo}`);
}

/** Скачивает скил(ы) из GitHub-репозитория в вольт (аналог `npx skills add ... --skill X`). */
export async function addSkill(ctx: AgentToolContext, args: Record<string, unknown>): Promise<ToolCallResult> {
  const repoUrl = String(args.repo_url || '').trim();
  const skillPath = String(args.skill_path || '').trim();
  if (!repoUrl) {
    return { ok: false, summary: '', error: 'Требуется repo_url (например https://github.com/mattpocock/skills).' };
  }
  try {
    const { owner, repo } = parseRepoUrl(repoUrl);
    const zipBuffer = await downloadZip(ctx, owner, repo);
    const zip = await JSZip.loadAsync(zipBuffer);

    const root = Object.keys(zip.files)[0]?.split('/')[0] || '';

    if (skillPath) {
      // ищем папку скила: <root>/<skill> или <root>/skills/<skill>
      const candidates = [`${root}/${skillPath}`, `${root}/skills/${skillPath}`];
      const found = candidates.find(c => zip.files[`${c}/SKILL.md`] !== undefined);
      if (!found) {
        return { ok: false, summary: '', error: `Скил «${skillPath}» не найден в ${owner}/${repo}. Используйте list_skills/add_skill с корректным skill_path.` };
      }
      await extractFolder(zip, found, `${SKILLS_ROOT}/${skillPath}`, ctx);
      return { ok: true, summary: `Скил «${skillPath}» установлен из ${owner}/${repo} в yourbase/sbe_agent/skills/.` };
    }

    // весь репозиторий
    await extractFolder(zip, root, `${SKILLS_ROOT}/${repo}`, ctx);
    return { ok: true, summary: `Репозиторий ${owner}/${repo} установлен в yourbase/sbe_agent/skills/${repo}/.` };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

async function extractFolder(
  zip: JSZip,
  folderPath: string,
  targetDir: string,
  ctx: AgentToolContext,
): Promise<void> {
  const prefix = folderPath.endsWith('/') ? folderPath : folderPath + '/';
  const entries = Object.keys(zip.files).filter(k => k.startsWith(prefix) && !zip.files[k].dir);
  for (const entry of entries) {
    const rel = entry.slice(prefix.length);
    if (!rel) continue;
    const file = zip.files[entry];
    const data = await file.async('arraybuffer');
    await ctx.writeVaultFile(`${targetDir}/${rel}`, data);
  }
}

/** Список установленных скилов (name/description из SKILL.md).
 *  Ищет рекурсивно: скил может лежать и в подпапках (установка целым репозиторием). */
export async function listSkills(ctx: AgentToolContext): Promise<ToolCallResult> {
  try {
    const all = await ctx.listVaultTree(SKILLS_ROOT);
    const skillDirs = new Set<string>();
    for (const f of all) {
      if (!f.endsWith('/SKILL.md')) continue;
      const rest = f.slice(SKILLS_ROOT.length + 1);
      const name = rest.split('/')[0];
      if (name) skillDirs.add(name);
    }
    const skills: Array<{ name: string; description: string }> = [];
    for (const name of skillDirs) {
      try {
        const content = await ctx.readVaultText(`${SKILLS_ROOT}/${name}/SKILL.md`);
        skills.push({ name, description: parseSkillDescription(content) });
      } catch {
        // пропускаем битые скилы
      }
    }
    if (skills.length === 0) {
      return { ok: true, summary: 'Установленных скилов нет. Используйте add_skill, чтобы установить скил из GitHub-репозитория.', data: [] };
    }
    const summary = `Установленные скилы (${skills.length}):\n` + skills.map(s => `- **${s.name}**: ${s.description || '—'}`).join('\n');
    return { ok: true, summary, data: skills };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

/** Загружает SKILL.md скила в контекст агента (подключение по мере необходимости). */
export async function readSkill(ctx: AgentToolContext, args: Record<string, unknown>): Promise<ToolCallResult> {
  const name = String(args.name || '').trim();
  if (!name) {
    return { ok: false, summary: '', error: 'Требуется name (имя скила).' };
  }
  const safeName = name.replace(/[\\/:*?"<>|]/g, '_');
  try {
    // прямой путь или поиск по дереву (скилы из целых репозиториев могут лежать глубже)
    let mdPath = `${SKILLS_ROOT}/${safeName}/SKILL.md`;
    if (!(await ctx.vaultExists(mdPath))) {
      const all = await ctx.listVaultTree(SKILLS_ROOT);
      const found = all.find(f => new RegExp(`(^|/)${safeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/SKILL\\.md$`, 'i').test(f));
      if (!found) {
        return { ok: false, summary: '', error: `Скил «${safeName}» не установлен. Сначала вызовите add_skill или list_skills.` };
      }
      mdPath = found;
    }
    const content = await ctx.readVaultText(mdPath);
    const dir = mdPath.slice(0, mdPath.lastIndexOf('/'));
    const files = (await ctx.listVaultDir(dir)).filter(f => !f.endsWith('SKILL.md')).map(f => f.split('/').pop() || f);
    return {
      ok: true,
      summary: `Скил «${safeName}» загружен. Следуй его инструкциям.`,
      data: { name: safeName, skill_md: content, files },
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

/** Извлекает name/description из frontmatter SKILL.md. */
function parseSkillDescription(content: string): string {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return '';
  const desc = m[1].match(/^\s*description:\s*"?([^"\n]+)"?\s*$/m);
  return desc ? desc[1].trim() : '';
}
