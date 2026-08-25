# AGENTS.md — sbe-agent (LogicTEAM.007)

Универсальный LLM-агент: MCP-набор тулов (создание/чтение Word/Excel/JSON/электронных PDF),
чтение баз (письма, документы, ЛИМС) по правам пользователя через соответствующие плагины
и локальной базы задач. Генерация файлов — на сервере (agent-service → S3 `sbe-agent` →
ссылка на скачивание ~2 дня).

**Бэк — в этой же папке** (`agent-service/` + `agent-mermaid/`, 2026-08-24, переехали из
`server_back/`) — на отдельной ветке `backend` (main — чистый релизный срез кода плагина,
без бэка; см. правило «Бэки в папках плагинов» в корневом `plugins/AGENTS.md`).

## Назначение (текущее)

- **MCP в Obsidian**: реестр тулов (MCP-совместимые схемы name/description/input_schema) +
  цикл агента (`src/agent/agent-engine.ts`): контекст → `sbe-llm.completeJson` →
  `{"type":"tool_call"|"final"}` → исполнение → повтор (до 6 итераций). Внешний MCP-сервер
  для сторонних клиентов — вне MVP.
- **Тулы файлов** — через agent-service (`JWT app_id=agent`): `create_docx`/`create_xlsx`/
  `create_pdf`/`create_json` (`POST /api/agent/file/generate`, spec → S3 `sbe-agent` → URL),
  `parse_file` (`POST /api/agent/file/parse`, multipart; чтение содержимого прикреплённого файла).
- **Тулы данных** — прямые вызовы plugin-services по JWT пользователя (права проверяет сервер,
  1:1 с плагинами): `get_emails` (mailer), `get_documents` (documents), `get_lims_requests` (lab),
  `get_tasks` (локальный кэш `yourbase/sbe_tasks/tasks_cache.json`, всегда доступен).
- **Контекст пользователя** — имя из настроек (`userName`) + email из ЦУП. Доступные источники —
  по `permissions/me` каждого app (сайдбар показывает уровень роли).
- **История диалогов** — `yourbase/sbe_agent/chat_history.json` (`{dialogs:[{id,title,messages,created_at,updated_at}]}`).
- **Точка входа** — магазин: «Установленные → Открыть» (`publishService('sbe-agent', {open})`).

## Структура

| Файл | Что это |
|---|---|
| `src/main.ts` | `SbeAgentPlugin`: настройки, БД истории, контекст тулов, refreshSources (permissions/me), view, publishService |
| `src/agent/agent-engine.ts` | `AgentEngine`: цикл tool_call/final, системный промпт (персона, пользователь, источники, схемы тулов), защита от зацикливания |
| `src/agent/tools-registry.ts` | `createTools()`: MCP-схемы 9 тулов + исполнители; `AgentToolContext` |
| `src/agent/http.ts` | `request()` (requestUrl + таймаут), `assertOk`, `buildMultipart` |
| `src/agent/tools/file-tools.ts` | `generateFile`, `parseFile` (agent-service, JWT agent) |
| `src/agent/tools/database-tools.ts` | `getEmails`, `getDocuments`, `getLimsRequests` (pull + фильтр + limit) |
| `src/agent/tools/tasks-tool.ts` | `getTasks` (локальный кэш задач) |
| `src/database/agent-db.ts` | `AgentDatabase`: история диалогов |
| `src/ui/agent-view.ts` | `AgentView`: фасад (сайдбар: Диалоги/Источники; контент: чат с прикреплением файла) |
| `src/ui/settings-tab.ts` | apiUrl, имя пользователя, модель LLM |
| `src/types/agent.ts` | `AgentMessage`, `Dialog`, `AgentToolSchema`, `ToolCallResult`, `LlmTurn`, `SourceAvailability` |
| `src/styles.css` | Классы `tn-ag-*` на семантических токенах |

## Настройки (data.json)

`apiUrl` (default `https://epyur.fvds.ru`), `userName` (default `''`), `model` (default `''` —
модель по умолчанию sbe-llm).

## Правила

- `catch(e: unknown)` + `errorMessage()`; `requestUrl()`; `window.setTimeout()`; без `any`;
  UI на русском; автор — Полищук Евгений (polishchuk@tn.ru). Классы `tn-ag-*` / `tn-btn*`
  на семантических токенах sbe-core.
- Коммиты/пуши — только по явной команде пользователя.
- **«Фиксируй» = поднять версию (+0.0.1), обновить документацию, подготовить сообщение
  коммита и СПРОСИТЬ подтверждение commit/push.** Не поднимать версию плагина при
  коммите чисто бэковых изменений в `agent-service/`/`agent-mermaid/` (ветка `backend`),
  если сам плагин не менялся.
- Изменения sbe-core не тянут пересборку остальных плагинов (правило 2026-08-20).

## История работ

### 2026-08-25 — v0.2.3 (безопасность истории: маскировка ссылок + лимиты)
- **Подписанные S3-ссылки больше не сохраняются в историю** (ревью 1.1/строка 42:
  presigned-URL содержит ключ доступа в подписи):
  - в `content` сообщений подпись обрезается при добавлении
    (`sanitizeForHistory`: URL с `X-Amz-Signature`/`sig=` → база + `?…`);
  - поле `link` (кнопка скачивания) не сериализуется в `chat_history.json` —
    в живой сессии кнопка работает, из файла исчезает (ссылка и так истекает ~48 ч).
- **Лимиты истории**: диалоги старше 90 дней удаляются, хвост ограничен 100 диалогами
  (`prune()` при каждом сохранении).
- **Автоскролл чата**: прокрутка к последнему сообщению/индикатору после каждого
  обновления (`scrollChatToBottom` через двойной requestAnimationFrame — вызывается из
  renderChat, showWorking, finishWorking, addMessage).
- **Фикс скилов «установлен, но не виден»**: `listVaultDir` возвращает только прямых
  детей папки, а SKILL.md лежит во вложенных подпапках → list_skills всегда отвечал
  «скилов нет». Добавлен рекурсивный `listVaultTree` в контекст тулов; `list_skills`
  ищет `*/SKILL.md` по всему дереву skills/, `read_skill` — fallback-поиск по дереву
  (скилы, установленные целым репозиторием, могут лежать глубже).
- Старый файл истории выведен из вольта администратором (содержал presigned-URL) —
  история начинается заново.
- Версия 0.2.2 → **0.2.3** (manifest + package.json). `npx tsc --noEmit` EXIT=0;
  `npm run build` OK.

### 2026-08-20 — v0.2.2 (правила пользователя: AGENTS.md и файлы правил)
- Новые тулы: `save_rule` (создание/обновление AGENTS.md или файла правил в вольте по
  указанию пользователя; `path`, `append`), `list_rules`, `read_rule`. Файлы правил
  хранятся в `yourbase/sbe_agent/rules/*.md` (создаются автоматически через save_rule).
- **Автоприменение**: `agent-engine.buildRulesBlock()` — все правила из
  `yourbase/sbe_agent/rules/` добавляются в системный контекст при каждом запуске
  («Правила пользователя … обязательны к исполнению»). Шаблон контекста дополнен
  пунктом про правила.
- Версия 0.2.1 → **0.2.2** (manifest + package.json). `npx tsc --noEmit` EXIT=0;
  `npm run build` OK.

### 2026-08-20 — v0.2.1 (индикатор работы агента в чате)
- В чате добавлен индикатор активности: спиннер + статус («Агент думает…» → «Вызываю
  инструмент «get_emails»…»). Engine передаёт статус через колбэк `onProgress`;
  view (`showWorking`/`finishWorking`) показывает/скрывает индикатор. Скрывается после
  финального ответа или ошибки.
- Версия 0.2.0 → **0.2.1** (manifest + package.json). `npx tsc --noEmit` EXIT=0;
  `npm run build` OK.

### 2026-08-20 — v0.2.0 (mermaid/png/html, скилы, локальные кэши, редактируемый контекст)
- **Новый серверный контейнер `agent-mermaid`** (`server_back/agent-mermaid/`): Node +
  `@mermaid-js/mermaid-cli` + chromium (системный, `PUPPETEER_EXECUTABLE_PATH`), внутренний
  HTTP `POST /render {code, format: svg|png}` (render.js вызывает CLI `mmdc` с
  `-p puppeteer.json` для `--no-sandbox`). Данные не покидают сервер.
- **agent-service**: `mermaid.go` — `renderMermaid` (клиент agent-mermaid),
  `chartToMermaid` (bar/line → `xychart-beta`, pie → `pie`; подписи в кавычках — без них
  лексер mermaid не принимает кириллицу), `renderHtml` (base64-изображения по S3-url,
  inline SVG, mermaid-блоки → SVG). Новые форматы `/file/generate`: `mermaid` (PNG+SVG+.mmd,
  ответ с `extra`), `png` (chart или mermaid), `html`. Ответ `GenerateResponse` + `extra`.
  Деплой + E2E 14/14.
- **Плагин**: новые тулы `create_mermaid`, `create_png`, `create_html`, `add_skill`/
  `list_skills`/`read_skill` (jszip, GitHub-репо → `yourbase/sbe_agent/skills/`).
- **Локальные кэши**: `get_emails`/`get_documents`/`get_lims_requests` читают ЛОКАЛЬНЫЕ кэши
  (с полным текстом писем), при отсутствии — pull с сервера (MCP). Новый тул
  `read_local_cache` (mailer/documents/requests/contacts/tasks/yougile): структура + записи.
  Схема полей всех кэшей — `local-cache.ts` (CACHE_SCHEMAS) и в системном промпте.
- **Редактируемый контекст агента**: системный промпт вынесен в
  `yourbase/sbe_agent/agent_context.md` (создаётся при старте, редактируется в Obsidian;
  плейсхолдеры `{{ПОЛЬЗОВАТЕЛЬ}}/{{ИСТОЧНИКИ}}/{{СХЕМА_КЭШЕЙ}}/{{ИНСТРУМЕНТЫ}}`
  подставляются на лету). Настройка `maxIterations` (по умолчанию 15).
- **Значительное расширение функциональности** (архитектурная веха: файлы mermaid/png/html,
  скилы, локальные кэши, редактируемый контекст) → версия поднята до 0.2.0.
- Версия 0.1.2 → **0.2.0** (manifest + package.json). `npx tsc --noEmit` EXIT=0;
  `npm run build` OK (main.js ~162KB из-за jszip).

### 2026-08-20 — v0.1.1 (UI-фиксы чата, активные ссылки, агрегаты задач)
- **Активная ссылка на скачивание**: тулы `create_*` возвращают `link`, в сообщении тула
  рисуется кнопка «⬇ Скачать файл Excel/Word/PDF/JSON» (открывает подписанный S3-URL);
  URL в тексте ассистента рендерятся кликабельными с коротким ярлыком (`linkLabel`:
  «⬇ Скачать файл {формат}» для S3-ссылок с расширением, иначе усечение до 60 символов).
- **Копирование ответов**: кнопка «⧉» на сообщениях ассистента и тулов
  (`navigator.clipboard` + fallback через `textarea`/`execCommand`).
- **Локальный JSON / задачи**: `get_tasks` читает `sbe_tasks/tasks_cache.json` и fallback
  `yougile_cache.json` (кэш дашборда монолита), возвращает агрегаты `byProject`/`byColumn`/
  `completed`/`open` (вопросы «сколько задач…»), лимит по умолчанию 50 (макс. 200);
  в описании тула указано использовать агрегаты. `parse_file` для JSON показывает сниппет.
- **Engine**: сообщение тула в чате — только summary (без выгрузки данных), данные — в
  transcript LLM; лимит данных поднят до 30000. Системный промпт: не вставлять длинные
  S3-URL в ответ (кнопка в сообщении тула). Тулы данных — лимит 20 (макс. 200) + `total`.
- **Фикс ширины поля ввода**: `.tn-ag-attach-chip[hidden]` перекрывал UA-стиль `[hidden]`,
  пустой чип (`flex-basis:100%`) сжимал textarea — добавлено скрытие + `width:100%`/
  `min-width:0` для строки ввода.
- Версия 0.1.0 → **0.1.1** (manifest + package.json). `npx tsc --noEmit` EXIT=0;
  `npm run build` OK.

### 2026-08-20 — v0.1.0 (создание)
- Дизайн: `docs/superpowers/specs/2026-08-20-sbe-agent-design.md` (согласован 2026-08-20).
- Сервер: `server_back/agent-service/` (Go, контейнер `agent`, БД `agent`, Caddy
  `/api/agent/*`, auth-service seed `agent`) — генерация/разбор файлов, S3 `sbe-agent`
  (rclone + `rclone link --expire 48h`), cron очистки 2 дня. Задеплоен + E2E 16/16
  (health, generate docx/xlsx/pdf/json → S3 → ссылка → download, parse round-trip,
  401/403/400). Библиотеки: excelize/v2 (xlsx), go-pdf/fpdf + DejaVu UTF-8 шрифт (pdf),
  ledongthuc/pdf (чтение), свой OOXML-рендер (docx).
- Плагин: реестр тулов + цикл агента через sbe-llm + чат-UI (фасад) + история.
  `publishService('sbe-agent')`. `npx tsc --noEmit` EXIT=0, `npm run build` OK.
- `sbe-core`: добавлены `SbeAgentApi`, `'sbe-agent'` в `SbeServiceMap`,
  `getServiceName` → «LogicTEAM.007». Другие плагины не пересобирались (правило 2026-08-20).
- Реестр: запись `sbe-agent` (hasView, tools, ownerEmail); registry.json синхронизирован
  на сервер; community-plugins.json дополнен.

## Статистика ошибок и отступлений

- Нарушений правил нет: 0 `any`, 0 `fetch`, 0 инлайн-стилей (кроме `attachInput.style.display` —
  технически необходим для скрытия `<input type=file>`, задокументировано), `window.setTimeout`
  корректен, все `catch(e: unknown)` + `errorMessage()`.
- `npx tsc --noEmit` EXIT=0, `npm run build` OK (без предупреждений).
