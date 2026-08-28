import type { AgentToolContext } from '../tools-registry';
import type { ToolCallResult } from '../../types/agent';
import { generateFile } from './file-tools';
import { errorMessage } from '../../../../sbe-core/src/utils/errors';

/**
 * Накопление записей постраничной выгрузки (2026-08-27): агент собирает данные
 * с внешнего сайта/API (например DataTables) постранично и сохраняет КАЖДУЮ
 * страницу в файл вольта (JSONL), а не держит превью в контексте LLM. В конце
 * build_xlsx_from_vault собирает Excel из файла — данные не проходят через контекст.
 */

/** Папка накопления записей в вольте. */
export const RECORDS_ROOT = 'yourbase/sbe_agent';

/** Нормализация пути накопления: только внутри yourbase/sbe_agent/, без «..», .jsonl. */
export function normalizeRecordsPath(p: string): string {
  let clean = (p || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  clean = clean.replace(/\.\./g, '');
  if (!clean) throw new Error('Требуется path (путь в вольте).');
  if (!clean.startsWith(RECORDS_ROOT + '/')) {
    throw new Error(`Путь должен быть внутри ${RECORDS_ROOT}/, например ${RECORDS_ROOT}/nsopb_reestr/nsopb.jsonl.`);
  }
  if (!/\.jsonl$/i.test(clean)) clean += '.jsonl';
  return clean;
}

/** Чтение JSONL-файла накопления (битые строки пропускаются). */
export async function readJsonl(ctx: AgentToolContext, path: string): Promise<unknown[]> {
  if (!(await ctx.vaultExists(path))) return [];
  const text = await ctx.readVaultText(path);
  const out: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // пропускаем битую строку
    }
  }
  return out;
}

/** Добавить записи в JSONL-файл вольта (перезапись если existing=false). Возвращает всего записей.
 *  Дедупликация: повторные страницы (например повторный запрос после таймаута) не добавляются дважды. */
export async function appendRecordsJsonl(ctx: AgentToolContext, path: string, records: unknown[], overwrite = false): Promise<number> {
  let all: unknown[] = [];
  if (!overwrite) all = await readJsonl(ctx, path);
  const existing = new Set(all.map(r => JSON.stringify(r)));
  const added = records.filter((r) => {
    const key = JSON.stringify(r);
    if (existing.has(key)) return false;
    existing.add(key);
    return true;
  });
  all.push(...added);
  const content = all.map(r => JSON.stringify(r)).join('\n') + '\n';
  await ctx.writeVaultFile(path, content);
  return all.length;
}

/** Сохранить (накопить) записи страницы в JSONL-файл вольта. */
export async function saveRecordsToVault(ctx: AgentToolContext, args: Record<string, unknown>): Promise<ToolCallResult> {
  let path: string;
  try {
    path = normalizeRecordsPath(String(args.path || ''));
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
  const records = args.records;
  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, summary: '', error: 'Требуется records — массив записей этой страницы (объекты или строки-массивы из data ответа).' };
  }
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!(Array.isArray(r) || (typeof r === 'object' && r !== null))) {
      return { ok: false, summary: '', error: `Запись ${i} — не объект и не массив. Передавайте records как массив объектов или массив строк-массивов.` };
    }
  }
  const mode = args.mode === 'overwrite' ? 'overwrite' : 'append';

  try {
    const before = await readJsonl(ctx, path);
    const total = await appendRecordsJsonl(ctx, path, records, mode === 'overwrite');
    return {
      ok: true,
      summary: `Сохранено ${records.length} записей (${mode}) в ${path}. Всего в файле: ${total}.`,
      data: { path, mode, added: total - before.length, total },
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

/** Очистка текста ячеек от HTML-рудиментов (2026-08-27): теги <br>/<a>/<i>/<p>…,
 *  HTML-сущности (&quot; &amp; &nbsp; …) → символы. Источники (реестры, DataTables)
 *  возвращают текст с вёрсткой — в Excel он должен быть чистым. */
function cleanCellText(v: string): string {
  return v
    // <br>/<br/> → перенос строки
    .replace(/<br\s*\/?>/gi, '\n')
    // закрывающие блочные теги → перенос строки (читаемость)
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    // остальные HTML-теги (с атрибутами) — убираем, содержимое сохраняем
    .replace(/<\/?[a-z][a-z0-9]*[^>]*>/gi, '')
    // HTML-сущности → символы (&amp; декодируем последним — он мог экранировать другие)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    // лишние пустые строки → не более двух подряд
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** Значение ячейки для Excel (строки/числа; строки чистятся от HTML; сложные — сериализуются). */
function cellValue(v: unknown): string | number {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return cleanCellText(v);
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 'да' : 'нет';
  try {
    return cleanCellText(JSON.stringify(v));
  } catch {
    return String(v);
  }
}

/** Собрать Excel из накопленного JSONL-файла (без передачи данных через контекст LLM). */
export async function buildXlsxFromVault(ctx: AgentToolContext, args: Record<string, unknown>): Promise<ToolCallResult> {
  let path: string;
  try {
    path = normalizeRecordsPath(String(args.path || ''));
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }

  try {
    const records = await readJsonl(ctx, path);
    if (records.length === 0) {
      return { ok: false, summary: '', error: `В файле ${path} нет записей.` };
    }

    const explicitHeaders = Array.isArray(args.headers)
      ? (args.headers as unknown[]).map(h => String(h)).filter(h => h.trim())
      : [];

    let headers: string[];
    let rows: unknown[][];
    if (Array.isArray(records[0])) {
      // Записи — массивы (например data из DataTables): колонки по числу элементов.
      const n = records[0].length;
      headers = explicitHeaders.length === n ? explicitHeaders : Array.from({ length: n }, (_, i) => `Колонка ${i + 1}`);
      rows = records.map(r => (r as unknown[]).map(v => cellValue(v)));
    } else {
      // Записи — объекты: колонки = объединение ключей.
      const keys: string[] = [];
      for (const rec of records) {
        if (typeof rec !== 'object' || rec === null) continue;
        for (const k of Object.keys(rec as Record<string, unknown>)) {
          if (!keys.includes(k)) keys.push(k);
        }
      }
      headers = explicitHeaders.length > 0 ? explicitHeaders.filter(k => keys.includes(k)) : keys;
      rows = records.map((rec) => {
        const o = (typeof rec === 'object' && rec !== null) ? (rec as Record<string, unknown>) : {};
        return headers.map(h => cellValue(o[h]));
      });
    }
    if (headers.length === 0) {
      return { ok: false, summary: '', error: `Не удалось определить колонки записей в ${path}.` };
    }

    const sheetName = String(args.sheet_name || 'Данные').trim().slice(0, 31) || 'Данные';
    const title = String(args.file_name || '').trim() || 'records';
    const spec: Record<string, unknown> = {
      title,
      sheets: [{
        name: sheetName,
        headers,
        rows,
        auto_filter: !!args.auto_filter,
        freeze_header: !!args.freeze_header,
        wrap: !!args.wrap,
      }],
    };
    return generateFile(ctx, 'xlsx', spec, 'Excel');
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}
