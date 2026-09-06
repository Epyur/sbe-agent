# AGENTS.md — agent-service (LogicTEAM.007)

Go-сервис генерации и разбора файлов для SBE-плагина «LogicTEAM.007» (sbe-agent).
Контейнер `agent`, БД `agent` (postgres `agent-db`), авторизация — JWT HS256 (общий
`JWT_SECRET` с auth-service) + роли из `agent_permissions`. Файлы — в S3 (бакет `sbe-agent`)
через rclone CLI, ссылка на скачивание — `rclone link --expire 48h`. Деплой на VDS: копия этой
папки в рабочую папку Docker-стека (путь — вне git, см. рабочую документацию).

## Назначение (текущее)

- `POST /api/agent/file/generate` — `{format, spec}` → рендер (docx/xlsx/pdf/json/mermaid/png/html)
  → S3 `sbe-agent/agent/{uuid}.{ext}` → `{url, expires_at, file_name, extra?}` (url — подписанная ссылка;
  `extra` — svg/mmd для `mermaid`). Mermaid/png/html — см. `mermaid.go` и сервис `agent-mermaid`.
- `POST /api/agent/file/parse` — multipart `file` → извлечение содержимого
  (`{kind, text | sheets | data}`).
- `GET /api/agent/health`.
- Таблица: `agent_permissions(app, email, role)` (viewer(1) < editor(2) < admin(3);
  seed owner=admin).
- При старте: `POST /apps/register` (agent + секрет).

## Библиотеки

- `xuri/excelize/v2` — xlsx (генерация и чтение).
- `go-pdf/fpdf` + **DejaVu Sans Condensed (OFL)** через `go:embed` (`fonts/`) — PDF с
  кириллицей (встроенные шрифты fpdf — только Latin-1). Bold-вариант зарегистрирован
  для заголовков.
- `ledongthuc/pdf` — чтение текста электронных PDF (стандартные кодировки).
- docx — собственный минимальный OOXML-рендер (zip: `[Content_Types].xml`, `_rels/.rels`,
  `word/document.xml`); чтение — unzip + стрип тегов.
- json — `encoding/json`.
- **Mermaid/png/html** — рендер mermaid через контейнер `agent-mermaid`
  (Node + `@mermaid-js/mermaid-cli` + chromium, внутренний `POST /render`). Графики
  (bar/line/pie) конвертируются в mermaid `xychart-beta`/`pie` (`chartToMermaid`).
  HTML собирается в `renderHtml` (base64-изображения по S3-url, inline SVG, mermaid-блоки).

⚠️ **Ограничение**: PDF, сгенерированные fpdf с UTF-8 шрифтом (subset), не извлекаются
`ledongthuc/pdf` (текст в PDF закодирован глифами подмножества). Чтение работает для
«электронных» PDF со стандартными кодировками. Это задокументировано и покрыто тестом
(`TestParsePdfStandard` — fpdf Helvetica + ASCII).

## S3 (rclone)

- Бакет `sbe-agent` (создан 2026-08-20), remote `firstvds_agent` генерируется из env
  (`S3_ENDPOINT`/`S3_ACCESS_KEY`/`S3_SECRET_KEY`) в `rclone.conf` при старте.
- Загрузка — `rclone copyto`; ссылка — `rclone link --expire 48h` (подписанный GET).
- Очистка: cron на сервере `0 4 * * * rclone delete firstvds:sbe-agent/agent --min-age 48h`
  (лог `/var/log/rclone_agent_cleanup.log`). Срок хранения файлов — ~2 дня.
- НЕ использовать `mailers-backup` (ротация 7 дней).

## Конфиг (env)

`DATABASE_URL`, `PORT`, `JWT_SECRET`, `AGENT_APP_ID` (default `agent`), `AGENT_APP_NAME`,
`AGENT_OWNER_EMAIL`, `AGENT_SERVICE_SECRET`, `AUTH_SERVICE_URL`, `S3_ENDPOINT`,
`S3_ACCESS_KEY`, `S3_SECRET_KEY`, `AGENT_S3_BUCKET` (default `sbe-agent`),
`AGENT_KEY_ENCRYPTION_KEY` (2026-09-06, ЮГайл — AES-256 ключ шифрования пароля
пользователя, 32 байта base64, `openssl rand -base64 32`; сервис не стартует
без неё), `YOUGILE_COMPANY_ID` (2026-09-06 — id компании в ЮГайле, одно
значение на всех, то же самое, что уже использует Obsidian-плагин `sbe-yougile`).

## Сборка / проверка

```
docker compose up -d --build agent        # на сервере
docker compose logs agent --tail 20
curl -s https://epyur.fvds.ru/api/agent/health   # {"status":"ok"}
```

Локальная Go-проверка (на машине разработчика):
```
# go1.24 в temp (go.mod/go.sum в репо):
go test ./...   # рендеры/парсеры (files_test.go)
```

## История

- **2026-09-06 — ЮГайл для веб-агента (чтение + ограниченная запись, БЕЗ удаления).**
  Дизайн: `docs/superpowers/specs/2026-09-06-web-agent-yougile-design.md`. Даёт
  веб-агенту (`sbe-web`) прямой доступ к API ЮГайла (`ru.yougile.com/api-v2`) —
  сервер-серверный прокси, без CORS-проблемы браузера, ключ ЮГайла никогда не
  попадает в код фронтенда. Obsidian-плагин `sbe-agent` НЕ менялся (у него уже
  есть рабочий `get_tasks` через локальный кэш вольта) — это только веб.
  - **Хранение пароля** (`yougile_credentials.go`): таблица
    `yougile_credentials(email PK, password_enc, password_nonce)`, AES-256-GCM
    (`crypto.go`, порт `sbe-llm/llm-service/crypto.go`, новый ключ
    `AGENT_KEY_ENCRYPTION_KEY`, отдельный от `LLM_KEY_ENCRYPTION_KEY`). Логин
    ЮГайла = email пользователя, не хранится отдельно. `companyId` — константа
    сервера (`YOUGILE_COMPANY_ID`, одна на всю компанию), не per-user.
    `GET/POST/DELETE /api/agent/yougile/settings` — пароль никогда не
    возвращается клиенту.
  - **Обмен пароля на ключ ЮГайла** (`yougile_client.go`): `POST
    ru.yougile.com/api-v2/auth/keys {login: email, password, companyId}` →
    ключ кэшируется в памяти процесса (`yougileKeyCache`, per-email), не в БД;
    повторный обмен — только если ключа нет в кэше или ЮГайл ответил 401
    (реактивное обновление, тот же паттерн, что уже в
    `sbe-yougile/src/services/auth.ts`).
  - **Хендлеры** (`yougile_handlers.go`, все за `requirePerm("viewer")`, как
    остальные роуты сервиса): `GET /api/agent/yougile/tasks` (список+фильтры),
    `GET /api/agent/yougile/board-tree` (проекты+доски+колонки+пользователи
    одним вызовом — для сопоставления имён → id), `POST
    /api/agent/yougile/tasks` (создание), `PUT
    /api/agent/yougile/tasks/{id}/status` (смена колонки — в API ЮГайла нет
    отдельного поля статуса), `POST /api/agent/yougile/tasks/{id}/message`
    (multipart `text`+необязательный `file` — файл грузится через
    `/upload-file`, ссылка/картинка встраивается в `textHtml` сообщения, т.к.
    у сообщения чата ЮГайла нет отдельного поля «вложение», см.
    `yougile-tntn/src/ui/tasks-view.ts`; `taskId` САМ является `chatId`
    собственного чата задачи).
  - **Удаления нет нигде в коде** — ни хендлера, ни метода клиента, ни тула на
    веб-клиенте (см. `sbe-web/AGENTS.md`) — структурная гарантия, категорическое
    требование пользователя (задачи/доски/проекты), не текстовый запрет.
  - `go build`/`go vet` — чисто.
- **2026-09-05/06 — `ChartSpec`: несколько именованных рядов (`categories`+`series`).**
  Живая жалоба из веб-агента: модель просила `create_mermaid` нарисовать график
  «поступление/завершение заявок по датам» (два ряда на одних датах) вручную
  написанным mermaid-кодом — и один раз дописала несуществующий в грамматике
  `xychart-beta` оператор `legend`, из-за чего `mmdc` падал с parse error, а
  сервер отдавал общее `{"error":"render error"}` (реальная причина видна
  только в `docker logs agent`, см. `files.go:167` — `log.Printf` пишет полный
  текст ошибки, HTTP-ответ — нет). Диагноз: `ChartSpec.Data` поддерживал
  только ОДИН ряд `{label,value}` — для второго ряда модели ничего не
  оставалось, кроме сырого `create_mermaid`, где она может написать что
  угодно, включая невалидный синтаксис.
  - **Фикс**: `ChartSpec` дополнен (аддитивно, `Data`/`Type` для одного ряда
    работают как раньше) полями `Categories []string` + `Series
    []ChartSeries{Name, Type, Values}` — несколько рядов на общих категориях.
    `chartToMermaid` (`mermaid.go`) при непустом `Series` сама программно
    собирает `xychart-beta` с несколькими `bar`/`line` — код никогда не пишет
    модель, значит невалидный синтаксис здесь структурно невозможен. У
    `xychart-beta` нет оператора legend (в отличие от других видов диаграмм
    mermaid) — имя ряда пишем комментарием `%% name` в исходнике для
    человека, визуально ряды различает сам mermaid цветом.
  - Тесты `TestChartToMermaidMultiSeries` (валидный синтаксис, нет `legend`)
    + `TestChartToMermaidSingleSeriesBackwardCompat` (старый формат не
    сломан) — `mermaid_test.go`. `go build`/`go vet`/`go test` — чисто.
  - **Известный разрыв**: клиент веба (`sbe-web/src/modules/agent/tools.ts`,
    `create_png`) уже передаёт `categories`/`series` в схеме тула — плагин
    Obsidian (`sbe-agent/src/agent/tools-registry.ts`) ещё нет, хотя бэкенд
    общий и уже готов принять оба формата. Обновить схему `create_png` там
    же, отдельной задачей, если понадобится тот же тип графика в Obsidian-клиенте.
  - Версия плагина НЕ поднимается — изменения чисто бэковые.
- **2026-09-05 — веб-портал (`sbe-web`, модуль `src/modules/agent/`): per-user
  таблицы + скретч-хранилище S3.** Ядро агента (цикл LLM↔тулы) перенесено в
  веб-клиент (см. `sbe-web/AGENTS.md`) — этот сервис остаётся «тупым»
  файловым/скиловым бэкендом, расширенным тремя новыми per-user сущностями,
  по образцу `skills.go` (`requirePerm("viewer")`, email из `permEmailCtx{}`,
  никогда из тела запроса):
  - `chat_history.go` — `chat_history(email PK, dialogs JSONB)`,
    `GET/POST /api/agent/history`, `DELETE /api/agent/history/{id}` — история
    диалогов веб-чата (в Obsidian это `yourbase/sbe_agent/chat_history.json`
    вольта; в вебе вольта нет — сервер стал источником истины, доступна с
    любого браузера/устройства).
  - `agent_rules.go` — `agent_rules(email, path, content)`,
    `GET/POST/DELETE /api/agent/rules` (`append` — сервер сам конкатенирует) —
    аналог `yourbase/sbe_agent/rules/*.md`.
  - `agent_settings.go` — `agent_settings(email PK, system_prompt)`,
    `GET/POST/DELETE /api/agent/settings` — аналог редактируемой заметки
    `agent_context.md`.
  - `scratch.go` + новый `S3Store.Get()` в `s3.go` — замена путей в вольте
    (`yourbase/sbe_agent/parsed/*`, `*.jsonl`) для `read_text_part` и
    постраничного сбора списков (`fetch_url` save_to/`save_records`/
    `build_xlsx_from_records`): новый префикс `scratch/{хеш email}/...` в том
    же бакете `sbe-agent`. **Важно**: старый cron
    (`rclone delete firstvds:sbe-agent/agent --min-age 48h`) чистит только
    `agent/` — на VDS вручную добавлена вторая строка для `scratch/` (не в
    этом репозитории, чистая инфраструктура).
  - Версия плагина НЕ поднимается — изменения чисто бэковые (см. корневой
    `AGENTS.md`, правило «Бэки в папках плагинов»).
  - `go build`/`go vet` — чисто. **Задеплоено на VDS** (`docker compose up -d
    --build agent`, собралось с первого раза), health ok, 3 новые таблицы
    подтверждены (`\dt` в `agent-db`). Живой E2E пройден пользователем через
    веб-чат (несколько раундов правок по итогам реального использования —
    см. `sbe-web/AGENTS.md` за 2026-09-04/05 для полной картины, включая
    находки на стороне веб-клиента: таймаут LLM-запроса, формат ошибок
    upstream-провайдера, отсутствие `link` у `get_photo_link`, неверный
    источник данных ЛИМС).
- **2026-08-28 — оформление документов (docx/xlsx/pdf).** Расширена модель `DocSpec`
  (аддитивно, обратная совместимость):
  - `Paragraph` — принимает и строку, и объект `{text, align, bold, italic, underline,
    size, highlight, list: bullet|number}` (кастомный `UnmarshalJSON`);
  - `Section.Level` 1–6; `Table.Style` plain/grid/fancy + `ColWidths` + `RepeatHeader`;
  - `Sheet.Title`/`AutoFilter`/`FreezeHeader`/`ColWidths`/`Wrap`.
  - **docx**: заголовки Heading1–6, выравнивание (`w:jc`), начертание/размер/выделение
    (`w:rPr`, `w:highlight`, `w:sz`), списки (`word/numbering.xml`, `numPr`, `document.xml.rels`),
    таблицы (границы, заливка шапки, `tblGrid`, `tblHeader`).
  - **docx: стандартное оформление по умолчанию** (`styles.xml` + `w:pgMar`): Times New Roman
    14pt (docDefaults), полуторный интервал, отступ первой строки 1,25 см, выравнивание по
    ширине (стиль Normal), заголовки по центру (Heading1–6, 16→11pt), поля 30/10/20/20 мм,
    таблицы 10pt. Применяется, если пользователь не задал своё; явные поля абзаца
    переопределяют. `[Content_Types].xml`/`document.xml.rels` дополнены styles.
    Тест `TestRenderDocxGostDefaults` + проверка well-formed XML всех частей пакета.
  - **xlsx** (excelize): титульный ряд (MergeCell), стили шапки/данных (NewStyle), ширины
    колонок (SetColWidth), закрепление шапки (SetPanes), **автофильтр (AutoFilter)**.
  - **pdf** (fpdf): выравнивание абзацев, жирный/курсив (итальянский вариант — тем же
    шрифтом, отдельного DejaVu Italic в `fonts/` нет), размер, маркеры/номера списков,
    заголовки по уровням, заливка шапки таблицы.
  - `mermaid.go` `renderHtml`: адаптация под `Paragraph` (используется `p.Text`).
  - Тесты: `TestParagraphUnmarshal`, `TestRenderDocxFormatting` (Heading3/jc/b/highlight/
    sz/numPr/shd/tblHeader/gridCol), `TestRenderXlsxFormatting` (autoFilter/frozen/merge/
    width/стили). `go test`/`go vet`/`go build` — чисто.
- **2026-08-20 — ограничение конкурентности (очередь, без ошибок):**
  `generate`/`parse` ограничены семафором (4 слота, `maxConcurrentFileOps`) — вместо
  ошибки «занято» запросы ждут свободный слот (`acquire` в files.go, отменяется при
  отключении клиента). В `agent-mermaid` — лимит 2 одновременных рендера (очередь,
  render.js `acquireRenderSlot`). В compose: `mem_limit` agent=512m, agent-mermaid=1g.
  Проверено: 6 одновременных mermaid-генераций → все 200 (очередь), mem_limit применён.
- **2026-08-20 — mermaid/png/html + контейнер agent-mermaid:**
  `mermaid.go` (renderMermaid-клиент, chartToMermaid, renderHtml, fetchImageBytes),
  форматы `mermaid`/`png`/`html` в `buildFiles`, `GenerateResponse.Extra`. Контейнер
  `agent-mermaid` (Node + mermaid-cli + системный chromium, `render.js` вызывает CLI
  `mmdc -p puppeteer.json` для `--no-sandbox`). При разработке: mermaid-cli v11 не
  экспортирует API через `require` → вызываем CLI `mmdc`; опции `--noSandbox` нет →
  конфиг puppeteer `-p`; xychart-beta ломается на неэкранированных кириллических
  подписях → кавычки. Деплой + E2E 14/14.
- **2026-08-20 — создание (sbe-agent, дизайн 2026-08-20-sbe-agent-design.md):**
  Сервис создан зеркалом contacts-service (jwt.go/register.go/permissions.go с адаптацией
  под `agent`), файловые тулы — в `files.go` (рендеры/парсеры) + `s3.go` (rclone + link).
  docker-compose: `agent-db` + `agent`; Caddy `/api/agent/*` → `agent:3000` (до `/api/*`);
  `.env`: `AGENT_*`. auth-service: seed приложения `agent`.
  Задеплоено на VDS + E2E 16/16 (health, generate всех форматов → S3 → ссылка → download,
  parse round-trip docx/xlsx/json, 401/403/400). Бакет `sbe-agent` создан, cron очистки
  добавлен. Локально добавлен Go-тулчейн (temp) для компиляции/тестов (см. `go test`).
  В ходе разработки: excelize v2.11.0 → v2.9.0 (v2.11 требует go 1.25, Docker — 1.24);
  `WriteToBuffer()` возвращает `(*bytes.Buffer, error)`; ledongthuc/pdf API — `NewReader`
  + `GetPlainText()` (io.Reader); fpdf требует UTF-8 шрифт для кириллицы.

## Статистика ошибок и отступлений

- `go build`/`go vet`/`go test` — без ошибок и предупреждений.
- Импортов без неиспользуемых нет.
