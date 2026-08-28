import type { AgentToolSchema, ToolCallResult, SourceAvailability } from '../types/agent';
import { generateFile, parseFile, readTextPart } from './tools/file-tools';
import { getEmails, getDocuments, getLimsRequests } from './tools/database-tools';
import { getTasks } from './tools/tasks-tool';
import { addSkill, listSkills, readSkill } from './tools/skills-tools';
import { readLocalCache } from './tools/local-cache';
import { saveRule, listRules, readRule } from './tools/rules-tools';
import { browserOpen, browserExtract, browserLinks, browserScreenshot, browserClick, browserType, browserWait, fetchUrl } from './tools/browser-tools';
import { saveRecordsToVault, buildXlsxFromVault } from './tools/records-tools';

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

const paragraphSchema = {
  type: ['string', 'object'] as const,
  description: 'Абзац: строка (простой текст) ИЛИ объект с оформлением {text, align, bold, italic, underline, size, highlight, list}',
  properties: {
    text: { type: 'string', description: 'Текст абзаца' },
    align: { type: 'string', enum: ['left', 'center', 'right', 'justify'], description: 'Выравнивание' },
    bold: { type: 'boolean', description: 'Жирный' },
    italic: { type: 'boolean', description: 'Курсив' },
    underline: { type: 'boolean', description: 'Подчёркнутый' },
    size: { type: 'number', description: 'Размер шрифта, pt (6–96)' },
    highlight: { type: 'string', description: 'Выделение фона: yellow/green/red/blue/cyan/magenta/… или hex-цвет #RRGGBB' },
    list: { type: 'string', enum: ['bullet', 'number'], description: 'Маркированный (bullet) или нумерованный (number) список' },
  },
};

const tableSchema = {
  type: 'object' as const,
  properties: {
    headers: { type: 'array', items: { type: 'string' } },
    rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
    style: { type: 'string', enum: ['plain', 'grid', 'fancy'], description: 'plain — без границ; grid — границы (по умолчанию); fancy — границы + заливка шапки' },
    col_widths: { type: 'array', items: { type: 'number' }, description: 'Ширины колонок, см (Word/PDF)' },
    repeat_header: { type: 'boolean', description: 'Повторять шапку таблицы на каждой странице (Word)' },
  },
};

const sectionsSchema = {
  type: 'array' as const,
  items: {
    type: 'object' as const,
    properties: {
      heading: { type: 'string', description: 'Заголовок раздела' },
      level: { type: 'number', description: 'Уровень заголовка 1–6 (1 — самый крупный); используй уровни для структуры документа' },
      paragraphs: { type: 'array', items: paragraphSchema },
      table: tableSchema,
    },
  },
};

const sheetsSchema = {
  type: 'array' as const,
  items: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Название листа' },
      title: { type: 'string', description: 'Титульный ряд (объединяется по ширине листа, крупный шрифт)' },
      headers: { type: 'array', items: { type: 'string' } },
      rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
      auto_filter: { type: 'boolean', description: 'Включить фильтр по колонкам (для строк — очень полезно)' },
      freeze_header: { type: 'boolean', description: 'Закрепить шапку при прокрутке' },
      col_widths: { type: 'array', items: { type: 'number' }, description: 'Ширины колонок' },
      wrap: { type: 'boolean', description: 'Перенос текста в ячейках' },
    },
  },
};

export function createTools(): AgentTool[] {
  const tools: AgentTool[] = [
    {
      schema: {
        name: 'create_docx',
        description: 'Сформировать документ Word (.docx): заголовок, разделы (абзацы и таблицы). По умолчанию документ оформляется по стандарту организации (Times New Roman 14pt, полуторный интервал, поля 30/10/20/20 мм, выравнивание по ширине, отступ первой строки 1,25 см, заголовки по центру, таблицы 10pt) — в spec это задавать НЕ нужно. Указывай только отличия: уровни заголовков (level 1–6), нестандартное выравнивание (align), жирный/курсив/подчёркнутый (bold/italic/underline), размер (size), выделение цветом (highlight), списки (list: bullet/number), стиль таблиц (style: grid/fancy), ширины колонок (col_widths), повтор шапки (repeat_header). Если пользователь дал свои требования к оформлению — следуй им. Файл создаётся на сервере, возвращается ссылка на скачивание (~2 дня).',
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
        description: 'Сформировать таблицу Excel (.xlsx): листы с заголовками и строками. Поддерживается оформление: титульный ряд, автофильтр по колонкам (auto_filter), закрепление шапки (freeze_header), ширины колонок (col_widths), перенос текста (wrap), стили шапки/границы — применяются автоматически. Возвращается ссылка на скачивание (~2 дня).',
        input_schema: {
          type: 'object',
          properties: {
            sheets: sheetsSchema,
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
        description: 'Сформировать электронный PDF: заголовок и разделы (абзацы, таблицы). Поддерживается оформление: уровни заголовков, выравнивание абзацев, жирный/курсив, размер шрифта, списки, стили таблиц. Возвращается ссылка на скачивание (~2 дня).',
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
    {
      schema: {
        name: 'fetch_url',
        description: 'Скрытый серверный HTTP-запрос к сайту/API (быстро, без браузера). Подходит для страниц и JSON/API-эндпоинтов (в т.ч. DataTables: POST с draw/start/length и search[value], columns[...]). Метод GET/POST/PUT/PATCH/DELETE, можно передать body, headers, timeout_ms. Для сбора списков постранично указывай save_to — путь в вольте (yourbase/sbe_agent/...): записи (data) каждой страницы сохраняются в файл САМИМ тулом, не проходя через контекст.',
        input_schema: {
          type: 'object',
          properties: {
            method: { type: 'string', description: 'GET (по умолчанию) / POST / PUT / PATCH / DELETE' },
            url: { type: 'string', description: 'Полный URL' },
            body: { type: 'string', description: 'Тело запроса (для POST/PUT/PATCH)' },
            headers: { type: 'object', description: 'Дополнительные HTTP-заголовки' },
            timeout_ms: { type: 'number', description: 'Таймаут в мс (по умолчанию 30000, максимум 120000)' },
            save_to: { type: 'string', description: 'Путь в вольте для накопления записей DataTables-ответа (например yourbase/sbe_agent/nsopb_reestr/nsopb.jsonl). Обязан начинаться с yourbase/sbe_agent/. Записи этой страницы (data) добавляются в JSONL-файл, в контекст не попадают.' },
          },
          required: ['url'],
        },
      },
      execute: (ctx, args) => fetchUrl(ctx, args),
    },
    {
      schema: {
        name: 'save_records_to_vault',
        description: 'Сохранить (накопить) записи одной страницы в файл вольта (JSONL). Используй при сборе списков постранично (например DataTables): каждый ответ fetch_url содержит records (data) страницы — передавай их в records, а path — общий файл накопления. Так данные не раздувают контекст. mode="overwrite" — начать файл заново.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Путь в вольте, например yourbase/sbe_agent/nsopb_reestr/nsopb.jsonl (обязан начинаться с yourbase/sbe_agent/)' },
            records: { type: 'array', description: 'Записи этой страницы: массив объектов ИЛИ массив строк-массивов (data из ответа DataTables)' },
            mode: { type: 'string', enum: ['append', 'overwrite'], description: 'append (по умолчанию) — добавить к файлу; overwrite — перезаписать файл' },
          },
          required: ['path', 'records'],
        },
      },
      execute: (ctx, args) => saveRecordsToVault(ctx, args),
    },
    {
      schema: {
        name: 'build_xlsx_from_vault',
        description: 'Собрать Excel-файл из накопленных записей (JSONL-файл из save_records_to_vault). Читает файл вольта целиком, формирует таблицу и возвращает ссылку на скачивание. Вызывай ПОСЛЕ того, как постранично собраны все записи (до recordsFiltered). Для больших списков включай auto_filter (фильтр по колонкам) и freeze_header.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Путь к файлу накопления (тот же, что в save_records_to_vault)' },
            file_name: { type: 'string', description: 'Имя скачиваемого файла без .xlsx (по умолчанию records)' },
            sheet_name: { type: 'string', description: 'Название листа (по умолчанию «Данные»)' },
            headers: { type: 'array', items: { type: 'string' }, description: 'Заголовки колонок, если записи — массивы (для объектов колонки берутся из ключей)' },
            auto_filter: { type: 'boolean', description: 'Включить фильтр по колонкам' },
            freeze_header: { type: 'boolean', description: 'Закрепить шапку при прокрутке' },
            wrap: { type: 'boolean', description: 'Перенос текста в ячейках' },
          },
          required: ['path'],
        },
      },
      execute: (ctx, args) => buildXlsxFromVault(ctx, args),
    },
    {
      schema: {
        name: 'browser_open',
        description: 'Открыть сайт во внутреннем браузере агента (вкладка откроется автоматически). Для изучения публичных сайтов, поиска информации, открытых API.',
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Полный URL (http/https)' },
          },
          required: ['url'],
        },
      },
      execute: (ctx, args) => browserOpen(ctx, args),
    },
    {
      schema: {
        name: 'browser_extract',
        description: 'Извлечь видимый текст текущей страницы внутреннего браузера в контекст (для анализа содержимого сайта).',
        input_schema: { type: 'object', properties: {} },
      },
      execute: () => browserExtract(),
    },
    {
      schema: {
        name: 'browser_links',
        description: 'Собрать ссылки текущей страницы внутреннего браузера (для навигации/обхода сайта).',
        input_schema: { type: 'object', properties: {} },
      },
      execute: () => browserLinks(),
    },
    {
      schema: {
        name: 'browser_screenshot',
        description: 'Сделать скриншот текущей страницы внутреннего браузера и сохранить в вольт (yourbase/sbe_agent/screenshots/).',
        input_schema: { type: 'object', properties: {} },
      },
      execute: (ctx) => browserScreenshot(ctx),
    },
    {
      schema: {
        name: 'browser_click',
        description: 'Кликнуть по элементу на текущей странице (CSS-селектор). sensitive=true только если действие может вести к скачиванию файла или вводу логина/пароля/конфиденциальных данных (тогда будет запрошено подтверждение). Для поисковых форм/пагинации/навигации sensitive не нужен.',
        input_schema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS-селектор элемента' },
            sensitive: { type: 'boolean', description: 'true — действие чувствительное (скачивание/логин/конфиденциальный ввод), запросит подтверждение' },
          },
          required: ['selector'],
        },
      },
      execute: (ctx, args) => browserClick(ctx, args),
    },
    {
      schema: {
        name: 'browser_type',
        description: 'Ввести текст в поле на текущей странице (CSS-селектор). sensitive=true только для логинов/паролей/конфиденциальных полей (запросит подтверждение). Для обычных полей (поиск и т.п.) sensitive не нужен.',
        input_schema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS-селектор поля' },
            text: { type: 'string', description: 'Вводимое значение' },
            sensitive: { type: 'boolean', description: 'true — конфиденциальный ввод, запросит подтверждение' },
          },
          required: ['selector', 'text'],
        },
      },
      execute: (ctx, args) => browserType(ctx, args),
    },
    {
      schema: {
        name: 'browser_wait',
        description: 'Приостановить работу и дождаться пользователя: он выполнит действие в браузере (вход в сервис, капча) и нажмёт «Продолжить». Вызывай перед действиями, требующими авторизации или ручного ввода.',
        input_schema: { type: 'object', properties: {} },
      },
      execute: () => browserWait(),
    },
  ];
  return tools;
}
