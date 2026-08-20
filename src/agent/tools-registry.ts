import type { AgentToolSchema, ToolCallResult, SourceAvailability } from '../types/agent';
import { generateFile, parseFile } from './tools/file-tools';
import { getEmails, getDocuments, getLimsRequests } from './tools/database-tools';
import { getTasks } from './tools/tasks-tool';

/** Контекст исполнения тулов (предоставляет плагин). */
export interface AgentToolContext {
  getApiUrl: () => string;
  getToken: (appId: string) => Promise<string>;
  getEmail: () => string;
  getUserName: () => string;
  getSources: () => SourceAvailability[];
  readVaultText: (path: string) => Promise<string>;
}

export interface AgentAttachment {
  name: string;
  data: ArrayBuffer;
}

export interface AgentTool {
  schema: AgentToolSchema;
  execute: (
    ctx: AgentToolContext,
    args: Record<string, unknown>,
    attachment: AgentAttachment | null,
  ) => Promise<ToolCallResult>;
}

const sectionsSchema = {
  type: 'array' as const,
  items: {
    type: 'object' as const,
    properties: {
      heading: { type: 'string' },
      paragraphs: { type: 'array', items: { type: 'string' } },
      table: {
        type: 'object',
        properties: {
          headers: { type: 'array', items: { type: 'string' } },
          rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        },
      },
    },
  },
};

export function createTools(): AgentTool[] {
  const tools: AgentTool[] = [
    {
      schema: {
        name: 'create_docx',
        description: 'Сформировать документ Word (.docx): заголовок, разделы (абзацы и таблицы). Файл создаётся на сервере, возвращается ссылка на скачивание (действует ~2 дня).',
        input_schema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Заголовок документа' },
            sections: sectionsSchema,
          },
          required: ['title', 'sections'],
        },
      },
      execute: async (ctx, args) => {
        if (!args.title || !args.sections) {
          return { ok: false, summary: '', error: 'Требуются поля title и sections.' };
        }
        return generateFile(ctx, 'docx', args as Record<string, unknown>);
      },
    },
    {
      schema: {
        name: 'create_xlsx',
        description: 'Сформировать таблицу Excel (.xlsx): листы с заголовками и строками. Возвращается ссылка на скачивание (~2 дня).',
        input_schema: {
          type: 'object',
          properties: {
            sheets: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  headers: { type: 'array', items: { type: 'string' } },
                  rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
                },
              },
            },
          },
          required: ['sheets'],
        },
      },
      execute: async (ctx, args) => {
        if (!args.sheets) {
          return { ok: false, summary: '', error: 'Требуется поле sheets.' };
        }
        return generateFile(ctx, 'xlsx', args as Record<string, unknown>);
      },
    },
    {
      schema: {
        name: 'create_pdf',
        description: 'Сформировать электронный PDF: заголовок и разделы (абзацы, таблицы). Возвращается ссылка на скачивание (~2 дня).',
        input_schema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            sections: sectionsSchema,
          },
          required: ['title', 'sections'],
        },
      },
      execute: async (ctx, args) => {
        if (!args.title || !args.sections) {
          return { ok: false, summary: '', error: 'Требуются поля title и sections.' };
        }
        return generateFile(ctx, 'pdf', args as Record<string, unknown>);
      },
    },
    {
      schema: {
        name: 'create_json',
        description: 'Сформировать JSON-файл с данными. Возвращается ссылка на скачивание (~2 дня).',
        input_schema: {
          type: 'object',
          properties: {
            data: { type: 'object', description: 'Данные для JSON-файла' },
          },
          required: ['data'],
        },
      },
      execute: async (ctx, args) => {
        if (args.data === undefined || args.data === null) {
          return { ok: false, summary: '', error: 'Требуется поле data.' };
        }
        return generateFile(ctx, 'json', { data: args.data });
      },
    },
    {
      schema: {
        name: 'parse_file',
        description: 'Прочитать прикреплённый пользователем файл (docx/xlsx/pdf/json) и извлечь его содержимое (текст, таблицы, данные). Вызывается только если в последнем сообщении пользователя есть прикреплённый файл.',
        input_schema: {
          type: 'object',
          properties: {
            file_name: { type: 'string', description: 'Имя файла, который нужно прочитать' },
            note: { type: 'string', description: 'Что именно нужно извлечь из файла' },
          },
        },
      },
      execute: async (ctx, args, attachment) => {
        if (!attachment) {
          return { ok: false, summary: '', error: 'В сообщении нет прикреплённого файла. Попросите пользователя прикрепить файл.' };
        }
        const name = typeof args.file_name === 'string' && args.file_name
          ? args.file_name
          : attachment.name;
        if (name !== attachment.name) {
          return { ok: false, summary: '', error: `Прикреплён файл «${attachment.name}», а не «${name}».` };
        }
        return parseFile(ctx, attachment.data, attachment.name);
      },
    },
    {
      schema: {
        name: 'get_emails',
        description: 'Поиск писем в базе почты (доступен, если у пользователя есть права на плагин «Письма»).',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Поиск по теме/автору/номеру' },
            direction: { type: 'string', description: 'Направление (название)' },
            limit: { type: 'number', description: 'Сколько показать (по умолчанию 20, максимум 200)' },
          },
        },
      },
      execute: (ctx, args) => getEmails(ctx, args),
    },
    {
      schema: {
        name: 'get_documents',
        description: 'Поиск документов в базе документов (доступен, если у пользователя есть права на плагин «Документы»).',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Поиск по названию/типу/куратору' },
            limit: { type: 'number', description: 'Сколько показать (по умолчанию 20, максимум 200)' },
          },
        },
      },
      execute: (ctx, args) => getDocuments(ctx, args),
    },
    {
      schema: {
        name: 'get_lims_requests',
        description: 'Заявки на испытания из ЛИМС (доступен, если у пользователя есть права на плагин «Заявки на испытания»/«ЛИМС»).',
        input_schema: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'Статус: new/processing/completed' },
            limit: { type: 'number', description: 'Сколько показать (по умолчанию 20, максимум 200)' },
          },
        },
      },
      execute: (ctx, args) => getLimsRequests(ctx, args),
    },
    {
      schema: {
        name: 'get_tasks',
        description: 'Поиск задач в локальной базе задач (кэш плагина «Задачи», fallback — кэш монолита yougile_cache.json). Всегда доступно. Возвращает также агрегаты byProject/byColumn/completed — используй их для вопросов вида «сколько задач по проекту/колонке/статусу».',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Поиск по названию/описанию/исполнителю' },
            project: { type: 'string', description: 'Фильтр по проекту' },
            completed: { type: 'boolean', description: 'Только завершённые' },
            limit: { type: 'number', description: 'Сколько показать (по умолчанию 20, максимум 200)' },
          },
        },
      },
      execute: (ctx, args) => getTasks(ctx, args),
    },
  ];
  return tools;
}
