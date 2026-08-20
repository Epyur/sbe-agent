import type { AgentToolContext } from '../tools-registry';
import type { ToolCallResult } from '../../types/agent';
import { errorMessage } from '../../../../sbe-core/src/utils/errors';

export interface LocalCacheDef {
  path: string;
  listKey: string;
  label: string;
}

export interface FieldDoc {
  name: string;
  desc: string;
}

export interface CacheSchema {
  name: string;
  label: string;
  path: string;
  listKey: string;
  fields: FieldDoc[];
}

/** Схема локальных кэшей вольта (yourbase/): пути, списки и смысл полей. */
export const LOCAL_CACHES: Record<string, LocalCacheDef> = {
  mailer: { path: 'yourbase/sbe_mailer/mail_data.json', listKey: 'emails', label: 'Письма (sbe-mailer)' },
  documents: { path: 'yourbase/sbe_documents/documents_data.json', listKey: 'documents', label: 'Документы (sbe-documents)' },
  requests: { path: 'yourbase/sbe_requests/requests_data.json', listKey: 'requests', label: 'Заявки на испытания (sbe-requests)' },
  contacts: { path: 'yourbase/sbe_contacts/contacts_data.json', listKey: 'contacts', label: 'Контакты (sbe-contacts)' },
  tasks: { path: 'yourbase/sbe_tasks/tasks_cache.json', listKey: 'tasks', label: 'Задачи (sbe-tasks)' },
  yougile: { path: 'yourbase/yougile_cache.json', listKey: 'tasks', label: 'Кэш монолита yougile-tntn (legacy)' },
};

/** Детальное описание полей каждого локального кэша (что хранится в атрибутах). */
export const CACHE_SCHEMAS: CacheSchema[] = [
  {
    name: 'mailer',
    label: 'Письма (sbe_mailer/mail_data.json)',
    path: 'yourbase/sbe_mailer/mail_data.json',
    listKey: 'emails',
    fields: [
      { name: 'id', desc: 'идентификатор письма' },
      { name: 'number', desc: 'исходящий номер письма (например «ТД/КФ/008», «01.02.531»)' },
      { name: 'subject', desc: 'тема письма' },
      { name: 'text', desc: 'ПОЛНЫЙ ТЕКСТ письма (содержание разъяснения) — читать для ответов о содержании' },
      { name: 'author', desc: 'автор письма' },
      { name: 'date', desc: 'дата письма' },
      { name: 'direction_id', desc: 'id направления' },
      { name: 'direction_name', desc: 'название направления (например «Кровли и фасады»)' },
      { name: 'images', desc: 'список вложений/изображений (URL)' },
      { name: 'mdFilePath', desc: 'путь к markdown-копии письма в вольте' },
      { name: 'sync_status', desc: 'local / synced' },
    ],
  },
  {
    name: 'documents',
    label: 'Документы (sbe_documents/documents_data.json)',
    path: 'yourbase/sbe_documents/documents_data.json',
    listKey: 'documents',
    fields: [
      { name: 'id', desc: 'идентификатор документа' },
      { name: 'title', desc: 'название документа' },
      { name: 'doc_type', desc: 'тип документа (свободный текст, например «Сертификат»)' },
      { name: 'curator_email', desc: 'куратор (email)' },
      { name: 'deadline', desc: 'срок действия (мс; 0 = нет)' },
      { name: 'file_key/file_name/file_size/file_url', desc: 'файл документа в S3 (file_url — приватный прямой адрес)' },
      { name: 'link_url/link_file_name', desc: 'внешняя ссылка (legacy kb.tn.ru/yougile)' },
      { name: 'parent_id', desc: 'связанный документ (0 = корневой)' },
      { name: 'completed', desc: 'завершён (true/false)' },
      { name: 'remarks', desc: 'замечания к документу' },
    ],
  },
  {
    name: 'requests',
    label: 'Заявки на испытания (sbe_requests/requests_data.json)',
    path: 'yourbase/sbe_requests/requests_data.json',
    listKey: 'requests',
    fields: [
      { name: 'id', desc: 'идентификатор заявки' },
      { name: 'number_seq/number_year', desc: 'номер {NNN}/{yyyy}' },
      { name: 'customer_number', desc: 'номер заявки заказчику' },
      { name: 'lab_number', desc: 'номер лаборатории' },
      { name: 'status', desc: 'статус: new / processing / completed' },
      { name: 'title', desc: 'название заявки' },
      { name: 'object_id', desc: 'объект исследования' },
      { name: 'project_id', desc: 'проект' },
      { name: 'group_id', desc: 'группа (видимость)' },
      { name: 'owner_email', desc: 'владелец' },
      { name: 'priority', desc: 'приоритет' },
      { name: 'test_purpose', desc: 'цель испытания' },
      { name: 'ekn', desc: 'код ЕКН' },
      { name: 'method_id', desc: 'метод испытания' },
      { name: 'lab_id', desc: 'лаборатория' },
      { name: 'external_id', desc: 'легаси-номер LPITrack (для миграции)' },
      { name: 'files', desc: 'файлы заявки' },
    ],
  },
  {
    name: 'contacts',
    label: 'Контакты (sbe_contacts/contacts_data.json)',
    path: 'yourbase/sbe_contacts/contacts_data.json',
    listKey: 'contacts',
    fields: [
      { name: 'id', desc: 'идентификатор контакта' },
      { name: 'name', desc: 'ФИО' },
      { name: 'phone', desc: 'телефон' },
      { name: 'email', desc: 'email' },
      { name: 'organization', desc: 'организация' },
      { name: 'position', desc: 'должность' },
      { name: 'org_type', desc: 'тип организации' },
      { name: 'notes', desc: 'примечание' },
      { name: 'curator_email', desc: 'куратор (последний редактор)' },
    ],
  },
  {
    name: 'tasks',
    label: 'Задачи (sbe_tasks/tasks_cache.json)',
    path: 'yourbase/sbe_tasks/tasks_cache.json',
    listKey: 'tasks',
    fields: [
      { name: 'id', desc: 'идентификатор задачи' },
      { name: 'title', desc: 'название задачи' },
      { name: 'description', desc: 'описание задачи' },
      { name: 'columnId/columnTitle', desc: 'колонка' },
      { name: 'boardId/boardTitle', desc: 'доска' },
      { name: 'projectId/projectTitle', desc: 'проект' },
      { name: 'completed', desc: 'завершена (true/false)' },
      { name: 'assigned', desc: 'исполнители (emails)' },
      { name: 'subtasks', desc: 'подзадачи' },
      { name: 'deadline', desc: 'дедлайн (мс; 0 = нет)' },
    ],
  },
  {
    name: 'yougile',
    label: 'Кэш монолита yougile-tntn (legacy, yougile_cache.json)',
    path: 'yourbase/yougile_cache.json',
    listKey: 'tasks',
    fields: [
      { name: 'tasks', desc: 'задачи (как в sbe_tasks) — description может содержать JSON: type contact/email/document' },
      { name: 'projects', desc: 'проекты' },
      { name: 'boards', desc: 'доски' },
      { name: 'columns', desc: 'колонки' },
    ],
  },
];

/** Читает локальный кэш по имени. Возвращает записи основного списка или null (нет кэша/ошибка). */
export async function readLocalList(
  ctx: AgentToolContext,
  cacheName: string,
): Promise<{ items: Record<string, unknown>[]; path: string } | null> {
  const def = LOCAL_CACHES[cacheName];
  if (!def) return null;
  try {
    const text = await ctx.readVaultText(def.path);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const items = Array.isArray(parsed[def.listKey]) ? parsed[def.listKey] : [];
    return { items: items as Record<string, unknown>[], path: def.path };
  } catch {
    return null;
  }
}

/** Текстовое представление полной схемы локальных кэшей (для системного промпта агента). */
export function cacheSchemaText(): string {
  const lines: string[] = [];
  for (const schema of CACHE_SCHEMAS) {
    lines.push(`**${schema.label}** — список в ключе «${schema.listKey}», поля:`);
    for (const f of schema.fields) {
      lines.push(`  - ${f.name}: ${f.desc}`);
    }
  }
  return lines.join('\n');
}

/** Краткая сводка (пути + какие тулы читают локально). */
export function cacheSchemaSummary(): string {
  const lines: string[] = [];
  for (const key of Object.keys(LOCAL_CACHES)) {
    const def = LOCAL_CACHES[key];
    lines.push(`- **${key}** (${def.label}): ${def.path}`);
  }
  return lines.join('\n');
}

/** Тул read_local_cache: читает любой локальный кэш, возвращает структуру и записи. */
export async function readLocalCache(
  ctx: AgentToolContext,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const cache = String(args.cache || '').trim();
  const query = String(args.query || '').trim();
  const limit = Number(args.limit) || 20;

  const def = LOCAL_CACHES[cache];
  if (!def) {
    return {
      ok: false,
      summary: '',
      error: `Неизвестный кэш «${cache}». Доступны: ${Object.keys(LOCAL_CACHES).join(', ')}`,
    };
  }

  try {
    const raw = await ctx.readVaultText(def.path);
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // структура: топ-уровневые ключи и количество записей в массивах
    const structure: string[] = [];
    for (const key of Object.keys(parsed)) {
      const v = parsed[key];
      if (Array.isArray(v)) {
        structure.push(`${key}[${v.length}]`);
      } else {
        structure.push(`${key}`);
      }
    }

    const items = Array.isArray(parsed[def.listKey]) ? (parsed[def.listKey] as Record<string, unknown>[]) : [];
    let filtered = items;
    if (query) {
      const q = query.toLowerCase();
      filtered = filtered.filter(i => Object.values(i).some(v => typeof v === 'string' && v.toLowerCase().includes(q)));
    }
    const picked = filtered.slice(0, Math.max(1, Math.min(limit, 200)));

    return {
      ok: true,
      summary: `Кэш «${cache}» (${def.path}): структура — ${structure.join(', ')}. Найдено ${filtered.length}, показано ${picked.length}.`,
      data: { cache, path: def.path, structure, total: filtered.length, items: picked },
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}
