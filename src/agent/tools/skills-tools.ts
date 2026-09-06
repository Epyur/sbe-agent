import type { AgentToolContext } from '../tools-registry';
import type { ToolCallResult } from '../../types/agent';
import { requestUrl } from 'obsidian';
import JSZip from 'jszip';
import { errorMessage } from '../../../../sbe-core/src/utils/errors';
import { listGlobalSkills, getGlobalSkill } from '../skills-service';

const SKILLS_ROOT = 'yourbase/sbe_agent/skills';

/** Лимиты распаковки (защита от zip-бомб): файл 25 МБ, суммарно 100 МБ, 2000 файлов. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 2000;

function parseRepoUrl(url: string): { owner: string; repo: string } {
  const clean = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const m = clean.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (m) return { owner: m[1], repo: m[2] };
  const m2 = clean.match(/^([^/]+)\/([^/]+)$/);
  if (m2) return { owner: m2[1], repo: m2[2] };
  throw new Error('Не распознан GitHub-репозиторий: ' + url);
}

/** Безопасный относительный путь записи ZIP: null, если путь выходит за пределы
 *  каталога установки или некорректен (zip-slip — ревью B6). */
function safeRelPath(raw: string): string | null {
  const norm = raw.replace(/\\/g, '/').trim();
  if (!norm || norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) return null;
  const parts = norm.split('/');
  for (const seg of parts) {
    if (seg === '' || seg === '.' || seg === '..' || seg.includes('\x00')) return null;
  }
  return norm;
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
  const skillPath = String(args.skill_path || '').trim().replace(/\\/g, '/');
  if (!repoUrl) {
    return { ok: false, summary: '', error: 'Требуется repo_url (например https://github.com/mattpocock/skills).' };
  }
  if (skillPath && (skillPath.startsWith('/') || /^[a-zA-Z]:/.test(skillPath) || skillPath.split('/').some(s => s === '' || s === '.' || s === '..'))) {
    return { ok: false, summary: '', error: `Некорректный skill_path: «${skillPath}».` };
  }
  try {
    const { owner, repo } = parseRepoUrl(repoUrl);

    // Блок B6 (supply-chain): глобальный скил = белый список (утверждён
    // администратором, источник — сервер). Если скил уже есть глобально —
    // не качаем с GitHub, а сообщаем, что он доступен через list_skills/read_skill.
    const targetName = (skillPath || repo).toLowerCase();
    const globals = await listGlobalSkills(ctx);
    const globalHit = globals.find(g => g.name.toLowerCase() === targetName);
    if (globalHit) {
      return {
        ok: true,
        summary: `Скил «${globalHit.name}» уже установлен ГЛОБАЛЬНО (источник — сервер, проверен администратором) и доступен: используй list_skills, затем read_skill. Скачивать с GitHub не нужно.`,
      };
    }

    // Вариант B: источник вне белого списка — обязательное подтверждение
    // пользователя с предупреждением о необходимости проверить безопасность.
    if (ctx.confirmUser) {
      const confirmed = await ctx.confirmUser(
        `Скил «${skillPath || repo}» из репозитория «${owner}/${repo}» не входит в список глобально установленных (источник не проверен администратором). Установить локально в вольт? Перед использованием рекомендуется проверить содержимое скила.`,
      );
      if (!confirmed) {
        return { ok: false, summary: '', error: 'Установка отменена пользователем: скил не входит в доверенный список.' };
      }
    }

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
  if (entries.length > MAX_FILES) {
    throw new Error(`В архиве слишком много файлов (${entries.length}, максимум ${MAX_FILES}).`);
  }
  let totalBytes = 0;
  for (const entry of entries) {
    const rel = safeRelPath(entry.slice(prefix.length));
    if (!rel) continue;
    const file = zip.files[entry];
    const data = await file.async('arraybuffer');
    totalBytes += data.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(`Суммарный размер архива превышает ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} МБ.`);
    }
    if (data.byteLength > MAX_FILE_BYTES) {
      throw new Error(`Файл «${rel}» слишком большой (максимум ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} МБ).`);
    }
    await ctx.writeVaultFile(`${targetDir}/${rel}`, data);
  }
}

/** Список установленных скилов (name/description из SKILL.md) — локальные + глобальные.
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
    const skills: Array<{ name: string; description: string; global?: boolean }> = [];
    for (const name of skillDirs) {
      try {
        const content = await ctx.readVaultText(`${SKILLS_ROOT}/${name}/SKILL.md`);
        skills.push({ name, description: parseSkillDescription(content) });
      } catch {
        // пропускаем битые скилы
      }
    }
    const globals = await listGlobalSkills(ctx);
    for (const g of globals) {
      if (!skills.some(s => s.name === g.name)) {
        skills.push({ name: g.name, description: g.description, global: true });
      }
    }
    if (skills.length === 0) {
      return { ok: true, summary: 'Скилов нет. Используйте add_skill, чтобы установить скил из GitHub-репозитория (или обратитесь к администратору за глобальным скилом).', data: [] };
    }
    const summary = `Скилы (${skills.length}):\n` +
      skills.map(s => `- ${s.global ? '🌐 ' : ''}**${s.name}**: ${s.description || '—'}`).join('\n') +
      (globals.length > 0 ? '\n\n🌐 — глобальные скилы (утверждены администратором, доступны с сервера).' : '');
    return { ok: true, summary, data: skills };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

/** Загружает SKILL.md скила в контекст агента (подключение по мере необходимости).
 *  Сначала ищет локально, затем — глобально (на сервере). */
export async function readSkill(ctx: AgentToolContext, args: Record<string, unknown>): Promise<ToolCallResult> {
  const name = String(args.name || '').trim();
  if (!name) {
    return { ok: false, summary: '', error: 'Требуется name (имя скила).' };
  }
  const safeName = name.replace(/[\\/:*?"<>|]/g, '_');
  try {
    // прямой путь или поиск по дереву (скилы из целых репозиториев могут лежать глубже)
    let mdPath = `${SKILLS_ROOT}/${safeName}/SKILL.md`;
    let local = false;
    if (await ctx.vaultExists(mdPath)) {
      local = true;
    } else {
      const all = await ctx.listVaultTree(SKILLS_ROOT);
      const found = all.find(f => new RegExp(`(^|/)${safeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/SKILL\\.md$`, 'i').test(f));
      if (found) {
        mdPath = found;
        local = true;
      }
    }
    if (local) {
      const content = await ctx.readVaultText(mdPath);
      const dir = mdPath.slice(0, mdPath.lastIndexOf('/'));
      const nested = (await ctx.listVaultTree(dir)).filter(f => !f.endsWith('/SKILL.md') && !f.endsWith('SKILL.md'));
      const files: Array<{ name: string; content: string }> = [];
      for (const f of nested) {
        try { files.push({ name: f.slice(dir.length + 1), content: await ctx.readVaultText(f) }); } catch { /* пропускаем бинарные/битые */ }
      }
      return {
        ok: true,
        summary: `Скил «${safeName}» загружен. Следуй его инструкциям.`,
        data: { name: safeName, skill_md: content, files },
      };
    }
    // глобальный скил (с сервера)
    const g = await getGlobalSkill(ctx, safeName);
    if (g) {
      return {
        ok: true,
        summary: `Глобальный скил «${g.name}» загружен. Следуй его инструкциям.`,
        data: { name: g.name, skill_md: g.content, files: g.files },
      };
    }
    return { ok: false, summary: '', error: `Скил «${safeName}» не найден ни локально, ни глобально. Сначала вызовите list_skills.` };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

/** Извлекает name/description из frontmatter SKILL.md. */
export function parseSkillDescription(content: string): string {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return '';
  const desc = m[1].match(/^\s*description:\s*"?([^"\n]+)"?\s*$/m);
  return desc ? desc[1].trim() : '';
}
