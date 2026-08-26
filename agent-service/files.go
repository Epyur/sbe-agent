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
}

type HtmlImage struct {
	URL     string `json:"url"`
	Caption string `json:"caption"`
}

type Section struct {
	Heading    string   `json:"heading"`
	Paragraphs []string `json:"paragraphs"`
	Table      *Table   `json:"table"`
}

type Table struct {
	Headers []string   `json:"headers"`
	Rows    [][]string `json:"rows"`
}

type Sheet struct {
	Name    string     `json:"name"`
	Headers []string   `json:"headers"`
	Rows    [][]string `json:"rows"`
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
			sb.WriteString(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">`)
			sb.WriteString(escapeXML(s.Heading))
			sb.WriteString(`</w:t></w:r></w:p>`)
		}
		for _, p := range s.Paragraphs {
			sb.WriteString(`<w:p><w:r><w:t xml:space="preserve">`)
			sb.WriteString(escapeXML(p))
			sb.WriteString(`</w:t></w:r></w:p>`)
		}
		if s.Table != nil && len(s.Table.Headers) > 0 {
			sb.WriteString(`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>`)
			sb.WriteString(`<w:tr>`)
			for _, h := range s.Table.Headers {
				sb.WriteString(`<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p><w:r><w:b/><w:t xml:space="preserve">`)
				sb.WriteString(escapeXML(h))
				sb.WriteString(`</w:t></w:r></w:p></w:tc>`)
			}
			sb.WriteString(`</w:tr>`)
			for _, row := range s.Table.Rows {
				sb.WriteString(`<w:tr>`)
				for _, cell := range row {
					sb.WriteString(`<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p><w:r><w:t xml:space="preserve">`)
					sb.WriteString(escapeXML(cell))
					sb.WriteString(`</w:t></w:r></w:p></w:tc>`)
				}
				sb.WriteString(`</w:tr>`)
			}
			sb.WriteString(`</w:tbl>`)
			sb.WriteString(`<w:p/>`)
		}
	}
	sb.WriteString(`<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>`)
	sb.WriteString(`</w:body></w:document>`)

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	ct := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
	rels := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
	files := map[string]string{
		"[Content_Types].xml": ct,
		"_rels/.rels":         rels,
		"word/document.xml":   sb.String(),
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

func writeXlsxSheet(f *excelize.File, name string, sh Sheet) {
	if len(sh.Headers) > 0 {
		row := make([]any, 0, len(sh.Headers))
		for _, h := range sh.Headers {
			row = append(row, h)
		}
		_ = f.SetSheetRow(name, "A1", &row)
	}
	for i, r := range sh.Rows {
		cell, err := excelize.CoordinatesToCellName(1, i+2)
		if err != nil {
			continue
		}
		row := make([]any, 0, len(r))
		for _, v := range r {
			row = append(row, v)
		}
		_ = f.SetSheetRow(name, cell, &row)
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

func renderPdf(spec DocSpec) ([]byte, error) {
	pdfDoc := fpdf.New("P", "mm", "A4", "")
	pdfDoc.AddUTF8FontFromBytes("DejaVu", "", dejaVuFont)
	pdfDoc.AddUTF8FontFromBytes("DejaVu", "B", dejaVuFontBold)
	pdfDoc.SetMargins(15, 15, 15)
	pdfDoc.AddPage()
	if spec.Title != "" {
		pdfDoc.SetFont("DejaVu", "B", 18)
		pdfDoc.Cell(0, 10, spec.Title)
		pdfDoc.Ln(14)
	}
	for _, s := range spec.Sections {
		if s.Heading != "" {
			pdfDoc.SetFont("DejaVu", "B", 14)
			pdfDoc.Cell(0, 8, s.Heading)
			pdfDoc.Ln(10)
		}
		pdfDoc.SetFont("DejaVu", "", 11)
		for _, p := range s.Paragraphs {
			pdfDoc.MultiCell(0, 6, p, "", "", false)
			pdfDoc.Ln(3)
		}
		if s.Table != nil && len(s.Table.Headers) > 0 {
			width := 170.0 / float64(len(s.Table.Headers))
			pdfDoc.SetFont("DejaVu", "B", 9)
			for _, h := range s.Table.Headers {
				pdfDoc.CellFormat(width, 7, h, "1", 0, "L", false, 0, "")
			}
			pdfDoc.Ln(7)
			pdfDoc.SetFont("DejaVu", "", 9)
			for _, row := range s.Table.Rows {
				for _, cell := range row {
					pdfDoc.CellFormat(width, 6, cell, "1", 0, "L", false, 0, "")
				}
				pdfDoc.Ln(6)
			}
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
