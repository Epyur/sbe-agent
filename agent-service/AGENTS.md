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
`S3_ACCESS_KEY`, `S3_SECRET_KEY`, `AGENT_S3_BUCKET` (default `sbe-agent`).

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
