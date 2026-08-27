import type { AgentToolContext } from '../tools-registry';
import type { ToolCallResult } from '../../types/agent';
import { browserManager } from '../browser-manager';
import { request } from '../http';
import { normalizeRecordsPath, appendRecordsJsonl } from './records-tools';
import { errorMessage } from '../../../../sbe-core/src/utils/errors';

/** Ограничение на извлекаемый текст/ссылк, чтобы не перегружать контекст LLM. */
const EXTRACT_LIMIT = 30000;
const LINKS_LIMIT = 100;
/** Компактный лимит для fetch_url (HTML → сниппет, JSON → усечение). */
const FETCH_TEXT_LIMIT = 12000;
/** Максимальная длина примера записи в представлении для LLM. */
const EXAMPLE_LIMIT = 600;

/** Число из recordsTotal/recordsFiltered (DataTables присылает число или строку). */
function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

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

interface JsonSummary {
  kind: 'table' | 'json' | 'truncated';
  /** Строки представления (компактные, для LLM и сообщения тула). */
  parts: string[];
  data: Record<string, unknown>;
  /** Сколько страниц ещё осталось (для табличного ответа). */
  remainingPages?: number;
  /** Полный массив записей страницы (для табличного ответа). */
  pageRecords?: unknown[];
}

/**
 * Компактное представление JSON для LLM (2026-08-27):
 *  - DataTables/табличные ответы ({data:[...]} или массив): извлекаем СЧЁТЧИКИ
 *    (recordsTotal/recordsFiltered/data.length) + 2–3 примера записей. Счётчики
 *    лежат в КОНЦЕ больших ответов — раньше модель их не видела и не знала,
 *    когда останавливать пагинацию.
 *  - полный массив records возвращается в data (для save_records_to_vault) ИЛИ
 *    сразу сохраняется тулом fetch_url в вольт (save_to) — см. fetchUrl.
 *  - обычный JSON — компактное превью как раньше.
 * Если JSON повреждён/обрезан (серверный лимит 1 МБ) — явно подсказываем
 * уменьшить length страницы до 50–100.
 */
function summarizeJson(text: string): JsonSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      kind: 'truncated',
      parts: ['JSON повреждён или обрезан (серверный лимит ответа 1 МБ). Уменьшите размер страницы: для DataTables используйте length=50–100 и запросите страницу заново.'],
      data: { json_truncated: true },
    };
  }

  const isTableLike =
    Array.isArray(parsed) ||
    (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).data));

  if (!isTableLike) {
    const json = JSON.stringify(parsed);
    const view = json.slice(0, FETCH_TEXT_LIMIT);
    return {
      kind: 'json',
      parts: [`JSON (${json.length} симв.):\n${view}${json.length > FETCH_TEXT_LIMIT ? '\n…(обрезано)' : ''}`],
      data: { json: view, total: json.length },
    };
  }

  let records: unknown[];
  let recordsTotal: number | undefined;
  let recordsFiltered: number | undefined;
  if (Array.isArray(parsed)) {
    records = parsed;
    recordsTotal = recordsFiltered = records.length;
  } else {
    const obj = parsed as Record<string, unknown>;
    records = Array.isArray(obj.data) ? (obj.data as unknown[]) : [];
    recordsTotal = toNumber(obj.recordsTotal);
    recordsFiltered = toNumber(obj.recordsFiltered);
  }
  const pageCount = records.length;
  const examples = records.slice(0, 3);

  const parts: string[] = ['DataTables/табличный JSON:'];
  if (recordsTotal !== undefined) parts.push(`recordsTotal (всего в базе): ${recordsTotal}`);
  if (recordsFiltered !== undefined) parts.push(`recordsFiltered (по фильтру): ${recordsFiltered}`);
  parts.push(`страница (data.length): ${pageCount}`);
  if (examples.length > 0) {
    parts.push('Пример записей (первые 3, усечены):\n' + examples.map((e, i) => {
      const s = JSON.stringify(e);
      return `${i + 1}) ${s.length > EXAMPLE_LIMIT ? s.slice(0, EXAMPLE_LIMIT) + '…' : s}`;
    }).join('\n'));
  }
  let remainingPages: number | undefined;
  if (recordsFiltered !== undefined && recordsFiltered > pageCount) {
    remainingPages = Math.ceil(recordsFiltered / Math.max(pageCount, 1));
  }
  return {
    kind: 'table',
    parts,
    data: { datatable: true, records_total: recordsTotal, records_filtered: recordsFiltered, page_records: pageCount, examples, records },
    remainingPages,
    pageRecords: records,
  };
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

    // save_to: накопление записей DataTables-ответа в файл вольта БЕЗ прогона
    // через контекст LLM (иначе большие записи ломают модель: она пытается их
    // перегнать в тул огромным JSON-выводом → 504/зависание).
    let saveTo = '';
    if (args.save_to && typeof args.save_to === 'string' && args.save_to.trim()) {
      try {
        saveTo = normalizeRecordsPath(args.save_to);
      } catch (e: unknown) {
        return { ok: false, summary: '', error: errorMessage(e) };
      }
    }

    let view = '';
    let summary = '';
    let resultData: Record<string, unknown>;
    if (contentType.includes('json') || /^\s*[\[{]/.test(text)) {
      // JSON/API — компактное представление для LLM: счётчики + примеры записей
      // (DataTables). С полным массивом records поступаем по-разному:
      //  - save_to задан → records сразу сохраняются в вольт, в контекст НЕ идут;
      //  - иначе → records в data (для save_records_to_vault), движок усечёт до 30К.
      const sum = summarizeJson(text);
      if (saveTo) {
        if (sum.kind !== 'table') {
          return { ok: false, summary: '', error: 'save_to применим только к табличным JSON-ответам (DataTables с массивом data). Этот ответ — не таблица.' };
        }
        const records = sum.pageRecords || [];
        const savedTotal = await appendRecordsJsonl(ctx, saveTo, records);
        const parts = [...sum.parts];
        parts.push(`Сохранено в вольт: ${saveTo} (записей этой страницы: ${records.length}, всего в файле: ${savedTotal}).`);
        if (sum.remainingPages !== undefined) {
          parts.push(`Осталось страниц: ${sum.remainingPages}. Продолжай пагинацию start += ${records.length}, пока не соберёшь recordsFiltered записей.`);
        }
        view = parts.join('\n');
        summary = `HTTP ${data.status} (${contentType}), ${text.length} симв. Записи сохранены в вольт.\n${view}`;
        // В контекст records НЕ отдаём (они уже в файле) — только счётчики и итог.
        resultData = {
          status: data.status,
          content_type: contentType,
          total: text.length,
          datatable: true,
          records_total: sum.data.records_total,
          records_filtered: sum.data.records_filtered,
          page_records: sum.data.page_records,
          saved_to: saveTo,
          saved_added: records.length,
          saved_total: savedTotal,
        };
      } else {
        view = sum.parts.join('\n')
          + (sum.remainingPages !== undefined
            ? `\nОсталось страниц: ${sum.remainingPages}. Сохрани records этой страницы в файл вольта (save_records_to_vault) и продолжай пагинацию start += ${sum.pageRecords?.length || 0} до recordsFiltered.`
            : '');
        summary = `HTTP ${data.status} (${contentType}), ${text.length} симв.\n${view}`;
        resultData = { status: data.status, content_type: contentType, total: text.length, ...sum.data };
      }
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
