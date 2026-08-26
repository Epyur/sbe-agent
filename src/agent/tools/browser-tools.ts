import type { AgentToolContext } from '../tools-registry';
import type { ToolCallResult } from '../../types/agent';
import { browserManager } from '../browser-manager';
import { errorMessage } from '../../../../sbe-core/src/utils/errors';

/** Ограничение на извлекаемый текст/ссылк, чтобы не перегружать контекст LLM. */
const EXTRACT_LIMIT = 30000;
const LINKS_LIMIT = 100;

/** Переход на URL (без подтверждения). */
export async function browserOpen(ctx: AgentToolContext, args: Record<string, unknown>): Promise<ToolCallResult> {
  const url = String(args.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, summary: '', error: 'Нужен полный URL (http/https).' };
  }
  try {
    await browserManager.open(url);
    return { ok: true, summary: `Открыт: ${url}`, data: { url } };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

/** Извлекает видимый текст страницы в контекст LLM (без подтверждения). */
export async function browserExtract(): Promise<ToolCallResult> {
  try {
    const text = await browserManager.extractText();
    const limited = text.slice(0, EXTRACT_LIMIT);
    return {
      ok: true,
      summary: `Содержимое страницы (${text.length} символов${text.length > limited.length ? ', показано начало' : ''}):\n${limited}`,
      data: { text: limited, total: text.length },
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

/** Собирает ссылки текущей страницы (без подтверждения). */
export async function browserLinks(): Promise<ToolCallResult> {
  try {
    const links = await browserManager.links();
    const limited = links.slice(0, LINKS_LIMIT);
    return {
      ok: true,
      summary: `Ссылки (${links.length}${links.length > limited.length ? `, показаны первые ${limited.length}` : ''}):\n` + limited.join('\n'),
      data: { links: limited },
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

/** Скриншот страницы в вольт (без подтверждения). */
export async function browserScreenshot(ctx: AgentToolContext): Promise<ToolCallResult> {
  try {
    const png = await browserManager.screenshot();
    const path = `yourbase/sbe_agent/screenshots/${Date.now()}.png`;
    const ab = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
    await ctx.writeVaultFile(path, ab);
    return { ok: true, summary: `Скриншот сохранён: ${path} (${png.byteLength} байт).`, data: { path } };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

/** Клик по элементу. sensitive=true — запросить подтверждение (скачивание/ввод
 *  логина/пароля/конфиденциальных данных). Поисковые формы/навигация — без. */
export async function browserClick(ctx: AgentToolContext, args: Record<string, unknown>): Promise<ToolCallResult> {
  const selector = String(args.selector || '').trim();
  if (!selector) {
    return { ok: false, summary: '', error: 'Требуется selector (CSS-селектор).' };
  }
  if (args.sensitive === true && ctx.confirmUser) {
    const ok = await ctx.confirmUser(`Агент хочет кликнуть по «${selector}» — действие может вести к скачиванию файла или вводу конфиденциальных данных. Продолжить?`);
    if (!ok) return { ok: false, summary: '', error: 'Действие отменено пользователем.' };
  }
  try {
    const clicked = await browserManager.execJs<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      (el as HTMLElement).click();
      return true;
    })()`);
    return { ok: true, summary: clicked ? `Клик по «${selector}» выполнен.` : `Элемент «${selector}» не найден.` };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

/** Ввод текста в поле. sensitive=true — подтверждение (пароли/конфиденциальное). */
export async function browserType(ctx: AgentToolContext, args: Record<string, unknown>): Promise<ToolCallResult> {
  const selector = String(args.selector || '').trim();
  const text = String(args.text ?? '');
  if (!selector) {
    return { ok: false, summary: '', error: 'Требуется selector (CSS-селектор).' };
  }
  if (args.sensitive === true && ctx.confirmUser) {
    const ok = await ctx.confirmUser(`Агент хочет ввести значение в «${selector}» — поле может содержать конфиденциальные данные. Продолжить?`);
    if (!ok) return { ok: false, summary: '', error: 'Действие отменено пользователем.' };
  }
  try {
    const typed = await browserManager.execJs<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const t = el as HTMLInputElement | HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(t), 'value')?.set;
      if (setter) setter.call(t, ${JSON.stringify(text)}); else t.value = ${JSON.stringify(text)};
      t.dispatchEvent(new Event('input', { bubbles: true }));
      t.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    return { ok: true, summary: typed ? `Введено значение в «${selector}».` : `Элемент «${selector}» не найден.` };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

/** Пауза: пользователь действует на странице (вход/капча), жмёт «Продолжить». */
export async function browserWait(): Promise<ToolCallResult> {
  try {
    await browserManager.waitForUser();
    return { ok: true, summary: `Пользователь продолжил. Текущая страница: ${browserManager.currentUrl || '—'}` };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}
