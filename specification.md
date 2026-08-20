# specification.md — sbe-agent (LogicTEAM.007)

Форматы обмена плагина с agent-service и plugin-services (`https://epyur.fvds.ru`).

## Авторизация

- Тулы файлов: JWT Bearer app_id=`agent` (`sbe-apstore.auth.getToken('agent')`).
- Тулы данных: JWT соответствующего app (`mailer`, `documents`, `lab`) — те же, что у плагинов;
  права проверяет сервер (роли viewer/editor/admin).
- 401 — «Ключ недействителен», 403 — «Нет прав».

## Протокол тулов (LLM → плагин)

`AgentEngine` вызывает `sbe-llm.completeJson(system, transcript)`, ожидая ровно один JSON:
```jsonc
{"type": "final", "text": "<ответ>"}
{"type": "tool_call", "tool": "<имя>", "arguments": {...}}
```
Цикл: до 6 итераций, защита от повторного вызова одного тула (лимит 3).

## Реестр тулов

| Тул | Аргументы | Результат |
|---|---|---|
| `create_docx` | `{title, sections:[{heading, paragraphs[], table?}]}` | ссылка на .docx |
| `create_xlsx` | `{sheets:[{name, headers[], rows[]}]}` | ссылка на .xlsx |
| `create_pdf` | `{title, sections[]}` | ссылка на .pdf |
| `create_json` | `{data}` | ссылка на .json |
| `parse_file` | прикреплённый файл | `{kind, text\|sheets\|data}` |
| `get_emails` | `{query, direction, limit}` | письма (mailer pull) |
| `get_documents` | `{query, limit}` | документы (documents pull) |
| `get_lims_requests` | `{status, limit}` | заявки ЛИМС (lab pull) |
| `get_tasks` | `{query, project, completed, limit}` | задачи (локальный кэш) |

## agent-service

### POST /api/agent/file/generate
- Тело: `{"format": "docx|xlsx|pdf|json", "spec": {title, sections[], sheets[], data}}`.
- Рендер → S3 `sbe-agent/agent/{uuid}.{ext}` (rclone) → `rclone link --expire 48h`.
- Ответ: `{"url", "expires_at", "file_name"}`.
- `spec.sections[].table = {headers, rows}`; `spec.data` — для json.

### POST /api/agent/file/parse
- `multipart/form-data`, поле `file`. Извлечение:
  - docx — текст (OOXML `word/document.xml`);
  - xlsx — `{kind:"xlsx", sheets:[{name, rows}]}`;
  - pdf — текст (электронные PDF, стандартные кодировки; fpdf-subset не читается);
  - json — `{kind:"json", data}`.
- Ответ: `{kind, text|sheets|data}`.

### GET /api/agent/health, permissions/me|list|set
- Роли agent: viewer(1) < editor(2) < admin(3); owner seed = admin.

## S3 (sbe-agent)

- Бакет `sbe-agent` (Ceph s3.firstvds.ru), загрузка через rclone CLI (remote `firstvds_agent`,
  конфиг из env `S3_*`/`AGENT_S3_BUCKET`). НЕ mailers-backup (там ротация 7 дней).
- Очистка: cron на сервере `rclone delete firstvds:sbe-agent/agent --min-age 48h`.

## Источники данных (plugin-services)

Чтение через pull-endpoint'ы с JWT пользователя (плагин фильтрует по query/status и limit,
по умолчанию 10, максимум 50):
- письма: `GET /api/mailer/sync/pull` → `{emails}`;
- документы: `GET /api/documents/sync/pull` → `{documents}`;
- заявки ЛИМС: `GET /api/lab/sync/pull` → `{requests}`;
- задачи: `yourbase/sbe_tasks/tasks_cache.json` → `{tasks}`.

## История диалогов

`yourbase/sbe_agent/chat_history.json`:
```jsonc
{ "dialogs": [ { "id": "...", "title": "...", "messages": [
  {"role": "user|assistant|tool", "content": "...", "files": ["..."], "tool": "...", "toolOk": true, "created_at": "ISO"}
], "created_at": "...", "updated_at": "..." } ] }
```
