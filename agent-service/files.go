package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/go-pdf/fpdf"
	"github.com/ledongthuc/pdf"
	"github.com/xuri/excelize/v2"
)

// ================= Модель генерации =================

type DocSpec struct {
	Title         string      `json:"title"`
	Sections      []Section   `json:"sections"`
	Sheets        []Sheet     `json:"sheets"`
	Data          any         `json:"data"`
	Code          string      `json:"code"`           // mermaid format: исходник диаграммы
	Chart         *ChartSpec  `json:"chart"`          // png format: график из данных
	Mermaid       string      `json:"mermaid"`        // png format: диаграмма по коду
	Images        []HtmlImage `json:"images"`         // html format: изображения (url -> base64)
	Svgs          []string    `json:"svgs"`           // html format: inline SVG
	MermaidBlocks []string    `json:"mermaid_blocks"` // html format: mermaid-блоки
}

type ChartSpec struct {
	Type  string `json:"type"` // bar | line | pie
	Title string `json:"title"`
	Data  []struct {
		Label string  `json:"label"`
		Value float64 `json:"value"`
	} `json:"data"`
	// Categories/Series — несколько именованных рядов на общих категориях
	// (например «поступление»/«завершение» по одним и тем же датам). Заданы —
	// имеют приоритет над Data/Type (одиночный ряд). Программная генерация
	// mermaid-кода (chartToMermaid) вместо ручного — модель не может
	// сгенерировать невалидный синтаксис xychart-beta для этого случая.
	Categories []string      `json:"categories"`
	Series     []ChartSeries `json:"series"`
}

type ChartSeries struct {
	Name   string    `json:"name"`
	Type   string    `json:"type"` // bar | line, по умолчанию — ChartSpec.Type, иначе bar
	Values []float64 `json:"values"`
}

type HtmlImage struct {
	URL     string `json:"url"`
	Caption string `json:"caption"`
}

// Paragraph — абзац документа. В JSON может быть строкой (простой текст) ИЛИ
// объектом с полями оформления (2026-08-28).
type Paragraph struct {
	Text      string `json:"text"`
	Align     string `json:"align"`     // left | center | right | justify
	Bold      bool   `json:"bold"`      // жирный
	Italic    bool   `json:"italic"`    // курсив
	Underline bool   `json:"underline"` // подчёркнутый
	Size      *int   `json:"size"`      // размер шрифта, pt
	Highlight string `json:"highlight"` // выделение фона: Word-цвет (yellow, green, …) или hex #RRGGBB
	List      string `json:"list"`      // bullet | number — маркированный/нумерованный список
}

// UnmarshalJSON принимает и строку («текст»), и объект ({text, bold, …}).
func (p *Paragraph) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		p.Text = s
		return nil
	}
	type paragraphAlias Paragraph
	var a paragraphAlias
	if err := json.Unmarshal(b, &a); err != nil {
		return err
	}
	*p = Paragraph(a)
	return nil
}

type Section struct {
	Heading    string      `json:"heading"`
	Level      int         `json:"level"` // уровень заголовка 1–6 (по умолчанию 1)
	Paragraphs []Paragraph `json:"paragraphs"`
	Table      *Table      `json:"table"`
}

type Table struct {
	Headers      []string   `json:"headers"`
	Rows         [][]string `json:"rows"`
	Style        string     `json:"style"`         // plain | grid | fancy (по умолчанию grid)
	ColWidths    []float64  `json:"col_widths"`    // ширины колонок, см (docx)
	RepeatHeader bool       `json:"repeat_header"` // повторять шапку на каждой странице (docx)
}

type Sheet struct {
	Name         string     `json:"name"`
	Headers      []string   `json:"headers"`
	Rows         [][]string `json:"rows"`
	Title        string     `json:"title"`         // титульный ряд (объединённый по ширине листа)
	AutoFilter   bool       `json:"auto_filter"`   // фильтр по колонкам
	FreezeHeader bool       `json:"freeze_header"` // закрепить шапку при прокрутке
	ColWidths    []float64  `json:"col_widths"`    // ширины колонок (excelize width)
	Wrap         bool       `json:"wrap"`          // перенос текста в ячейках
}

type GenerateRequest struct {
	Format string  `json:"format"`
	Spec   DocSpec `json:"spec"`
}

type GenerateResponse struct {
	URL       string            `json:"url"`
	ExpiresAt string            `json:"expires_at"`
	FileName  string            `json:"file_name"`
	Extra     map[string]string `json:"extra,omitempty"`
}

// genFile — сгенерированный файл для загрузки в S3.
type genFile struct {
	key  string
	name string
	kind string // ключ в extra (пусто для основного)
	data []byte
}

// ================= Генерация =================

// acquire занимает слот семафора (очередь без ошибок). Если клиент отключился — ok=false.
func (s *Server) acquire(r *http.Request) (func(), bool) {
	select {
	case s.sem <- struct{}{}:
		return func() { <-s.sem }, true
	case <-r.Context().Done():
		return nil, false
	}
}

func (s *Server) handleGenerate(w http.ResponseWriter, r *http.Request) {
	release, ok := s.acquire(r)
	if !ok {
		return
	}
	defer release()

	var req GenerateRequest
	// Лимит тела (8 МБ — спеку с mermaid-кодом/секциями, ревью 1.4).
	r.Body = http.MaxBytesReader(w, r.Body, 8<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	req.Format = strings.ToLower(strings.TrimSpace(req.Format))
	valid := map[string]bool{"docx": true, "xlsx": true, "pdf": true, "json": true, "mermaid": true, "png": true, "html": true}
	if !valid[req.Format] {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "format must be docx, xlsx, pdf, json, mermaid, png or html"})
		return
	}

	baseName := sanitizeFileName(req.Spec.Title)
	if baseName == "" {
		baseName = "file"
	}

	files, err := s.buildFiles(r.Context(), req.Format, req.Spec, baseName)
	if err != nil {
		log.Printf("generate (%s): %v", req.Format, err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "render error"})
		return
	}

	url := ""
	fileName := ""
	extra := map[string]string{}
	for i, f := range files {
		if _, err := s.s3.Put(r.Context(), f.key, f.data); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "s3 error"})
			return
		}
		link, err := s.s3.Link(r.Context(), f.key, "48h")
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "s3 link error"})
			return
		}
		if i == 0 {
			url = link
			fileName = f.name
		} else if f.kind != "" {
			extra[f.kind] = link
		}
	}

	writeJSON(w, http.StatusOK, GenerateResponse{
		URL:       url,
		ExpiresAt: time.Now().Add(48 * time.Hour).Format(time.RFC3339),
		FileName:  fileName,
		Extra:     extra,
	})
}

// buildFiles формирует файлы для загрузки в S3 по формату и spec.
func (s *Server) buildFiles(ctx context.Context, format string, spec DocSpec, baseName string) ([]genFile, error) {
	base := randomID()
	switch format {
	case "docx":
		data, err := renderDocx(spec)
		if err != nil {
			return nil, err
		}
		return []genFile{{key: "agent/" + base + ".docx", name: baseName + ".docx", data: data}}, nil
	case "xlsx":
		data, err := renderXlsx(spec)
		if err != nil {
			return nil, err
		}
		return []genFile{{key: "agent/" + base + ".xlsx", name: baseName + ".xlsx", data: data}}, nil
	case "pdf":
		data, err := renderPdf(spec)
		if err != nil {
			return nil, err
		}
		return []genFile{{key: "agent/" + base + ".pdf", name: baseName + ".pdf", data: data}}, nil
	case "json":
		data, err := renderJSON(spec)
		if err != nil {
			return nil, err
		}
		return []genFile{{key: "agent/" + base + ".json", name: baseName + ".json", data: data}}, nil
	case "mermaid":
		code := spec.Code
		if code == "" {
			return nil, fmt.Errorf("mermaid code is required")
		}
		pngData, err := renderMermaid(ctx, code, "png")
		if err != nil {
			return nil, err
		}
		svgData, err := renderMermaid(ctx, code, "svg")
		if err != nil {
			return nil, err
		}
		return []genFile{
			{key: "agent/" + base + ".png", name: baseName + ".png", data: pngData},
			{key: "agent/" + base + ".svg", name: baseName + ".svg", kind: "svg", data: svgData},
			{key: "agent/" + base + ".mmd", name: baseName + ".mmd", kind: "mmd", data: []byte(code)},
		}, nil
	case "png":
		var src string
		if spec.Chart != nil {
			src = chartToMermaid(spec.Chart)
		} else {
			src = spec.Mermaid
		}
		if src == "" {
			return nil, fmt.Errorf("png requires chart or mermaid")
		}
		data, err := renderMermaid(ctx, src, "png")
		if err != nil {
			return nil, err
		}
		return []genFile{{key: "agent/" + base + ".png", name: baseName + ".png", data: data}}, nil
	case "html":
		data, err := s.renderHtml(ctx, spec)
		if err != nil {
			return nil, err
		}
		return []genFile{{key: "agent/" + base + ".html", name: baseName + ".html", data: data}}, nil
	}
	return nil, fmt.Errorf("unknown format %s", format)
}

// ================= Разбор (чтение) =================

func (s *Server) handleParse(w http.ResponseWriter, r *http.Request) {
	release, ok := s.acquire(r)
	if !ok {
		return
	}
	defer release()

	if err := r.ParseMultipartForm(64 << 20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid multipart"})
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "file is required"})
		return
	}
	defer file.Close()

	data, err := io.ReadAll(file)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "read file"})
		return
	}

	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(header.Filename), "."))
	// Ревью 2.3: err.Error() раньше утекал клиенту (детали внутренних библиотек,
	// пути, версии). Детали — только в серверный лог, клиенту — общее сообщение.
	switch ext {
	case "docx":
		text, err := parseDocx(data)
		if err != nil {
			log.Printf("parse docx: %v", err)
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "не удалось разобрать документ DOCX"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"kind": "docx", "text": text})
	case "xlsx":
		sheets, err := parseXlsx(data)
		if err != nil {
			log.Printf("parse xlsx: %v", err)
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "не удалось разобрать книгу XLSX"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"kind": "xlsx", "sheets": sheets})
	case "pdf":
		text, err := parsePdf(data)
		if err != nil {
			log.Printf("parse pdf: %v", err)
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "не удалось извлечь текст из PDF"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"kind": "pdf", "text": text})
	case "json":
		var parsed any
		if err := json.Unmarshal(data, &parsed); err != nil {
			log.Printf("parse json: %v", err)
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "не удалось разобрать JSON"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"kind": "json", "data": parsed})
	default:
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "unsupported format: " + ext})
	}
}

// ================= DOCX =================

// Допустимые цвета выделения Word (w:highlight) + поддержка hex-цветов.
var highlightColors = map[string]bool{
	"black": true, "blue": true, "cyan": true, "green": true, "magenta": true,
	"red": true, "yellow": true, "white": true, "darkblue": true, "darkcyan": true,
	"darkgreen": true, "darkmagenta": true, "darkred": true, "darkyellow": true,
	"darkgray": true, "lightgray": true, "none": true,
}

// jcVal маппит выравнивание абзаца в OOXML w:jc.
func jcVal(align string) string {
	switch strings.ToLower(strings.TrimSpace(align)) {
	case "center":
		return "center"
	case "right":
		return "right"
	case "justify", "both":
		return "both"
	default:
		return ""
	}
}

// runPropsXML — свойства начертания/размера/выделения (w:rPr).
func runPropsXML(p Paragraph) string {
	var sb strings.Builder
	if p.Bold {
		sb.WriteString("<w:b/>")
	}
	if p.Italic {
		sb.WriteString("<w:i/>")
	}
	if p.Underline {
		sb.WriteString("<w:u/>")
	}
	if h := strings.ToLower(strings.TrimSpace(p.Highlight)); h != "" {
		if highlightColors[h] {
			sb.WriteString(`<w:highlight w:val="` + h + `"/>`)
		} else if len(h) == 7 && h[0] == '#' {
			// hex-цвет → цвет текста (Word поддерживает выделение только именованными цветами)
			sb.WriteString(`<w:color w:val="` + strings.ToUpper(h[1:]) + `"/>`)
		}
	}
	if p.Size != nil && *p.Size >= 6 && *p.Size <= 96 {
		half := *p.Size * 2
		sb.WriteString(fmt.Sprintf(`<w:sz w:val="%d"/><w:szCs w:val="%d"/>`, half, half))
	}
	if sb.Len() == 0 {
		return ""
	}
	return "<w:rPr>" + sb.String() + "</w:rPr>"
}

// paragraphXML — абзац основного текста (стиль Normal: по ширине, полуторный
// интервал, отступ первой строки 1,25 см) с выравниванием, списком и начертанием.
func paragraphXML(p Paragraph) string {
	var pPr strings.Builder
	pPr.WriteString(`<w:pStyle w:val="Normal"/>`)
	if j := jcVal(p.Align); j != "" {
		pPr.WriteString(`<w:jc w:val="` + j + `"/>`)
	}
	switch p.List {
	case "bullet":
		pPr.WriteString(`<w:ind w:firstLine="0"/>`)
		pPr.WriteString(`<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>`)
	case "number":
		pPr.WriteString(`<w:ind w:firstLine="0"/>`)
		pPr.WriteString(`<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>`)
	}
	var sb strings.Builder
	if pPr.Len() > 0 {
		sb.WriteString("<w:pPr>" + pPr.String() + "</w:pPr>")
	}
	sb.WriteString("<w:r>")
	if rpr := runPropsXML(p); rpr != "" {
		sb.WriteString(rpr)
	}
	sb.WriteString(`<w:t xml:space="preserve">` + escapeXML(p.Text) + `</w:t></w:r>`)
	return "<w:p>" + sb.String() + "</w:p>"
}

// docxTableCellXML — ячейка таблицы Word: шрифт 10pt, одинарный интервал, без
// отступа первой строки; шапка — жирная по центру.
func docxTableCellXML(text string, header bool, shading string) string {
	pPr := `<w:spacing w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/>`
	if header {
		pPr += `<w:jc w:val="center"/>`
	}
	rPr := `<w:rFonts w:ascii="Times New Roman" w:eastAsia="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="20"/><w:szCs w:val="20"/>`
	if header {
		rPr += `<w:b/><w:color w:val="1F3864"/>`
	}
	return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>` + shading + `</w:tcPr>` +
		`<w:p><w:pPr>` + pPr + `</w:pPr><w:r><w:rPr>` + rPr + `</w:rPr><w:t xml:space="preserve">` + escapeXML(text) + `</w:t></w:r></w:p></w:tc>`
}

// headingXML — заголовок уровня 1–6 (центрированный, см. styles.xml).
func headingXML(text string, level int) string {
	if level < 2 || level > 6 {
		level = 1
	}
	return `<w:p><w:pPr><w:pStyle w:val="Heading` + fmt.Sprintf("%d", level) + `"/></w:pPr><w:r><w:t xml:space="preserve">` + escapeXML(text) + `</w:t></w:r></w:p>`
}

// tableXML — таблица со стилями: plain (без границ), grid (границы, по умолчанию),
// fancy (границы + заливка шапки); ширины колонок и повтор шапки — опционально.
func tableXML(t Table) string {
	style := strings.ToLower(strings.TrimSpace(t.Style))
	if style == "" {
		style = "grid"
	}
	var sb strings.Builder
	sb.WriteString(`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>`)
	if style != "plain" {
		sb.WriteString(`<w:tblBorders>`)
		for _, e := range []string{"top", "left", "bottom", "right", "insideH", "insideV"} {
			sb.WriteString(`<w:` + e + ` w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`)
		}
		sb.WriteString(`</w:tblBorders>`)
	}
	sb.WriteString(`</w:tblPr>`)

	cols := len(t.Headers)
	if cols == 0 {
		cols = 1
	}
	if len(t.ColWidths) >= cols {
		sb.WriteString(`<w:tblGrid>`)
		for _, cw := range t.ColWidths {
			w := int(cw * 567) // см → twips (1 см ≈ 567)
			if w < 500 {
				w = 500
			}
			sb.WriteString(fmt.Sprintf(`<w:gridCol w:w="%d"/>`, w))
		}
		sb.WriteString(`</w:tblGrid>`)
	}

	if len(t.Headers) > 0 {
		sb.WriteString(`<w:tr>`)
		if t.RepeatHeader {
			sb.WriteString(`<w:trPr><w:tblHeader/></w:trPr>`)
		}
		shading := ""
		if style == "fancy" {
			shading = `<w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/>`
		}
		for _, h := range t.Headers {
			sb.WriteString(docxTableCellXML(h, true, shading))
		}
		sb.WriteString(`</w:tr>`)
	}
	for _, row := range t.Rows {
		sb.WriteString(`<w:tr>`)
		for _, cell := range row {
			sb.WriteString(docxTableCellXML(cell, false, ""))
		}
		sb.WriteString(`</w:tr>`)
	}
	sb.WriteString(`</w:tbl>`)
	sb.WriteString(`<w:p/>`)
	return sb.String()
}

// numberingXML — определения списков: bullet (numId 1) и decimal (numId 2).
const numberingXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`

// stylesXML — стандартное оформление Word (ГОСТ 7.32/2.105), применяется по
// умолчанию, если пользователь не задал своё: Times New Roman 14pt, полуторный
// интервал (line=360), без интервалов между абзацами, отступ первой строки
// 1,25 см (firstLine=709 twips), выравнивание по ширине; заголовки по центру.
// Явное оформление абзаца (align/bold/size/…) переопределяет эти умолчания.
const stylesXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr>
      <w:rFonts w:ascii="Times New Roman" w:eastAsia="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>
      <w:sz w:val="28"/><w:szCs w:val="28"/>
    </w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr/></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/><w:qFormat/>
    <w:pPr><w:spacing w:before="0" w:after="0" w:line="360" w:lineRule="auto"/><w:ind w:firstLine="709"/><w:jc w:val="both"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Title">
    <w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/>
    <w:pPr><w:spacing w:before="0" w:after="240" w:line="360" w:lineRule="auto"/><w:jc w:val="center"/><w:ind w:firstLine="0"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
    <w:pPr><w:spacing w:before="240" w:after="120" w:line="360" w:lineRule="auto"/><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:outlineLvl w:val="0"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
    <w:pPr><w:spacing w:before="240" w:after="120" w:line="360" w:lineRule="auto"/><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:outlineLvl w:val="1"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
    <w:pPr><w:spacing w:before="240" w:after="120" w:line="360" w:lineRule="auto"/><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:outlineLvl w:val="2"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading4">
    <w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
    <w:pPr><w:spacing w:before="240" w:after="120" w:line="360" w:lineRule="auto"/><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:outlineLvl w:val="3"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading5">
    <w:name w:val="heading 5"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
    <w:pPr><w:spacing w:before="240" w:after="120" w:line="360" w:lineRule="auto"/><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:outlineLvl w:val="4"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading6">
    <w:name w:val="heading 6"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
    <w:pPr><w:spacing w:before="240" w:after="120" w:line="360" w:lineRule="auto"/><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:outlineLvl w:val="5"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>
  </w:style>
</w:styles>`

func renderDocx(spec DocSpec) ([]byte, error) {
	var sb strings.Builder
	sb.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	sb.WriteString(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`)
	sb.WriteString(`<w:body>`)
	if spec.Title != "" {
		sb.WriteString(`<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t xml:space="preserve">`)
		sb.WriteString(escapeXML(spec.Title))
		sb.WriteString(`</w:t></w:r></w:p>`)
	}
	for _, s := range spec.Sections {
		if s.Heading != "" {
			sb.WriteString(headingXML(s.Heading, s.Level))
		}
		for _, p := range s.Paragraphs {
			sb.WriteString(paragraphXML(p))
		}
		if s.Table != nil && len(s.Table.Headers) > 0 {
			sb.WriteString(tableXML(*s.Table))
		}
	}
	// Поля страницы (ГОСТ): левое 30 мм (1701 twips), правое 10 мм (567),
	// верхнее/нижнее 20 мм (1134).
	sb.WriteString(`<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="567" w:bottom="1134" w:left="1701" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`)
	sb.WriteString(`</w:body></w:document>`)

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	ct := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`
	rels := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
	docRels := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
	files := map[string]string{
		"[Content_Types].xml":          ct,
		"_rels/.rels":                  rels,
		"word/_rels/document.xml.rels": docRels,
		"word/numbering.xml":           numberingXML,
		"word/styles.xml":              stylesXML,
		"word/document.xml":            sb.String(),
	}
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			return nil, err
		}
		if _, err := w.Write([]byte(content)); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

var tagRe = regexp.MustCompile(`<[^>]+>`)

func parseDocx(data []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", err
	}
	var docXML string
	for _, f := range zr.File {
		if f.Name != "word/document.xml" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return "", err
		}
		b, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			return "", err
		}
		docXML = string(b)
		break
	}
	if docXML == "" {
		return "", fmt.Errorf("word/document.xml not found")
	}
	docXML = strings.ReplaceAll(docXML, "</w:p>", "\n")
	docXML = strings.ReplaceAll(docXML, "</w:tr>", "\n")
	docXML = strings.ReplaceAll(docXML, "</w:tc>", "\t")
	docXML = tagRe.ReplaceAllString(docXML, "")
	return strings.TrimSpace(docXML), nil
}

// ================= XLSX =================

func renderXlsx(spec DocSpec) ([]byte, error) {
	f := excelize.NewFile()
	defer f.Close()

	if len(spec.Sheets) == 0 {
		f.SetSheetName("Sheet1", "Данные")
		buf, err := f.WriteToBuffer()
		if err != nil {
			return nil, err
		}
		return buf.Bytes(), nil
	}

	first := spec.Sheets[0]
	f.SetSheetName("Sheet1", sheetName(first.Name))
	writeXlsxSheet(f, sheetName(first.Name), first)
	for i := 1; i < len(spec.Sheets); i++ {
		sh := spec.Sheets[i]
		name := sheetName(sh.Name)
		if _, err := f.NewSheet(name); err != nil {
			continue
		}
		writeXlsxSheet(f, name, sh)
	}
	buf, err := f.WriteToBuffer()
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func sheetName(name string) string {
	n := strings.TrimSpace(name)
	if n == "" {
		return "Лист"
	}
	if len(n) > 31 {
		n = n[:31]
	}
	return n
}

// thinBorders — тонкие серые границы для ячеек таблицы.
func thinBorders() []excelize.Border {
	return []excelize.Border{
		{Type: "left", Style: 1, Color: "BFBFBF"},
		{Type: "right", Style: 1, Color: "BFBFBF"},
		{Type: "top", Style: 1, Color: "BFBFBF"},
		{Type: "bottom", Style: 1, Color: "BFBFBF"},
	}
}

func writeXlsxSheet(f *excelize.File, name string, sh Sheet) {
	// Стили: титульный ряд, шапка, данные.
	titleStyle, _ := f.NewStyle(&excelize.Style{
		Font:      &excelize.Font{Bold: true, Size: 14, Color: "1F3864"},
		Fill:      excelize.Fill{Type: "pattern", Pattern: 1, Color: []string{"D9E2F3"}},
		Alignment: &excelize.Alignment{Horizontal: "center", Vertical: "center"},
		Border:    thinBorders(),
	})
	headerStyle, _ := f.NewStyle(&excelize.Style{
		Font:      &excelize.Font{Bold: true, Color: "FFFFFF"},
		Fill:      excelize.Fill{Type: "pattern", Pattern: 1, Color: []string{"4472C4"}},
		Alignment: &excelize.Alignment{Horizontal: "center", Vertical: "center", WrapText: sh.Wrap},
		Border:    thinBorders(),
	})
	dataStyle, _ := f.NewStyle(&excelize.Style{
		Alignment: &excelize.Alignment{Vertical: "top", WrapText: sh.Wrap},
		Border:    thinBorders(),
	})

	rowOffset := 0
	if sh.Title != "" {
		cols := len(sh.Headers)
		if cols == 0 {
			cols = 1
		}
		lastLetter, _ := excelize.ColumnNumberToName(cols)
		_ = f.SetCellValue(name, "A1", sh.Title)
		_ = f.MergeCell(name, "A1", fmt.Sprintf("%s1", lastLetter))
		_ = f.SetCellStyle(name, "A1", fmt.Sprintf("%s1", lastLetter), titleStyle)
		_ = f.SetRowHeight(name, 1, 24)
		rowOffset = 1
	}

	headerRow := rowOffset + 1
	if len(sh.Headers) > 0 {
		for c, h := range sh.Headers {
			cell, err := excelize.CoordinatesToCellName(c+1, headerRow)
			if err != nil {
				continue
			}
			_ = f.SetCellValue(name, cell, h)
		}
		lastLetter, _ := excelize.ColumnNumberToName(len(sh.Headers))
		_ = f.SetCellStyle(name, fmt.Sprintf("A%d", headerRow), fmt.Sprintf("%s%d", lastLetter, headerRow), headerStyle)
		_ = f.SetRowHeight(name, headerRow, 20)
	}

	for i, r := range sh.Rows {
		if len(r) == 0 {
			continue
		}
		rowNum := headerRow + 1 + i
		for c, v := range r {
			cell, err := excelize.CoordinatesToCellName(c+1, rowNum)
			if err != nil {
				continue
			}
			_ = f.SetCellValue(name, cell, v)
		}
		start, _ := excelize.CoordinatesToCellName(1, rowNum)
		end, _ := excelize.CoordinatesToCellName(len(r), rowNum)
		_ = f.SetCellStyle(name, start, end, dataStyle)
	}

	if len(sh.ColWidths) > 0 {
		for c, w := range sh.ColWidths {
			if w <= 0 {
				continue
			}
			colLetter, _ := excelize.ColumnNumberToName(c + 1)
			_ = f.SetColWidth(name, colLetter, colLetter, w)
		}
	}

	if sh.FreezeHeader {
		_ = f.SetPanes(name, &excelize.Panes{
			Freeze:      true,
			Split:       false,
			XSplit:      0,
			YSplit:      headerRow,
			TopLeftCell: fmt.Sprintf("A%d", headerRow+1),
			ActivePane:  "bottomLeft",
		})
	}

	if sh.AutoFilter && len(sh.Headers) > 0 {
		lastRow := headerRow + len(sh.Rows)
		lastLetter, _ := excelize.ColumnNumberToName(len(sh.Headers))
		_ = f.AutoFilter(name, fmt.Sprintf("A%d:%s%d", headerRow, lastLetter, lastRow), []excelize.AutoFilterOptions{})
	}
}

func parseXlsx(data []byte) ([]any, error) {
	f, err := excelize.OpenReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	defer f.Close()

	sheets := make([]any, 0, len(f.GetSheetList()))
	for _, name := range f.GetSheetList() {
		rows, err := f.GetRows(name)
		if err != nil {
			continue
		}
		sheets = append(sheets, map[string]any{"name": name, "rows": rows})
	}
	return sheets, nil
}

// ================= PDF =================

// pdfFontStyle — строка стиля шрифта fpdf по начертанию абзаца.
func pdfFontStyle(p Paragraph) string {
	switch {
	case p.Bold && p.Italic:
		return "BI"
	case p.Bold:
		return "B"
	case p.Italic:
		return "I"
	default:
		return ""
	}
}

func renderPdf(spec DocSpec) ([]byte, error) {
	pdfDoc := fpdf.New("P", "mm", "A4", "")
	pdfDoc.AddUTF8FontFromBytes("DejaVu", "", dejaVuFont)
	pdfDoc.AddUTF8FontFromBytes("DejaVu", "B", dejaVuFontBold)
	pdfDoc.AddUTF8FontFromBytes("DejaVu", "I", dejaVuFont)
	pdfDoc.AddUTF8FontFromBytes("DejaVu", "BI", dejaVuFontBold)
	pdfDoc.SetMargins(15, 15, 15)
	pdfDoc.AddPage()
	if spec.Title != "" {
		pdfDoc.SetFont("DejaVu", "B", 18)
		pdfDoc.Cell(0, 10, spec.Title)
		pdfDoc.Ln(14)
	}
	for _, s := range spec.Sections {
		if s.Heading != "" {
			level := s.Level
			if level < 1 || level > 6 {
				level = 1
			}
			size := 16 - (level-1)*2
			if size < 11 {
				size = 11
			}
			pdfDoc.SetFont("DejaVu", "B", float64(size))
			pdfDoc.Cell(0, 8, s.Heading)
			pdfDoc.Ln(float64(size/2 + 4))
		}
		for _, p := range s.Paragraphs {
			// список → префикс-маркер/номер
			text := p.Text
			if p.List == "bullet" {
				text = "•  " + text
			} else if p.List == "number" {
				text = "1.  " + text
			}
			size := 11.0
			if p.Size != nil && *p.Size >= 6 && *p.Size <= 96 {
				size = float64(*p.Size)
			}
			pdfDoc.SetFont("DejaVu", pdfFontStyle(p), size)
			align := "L"
			switch strings.ToLower(strings.TrimSpace(p.Align)) {
			case "center":
				align = "C"
			case "right":
				align = "R"
			case "justify", "both":
				align = "J"
			}
			pdfDoc.MultiCell(0, size/2+1, text, "", align, false)
			pdfDoc.Ln(2)
		}
		if s.Table != nil && len(s.Table.Headers) > 0 {
			style := strings.ToLower(strings.TrimSpace(s.Table.Style))
			if style == "" {
				style = "grid"
			}
			width := 170.0 / float64(len(s.Table.Headers))
			// шапка
			if style == "fancy" {
				pdfDoc.SetFillColor(217, 226, 243)
			} else {
				pdfDoc.SetFillColor(242, 242, 242)
			}
			pdfDoc.SetFont("DejaVu", "B", 9)
			pdfDoc.SetTextColor(31, 56, 100)
			for _, h := range s.Table.Headers {
				border := "1"
				fill := false
				if style == "plain" {
					border = ""
				} else {
					fill = true
				}
				pdfDoc.CellFormat(width, 7, h, border, 0, "C", fill, 0, "")
			}
			pdfDoc.Ln(7)
			// данные
			pdfDoc.SetFont("DejaVu", "", 9)
			pdfDoc.SetTextColor(0, 0, 0)
			for _, row := range s.Table.Rows {
				for _, cell := range row {
					pdfDoc.CellFormat(width, 6, cell, "1", 0, "L", false, 0, "")
				}
				pdfDoc.Ln(6)
			}
			pdfDoc.Ln(4)
		}
	}
	var buf bytes.Buffer
	if err := pdfDoc.Output(&buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func parsePdf(data []byte) (string, error) {
	r, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", err
	}
	textReader, err := r.GetPlainText()
	if err != nil {
		return "", err
	}
	b, err := io.ReadAll(textReader)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

// ================= JSON =================

func renderJSON(spec DocSpec) ([]byte, error) {
	payload := spec.Data
	if payload == nil {
		payload = spec
	}
	return json.MarshalIndent(payload, "", "  ")
}

// ================= Общие хелперы =================

func escapeXML(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;")
	return r.Replace(s)
}
