package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/go-pdf/fpdf"
)

func sampleSpec() DocSpec {
	return DocSpec{
		Title: "Отчёт по испытаниям",
		Sections: []Section{
			{Heading: "Введение", Paragraphs: []string{"Проведены испытания образцов."}},
			{Heading: "Результаты", Paragraphs: []string{"Итоги в таблице ниже."},
				Table: &Table{Headers: []string{"Показатель", "Значение"}, Rows: [][]string{{"Прочность", "25 МПа"}, {"Время", "3 ч"}}}},
		},
		Sheets: []Sheet{
			{Name: "Данные", Headers: []string{"№", "Имя"}, Rows: [][]string{{"1", "Иванов"}, {"2", "Петров"}}},
		},
		Data: map[string]any{"ok": true, "n": 5},
	}
}

func TestRenderDocxAndParse(t *testing.T) {
	spec := sampleSpec()
	data, err := renderDocx(spec)
	if err != nil {
		t.Fatalf("renderDocx: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("docx empty")
	}
	text, err := parseDocx(data)
	if err != nil {
		t.Fatalf("parseDocx: %v", err)
	}
	for _, want := range []string{"Отчёт по испытаниям", "Введение", "Прочность"} {
		if !strings.Contains(text, want) {
			t.Errorf("docx text missing %q; got:\n%s", want, text)
		}
	}
}

func TestRenderXlsxAndParse(t *testing.T) {
	spec := sampleSpec()
	data, err := renderXlsx(spec)
	if err != nil {
		t.Fatalf("renderXlsx: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("xlsx empty")
	}
	sheets, err := parseXlsx(data)
	if err != nil {
		t.Fatalf("parseXlsx: %v", err)
	}
	if len(sheets) != 1 {
		t.Fatalf("expected 1 sheet, got %d", len(sheets))
	}
	joined := strings.Join(strings.Fields(strings.ReplaceAll(toJSON(t, sheets), " ", "")), " ")
	if !strings.Contains(joined, "Иванов") || !strings.Contains(joined, "Петров") {
		t.Errorf("xlsx parse missing rows: %v", sheets)
	}
}

func TestRenderPdfAndParse(t *testing.T) {
	spec := sampleSpec()
	data, err := renderPdf(spec)
	if err != nil {
		t.Fatalf("renderPdf: %v", err)
	}
	if len(data) == 0 || !bytes.HasPrefix(data, []byte("%PDF")) {
		t.Fatalf("pdf invalid header, len=%d", len(data))
	}
}

// parsePdf должен извлекать текст из «электронных» PDF со стандартной кодировкой
// (fpdf со встроенным Helvetica + ASCII даёт WinAnsiEncoding — читается ledongthuc).
func TestParsePdfStandard(t *testing.T) {
	p := fpdf.New("P", "mm", "A4", "")
	p.AddPage()
	p.SetFont("Helvetica", "", 12)
	p.Cell(0, 10, "Hello PDF 123")
	var buf bytes.Buffer
	if err := p.Output(&buf); err != nil {
		t.Fatalf("make pdf: %v", err)
	}
	text, err := parsePdf(buf.Bytes())
	if err != nil {
		t.Fatalf("parsePdf: %v", err)
	}
	if !strings.Contains(text, "Hello PDF 123") {
		t.Errorf("pdf text missing content: %q", text)
	}
}

func TestRenderJson(t *testing.T) {
	spec := sampleSpec()
	data, err := renderJSON(spec)
	if err != nil {
		t.Fatalf("renderJSON: %v", err)
	}
	if !strings.Contains(string(data), `"ok": true`) {
		t.Errorf("json wrong: %s", string(data))
	}
}

func toJSON(t *testing.T, v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}
