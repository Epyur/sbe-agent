import type { AgentToolContext } from '../tools-registry';
import type { ToolCallResult } from '../../types/agent';
import { browserManager } from '../browser-manager';
import { request } from '../http';
import { errorMessage } from '../../../../sbe-core/src/utils/errors';

/** Ограничение на извлекаемый текст/ссылк, чтобы не перегружать контекст LLM. */
const EXTRACT_LIMIT = 30000;
const LINKS_LIMIT = 100;
/** Компактный лимит для fetch_url (HTML → сниппет, JSON → усечение). */
const FETCH_TEXT_LIMIT = 12000;

/** Компактное представление HTML для LLM: script-src (там ищут AJAX/DataTables),
 *  первые ссылки и текст. Сырой HTML не отдаём — иначе транскрипт раздувается и
 *  контекст LLM переполняется (400/502). */
function compactHtml(html: string): string {
  const scripts = Array.from(html.matchAll(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)).map(m => m[1]);
  const links = Array.from(html.matchAll(/<a[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)).map(m => m[1]).slice(0, 40);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
  const parts: string[] = [];
  if (scripts.length) {
    parts.push('SCRIPTS (подключаемые .js — загрузите их через fetch_url и ищите AJAX-эндпоинт, напр. DataTables ajax.url):\n' + scripts.join('\n'));
  }
  if (links.length) {
    parts.push('LINKS (первые 40):\n' + links.join('\n'));
  }
  if (text) {
    parts.push(`TEXT (${text.length} симв.):\n` + text.slice(0, 6000));
  }
  return parts.join('\n\n');
}

/** Скрытый серверный режим (fetch_url): HTTP-запрос через agent-service.
 *  Работает с обычными страницами и JSON/API-эндпоинтами (в т.ч. DataTables) —
 *  браузер для этого не нужен. */
export async function fetchUrl(ctx: AgentToolContext, args: Record<string, unknown>): Promise<ToolCallResult> {
  const url = String(args.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, summary: '', error: 'Нужен полный URL (http/https).' };
  }
  try {
    const token = await ctx.getToken('agent');
    const payload: Record<string, unknown> = {
      method: String(args.method || 'GET').toUpperCase(),
      url,
    };
    if (args.body !== undefined && args.body !== null) payload.body = String(args.body);
    if (args.headers && typeof args.headers === 'object') payload.headers = args.headers;
    if (typeof args.timeout_ms === 'number') payload.timeout_ms = args.timeout_ms;

    const res = await request({
      url: `${ctx.getApiUrl()}/api/agent/fetch`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    }, 120000);
    if (res.status === 401) return { ok: false, summary: '', error: 'Ключ доступа недействителен. Запросите новый ключ в ЦУП.' };
    if (res.status === 403) return { ok: false, summary: '', error: 'Нет прав доступа (агент).' };
    if (res.status !== 200) {
      let msg = `HTTP ${res.status}`;
      try { msg = (JSON.parse(res.text) as { error?: string }).error || msg; } catch { /* ignore */ }
      return { ok: false, summary: '', error: msg };
    }
    const data = JSON.parse(res.text) as { status: number; content_type: string; text: string };
    const text = data.text || '';
    const contentType = (data.content_type || '').split(';')[0].trim().toLowerCase();

    let view = '';
    let summary = '';
    let resultData: Record<string, unknown>;
    if (contentType.includes('json') || /^\s*[\[{]/.test(text)) {
      // JSON/API — отдаём LLM сам JSON (усечённо): из него извлекаются записи.
      view = text.slice(0, FETCH_TEXT_LIMIT);
      summary = `HTTP ${data.status} (${contentType}), ${text.length} симв. JSON:\n${view}`;
      resultData = { status: data.status, content_type: contentType, json: view, total: text.length };
    } else if (contentType.includes('html')) {
      // HTML — компактное представление (script-src/links/текст), без сырого HTML.
      view = compactHtml(text);
      summary = `HTTP ${data.status} (${contentType}), ${text.length} симв. HTML — компактное представление:\n${view}`;
      resultData = { status: data.status, content_type: contentType, compact: view, total: text.length };
    } else {
      view = text.slice(0, FETCH_TEXT_LIMIT);
      summary = `HTTP ${data.status} (${contentType}), ${text.length} симв.:\n${view}`;
      resultData = { status: data.status, content_type: contentType, text: view, total: text.length };
    }
    return { ok: true, summary, data: resultData };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

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
