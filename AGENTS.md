# AGENTS.md — sbe-agent (LogicTEAM.007)

Универсальный LLM-агент: MCP-набор тулов (создание/чтение Word/Excel/JSON/электронных PDF),
чтение баз (письма, документы, ЛИМС) по правам пользователя через соответствующие плагины
и локальной базы задач. Генерация файлов — на сервере (agent-service → S3 `sbe-agent` →
ссылка на скачивание ~2 дня).

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
  коммита и СПРОСИТЬ подтверждение commit/push.**
- Изменения sbe-core не тянут пересборку остальных плагинов (правило 2026-08-20).

## История работ

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
