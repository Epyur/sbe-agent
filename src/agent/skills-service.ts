import type { AgentToolContext } from './tools-registry';
import { request, assertOk } from './http';

/** Вспомогательный файл глобального скила (текстовый). */
export interface GlobalSkillFile {
  name: string;
  content: string;
}

/** Строка списка глобальных скилов. */
export interface GlobalSkillLite {
  name: string;
  description: string;
}

/** Полный глобальный скил (SKILL.md + файлы) с сервера. */
export interface GlobalSkill extends GlobalSkillLite {
  content: string;
  files: GlobalSkillFile[];
}

/** Список глобальных скилов (белый список, утверждённый администратором). */
export async function listGlobalSkills(ctx: AgentToolContext): Promise<GlobalSkillLite[]> {
  try {
    const token = await ctx.getToken('agent');
    const res = await request({
      url: `${ctx.getApiUrl()}/api/agent/skills`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, 30000);
    if (res.status === 403 || res.status === 401) return [];
    assertOk(res, 'Агент');
    return (JSON.parse(res.text) as { skills: GlobalSkillLite[] }).skills || [];
  } catch {
    return [];
  }
}

/** Полное содержимое глобального скила (null, если нет). */
export async function getGlobalSkill(ctx: AgentToolContext, name: string): Promise<GlobalSkill | null> {
  try {
    const token = await ctx.getToken('agent');
    const res = await request({
      url: `${ctx.getApiUrl()}/api/agent/skills/${encodeURIComponent(name)}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, 30000);
    if (res.status === 404) return null;
    if (res.status === 403 || res.status === 401) return null;
    assertOk(res, 'Агент');
    return JSON.parse(res.text) as GlobalSkill;
  } catch {
    return null;
  }
}
