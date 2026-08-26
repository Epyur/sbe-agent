import type { AgentToolSchema, ToolCallResult, SourceAvailability } from '../types/agent';
import { generateFile, parseFile, readTextPart } from './tools/file-tools';
import { getEmails, getDocuments, getLimsRequests } from './tools/database-tools';
import { getTasks } from './tools/tasks-tool';
import { addSkill, listSkills, readSkill } from './tools/skills-tools';
import { readLocalCache } from './tools/local-cache';
import { saveRule, listRules, readRule } from './tools/rules-tools';

/** Контекст исполнения тулов (предоставляет плагин). */
export interface AgentToolContext {
  getApiUrl: () => string;
  getToken: (appId: string) => Promise<string>;
  getEmail: () => string;
  getUserName: () => string;
  getSources: () => SourceAvailability[];
  readVaultText: (path: string) => Promise<string>;
  writeVaultFile: (path: string, data: ArrayBuffer | string) => Promise<void>;
  listVaultDir: (path: string) => Promise<string[]>;
  /** Все файлы каталога рекурсивно (полные пути). */
  listVaultTree: (path: string) => Promise<string[]>;
  vaultExists: (path: string) => Promise<boolean>;
  /** Явное подтверждение пользователя (для рискованных операций, ревью B6). */
  confirmUser?: (message: string) => Promise<boolean>;
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
        return generateFile(ctx, 'docx', args as Record<string, unknown>, 'Word');
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
        return generateFile(ctx, 'xlsx', args as Record<string, unknown>, 'Excel');
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
        return generateFile(ctx, 'pdf', args as Record<string, unknown>, 'PDF');
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
        return generateFile(ctx, 'json', { data: args.data }, 'JSON');
      },
    },
    {
      schema: {
        name: 'parse_file',
        description: 'Прочитать прикреплённый пользователем файл (docx/xlsx/pdf/json) и извлечь его содержимое (текст, таблицы, данные). Вызывается только если в последнем сообщении пользователя есть прикреплённый файл.',
        input_schema: {
          type: 'object',
          properties: {
            note: { type: 'string', description: 'Что именно нужно извлечь из файла' },
          },
        },
      },
      execute: async (ctx, args, attachment) => {
        if (!attachment) {
          return { ok: false, summary: '', error: 'В сообщении нет прикреплённого файла. Попросите пользователя прикрепить файл.' };
        }
        // Файл берётся из вложения целиком; имя известно движку, LLM его не угадывает.
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
    {
      schema: {
        name: 'read_local_cache',
        description: 'Прочитать любой ЛОКАЛЬНЫЙ кэш вольта: mailer (письма с текстом), documents (документы), requests (заявки), contacts (контакты), tasks (задачи), yougile (legacy монолита). Возвращает структуру кэша (ключи и количество) и записи основного списка с фильтром по query.',
        input_schema: {
          type: 'object',
          properties: {
            cache: { type: 'string', enum: ['mailer', 'documents', 'requests', 'contacts', 'tasks', 'yougile'] },
            query: { type: 'string', description: 'Поиск по строкам записей' },
            limit: { type: 'number', description: 'Сколько показать (по умолчанию 20, максимум 200)' },
          },
          required: ['cache'],
        },
      },
      execute: (ctx, args) => readLocalCache(ctx, args),
    },
    {
      schema: {
        name: 'create_mermaid',
        description: 'Сформировать mermaid-диаграмму: PNG + SVG + .mmd исходник. Возвращаются ссылки на скачивание (PNG — основная, SVG и .mmd — в extra).',
        input_schema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Название файла (без расширения)' },
            code: { type: 'string', description: 'Mermaid-код диаграммы (graph TD/flowchart/sequenceDiagram/pie/xychart-beta и т.п.)' },
          },
          required: ['title', 'code'],
        },
      },
      execute: async (ctx, args) => {
        if (!args.title || !args.code) {
          return { ok: false, summary: '', error: 'Требуются поля title и code.' };
        }
        return generateFile(ctx, 'mermaid', args as Record<string, unknown>, 'Mermaid (PNG)');
      },
    },
    {
      schema: {
        name: 'create_png',
        description: 'Сгенерировать PNG-изображение: график из данных (chart: bar/line/pie — столбики, линии, круговая) ИЛИ диаграмма по mermaid-коду (mermaid). Возвращается ссылка на скачивание PNG.',
        input_schema: {
          type: 'object',
          properties: {
            chart: {
              type: 'object',
              description: 'График из данных',
              properties: {
                type: { type: 'string', enum: ['bar', 'line', 'pie'] },
                title: { type: 'string' },
                data: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'number' } } } },
              },
            },
            mermaid: { type: 'string', description: 'Либо mermaid-код диаграммы для рендера в PNG' },
          },
        },
      },
      execute: async (ctx, args) => {
        if (!args.chart && !args.mermaid) {
          return { ok: false, summary: '', error: 'Требуется chart (данные графика) или mermaid (код диаграммы).' };
        }
        const spec = args.chart ? { chart: args.chart } : { mermaid: args.mermaid };
        return generateFile(ctx, 'png', spec, 'PNG');
      },
    },
    {
      schema: {
        name: 'create_html',
        description: 'Сформировать самодостаточный HTML-файл: текст/разделы, встроенные base64-изображения (url — ссылка на PNG от create_png/create_mermaid), inline SVG и mermaid-диаграммы (рендерятся сервером и встраиваются как SVG). Возвращается ссылка на скачивание HTML.',
        input_schema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            sections: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  heading: { type: 'string' },
                  paragraphs: { type: 'array', items: { type: 'string' } },
                  table: { type: 'object', properties: { headers: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } } } },
                },
              },
            },
            images: {
              type: 'array',
              items: { type: 'object', properties: { url: { type: 'string', description: 'Ссылка на PNG (от create_png/create_mermaid)' }, caption: { type: 'string' } } },
            },
            svgs: { type: 'array', items: { type: 'string' }, description: 'Inline SVG-строки' },
            mermaid_blocks: { type: 'array', items: { type: 'string' }, description: 'Mermaid-код, будет отрендерен в SVG и встроен' },
          },
          required: ['title'],
        },
      },
      execute: async (ctx, args) => {
        if (!args.title) {
          return { ok: false, summary: '', error: 'Требуется title.' };
        }
        return generateFile(ctx, 'html', args as Record<string, unknown>, 'HTML');
      },
    },
    {
      schema: {
        name: 'add_skill',
        description: 'Установить скил(ы) из GitHub-репозитория в вольт (аналог `npx skills add <repo> --skill <name>`). Скил сохраняется в yourbase/sbe_agent/skills/.',
        input_schema: {
          type: 'object',
          properties: {
            repo_url: { type: 'string', description: 'URL GitHub-репозитория, например https://github.com/mattpocock/skills' },
            skill_path: { type: 'string', description: 'Имя скила (подпапки), если нужно установить только его (аналог --skill). Пусто — установить весь репозиторий.' },
          },
          required: ['repo_url'],
        },
      },
      execute: (ctx, args) => addSkill(ctx, args),
    },
    {
      schema: {
        name: 'list_skills',
        description: 'Список установленных скилов (имя и описание из SKILL.md). Вызывай, когда задача похожа на известную методику (брейнсторм, код-ревью, интервью и т.п.) — возможно, есть подходящий скил.',
        input_schema: { type: 'object', properties: {} },
      },
      execute: (ctx) => listSkills(ctx),
    },
    {
      schema: {
        name: 'read_skill',
        description: 'Загрузить инструкции установленного скила (SKILL.md + файлы) в контекст, чтобы следовать им при выполнении задачи.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Имя скила (из list_skills)' },
          },
          required: ['name'],
        },
      },
      execute: (ctx, args) => readSkill(ctx, args),
    },
    {
      schema: {
        name: 'read_text_part',
        description: 'Прочитать часть сохранённого текста большого документа (после parse_file). parse_file сообщает путь к сохранённому тексту и объём; вызывай read_text_part повторно с увеличивающимся start, пока не получишь «конец документа» — так можно проанализировать весь документ, а не только начало.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Путь к сохранённому тексту (сообщит parse_file, обычно yourbase/sbe_agent/parsed/...)' },
            start: { type: 'number', description: 'С какого символа читать (0 — начало)' },
            length: { type: 'number', description: 'Сколько символов прочитать (максимум 24000, по умолчанию 24000)' },
          },
          required: ['path', 'start'],
        },
      },
      execute: (ctx, args) => readTextPart(ctx, args),
    },
    {
      schema: {
        name: 'save_rule',
        description: 'Создать или обновить файл правил (AGENTS.md или другой .md) в вольте по указанию пользователя. Файлы в yourbase/sbe_agent/rules/ автоматически применяются агентом. append=true — дополнить существующий файл.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Путь в вольте, например AGENTS.md, docs/правила.md или yourbase/sbe_agent/rules/менеджмент.md. Пусто — yourbase/sbe_agent/rules/правила.md' },
            content: { type: 'string', description: 'Текст правил (markdown)' },
            append: { type: 'boolean', description: 'Дополнить существующий файл (вместо перезаписи)' },
          },
          required: ['content'],
        },
      },
      execute: (ctx, args) => saveRule(ctx, args),
    },
    {
      schema: {
        name: 'list_rules',
        description: 'Список файлов правил агента (в yourbase/sbe_agent/rules/).',
        input_schema: { type: 'object', properties: {} },
      },
      execute: (ctx) => listRules(ctx),
    },
    {
      schema: {
        name: 'read_rule',
        description: 'Прочитать файл правил (или любой .md) в контекст, чтобы следовать ему.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Путь в вольте, например AGENTS.md' },
          },
          required: ['path'],
        },
      },
      execute: (ctx, args) => readRule(ctx, args),
    },
  ];
  return tools;
}
