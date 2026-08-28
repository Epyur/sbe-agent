package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"io"
	"strings"
	"testing"

	"github.com/go-pdf/fpdf"
)

func sampleSpec() DocSpec {
	return DocSpec{
		Title: "Отчёт по испытаниям",
		Sections: []Section{
			{Heading: "Введение", Paragraphs: []Paragraph{{Text: "Проведены испытания образцов."}}},
			{Heading: "Результаты", Paragraphs: []Paragraph{{Text: "Итоги в таблице ниже."}},
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

// ================= Оформление (2026-08-28) =================

// readZipEntry достаёт запись из OOXML-архива.
func readZipEntry(t *testing.T, data []byte, name string) string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("zip: %v", err)
	}
	for _, f := range zr.File {
		if f.Name != name {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open %s: %v", name, err)
		}
		b, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		return string(b)
	}
	t.Fatalf("entry %s not found", name)
	return ""
}

// Параграф принимает и строку, и объект оформления (обратная совместимость).
func TestParagraphUnmarshal(t *testing.T) {
	var p Paragraph
	if err := json.Unmarshal([]byte(`"простой текст"`), &p); err != nil {
		t.Fatalf("string unmarshal: %v", err)
	}
	if p.Text != "простой текст" || p.Bold {
		t.Errorf("string paragraph wrong: %+v", p)
	}
	var o Paragraph
	if err := json.Unmarshal([]byte(`{"text":"жирный","align":"center","bold":true,"list":"bullet"}`), &o); err != nil {
		t.Fatalf("object unmarshal: %v", err)
	}
	if o.Text != "жирный" || o.Align != "center" || !o.Bold || o.List != "bullet" {
		t.Errorf("object paragraph wrong: %+v", o)
	}
}

func TestRenderDocxFormatting(t *testing.T) {
	size := 14
	spec := DocSpec{
		Title: "Форматный документ",
		Sections: []Section{
			{Heading: "Введение", Level: 1},
			{Heading: "Подраздел", Level: 3},
			{
				Paragraphs: []Paragraph{
					{Text: "Жирный по центру", Align: "center", Bold: true, Highlight: "yellow"},
					{Text: "Пункт списка", List: "bullet"},
					{Text: "Курсив размер", Italic: true, Size: &size},
				},
			},
			{
				Table: &Table{
					Headers:      []string{"A", "B"},
					Rows:         [][]string{{"1", "2"}},
					Style:        "fancy",
					RepeatHeader: true,
					ColWidths:    []float64{4, 6},
				},
			},
		},
	}
	data, err := renderDocx(spec)
	if err != nil {
		t.Fatalf("renderDocx: %v", err)
	}
	doc := readZipEntry(t, data, "word/document.xml")
	for _, want := range []string{
		`w:val="Heading3"`,                    // иерархия заголовков
		`w:val="center"`,                      // выравнивание
		`<w:b/>`,                              // жирный
		`<w:i/>`,                              // курсив
		`w:highlight w:val="yellow"`,          // выделение
		`w:sz w:val="28"`,                     // размер 14pt (полу-пункты)
		`w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"`, // список-маркер
		`w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"`, // заливка шапки fancy
		`<w:tblHeader/>`,                      // повтор шапки
		`<w:gridCol w:w="2268"/>`,             // ширина колонки 4 см
	} {
		if !strings.Contains(doc, want) {
			t.Errorf("docx missing %q", want)
		}
	}
	if !strings.Contains(readZipEntry(t, data, "word/numbering.xml"), `w:numId="2"`) {
		t.Error("numbering.xml: нет нумерованного списка")
	}
	if !strings.Contains(readZipEntry(t, data, "word/_rels/document.xml.rels"), "numbering.xml") {
		t.Error("document.xml.rels: нет связи numbering")
	}
	// старый текст по-прежнему извлекается
	text, err := parseDocx(data)
	if err != nil {
		t.Fatalf("parseDocx: %v", err)
	}
	for _, want := range []string{"Форматный документ", "Введение", "Подраздел", "Жирный по центру", "Пункт списка"} {
		if !strings.Contains(text, want) {
			t.Errorf("docx text missing %q", want)
		}
	}
}

func TestRenderXlsxFormatting(t *testing.T) {
	spec := DocSpec{Sheets: []Sheet{
		{
			Name:         "Данные",
			Title:        "Итоги испытаний",
			Headers:      []string{"Показатель", "Значение"},
			Rows:         [][]string{{"Прочность", "25"}, {"Время", "3"}},
			AutoFilter:   true,
			FreezeHeader: true,
			ColWidths:    []float64{20, 12},
			Wrap:         true,
		},
	}}
	data, err := renderXlsx(spec)
	if err != nil {
		t.Fatalf("renderXlsx: %v", err)
	}
	sheet := readZipEntry(t, data, "xl/worksheets/sheet1.xml")
	for _, want := range []string{
		`<autoFilter ref="$A$2:$B$4"`, // фильтр по колонкам
		`state="frozen"`,              // закрепление шапки
		`topLeftCell="A3"`,            // первая видимая строка после шапки
		`<mergeCell ref="A1:B1">`,     // объединённый титульный ряд
		`width="20"`,                  // ширина колонки
	} {
		if !strings.Contains(sheet, want) {
			t.Errorf("xlsx missing %q", want)
		}
	}
	styles := readZipEntry(t, data, "xl/styles.xml")
	if !strings.Contains(styles, "FF4472C4") { // заливка шапки
		t.Error("styles.xml: нет заливки шапки")
	}
	if !strings.Contains(styles, `<b val="1">`) { // жирная шапка
		t.Error("styles.xml: нет жирного начертания")
	}
	// данные по-прежнему читаются
	sheets, err := parseXlsx(data)
	if err != nil {
		t.Fatalf("parseXlsx: %v", err)
	}
	joined := strings.Join(strings.Fields(strings.ReplaceAll(toJSON(t, sheets), " ", "")), " ")
	if !strings.Contains(joined, "Прочность") {
		t.Errorf("xlsx parse missing content: %v", sheets)
	}
}

func TestRenderDocxGostDefaults(t *testing.T) {
	spec := DocSpec{
		Title: "Протокол",
		Sections: []Section{
			{Heading: "Раздел 1", Level: 1},
			{Paragraphs: []Paragraph{{Text: "Обычный абзац без явного оформления."}}},
			{Table: &Table{Headers: []string{"A"}, Rows: [][]string{{"x"}}, Style: "grid"}},
		},
	}
	data, err := renderDocx(spec)
	if err != nil {
		t.Fatalf("renderDocx: %v", err)
	}
	doc := readZipEntry(t, data, "word/document.xml")
	for _, want := range []string{
		`w:pgMar w:top="1134" w:right="567" w:bottom="1134" w:left="1701"`, // поля 20/10/20/30 мм
		`<w:pStyle w:val="Normal"/>`,                                       // базовый стиль абзаца
	} {
		if !strings.Contains(doc, want) {
			t.Errorf("docx missing %q", want)
		}
	}
	styles := readZipEntry(t, data, "word/styles.xml")
	for _, want := range []string{
		`Times New Roman`,                    // шрифт по умолчанию
		`<w:sz w:val="28"`,                   // кегль 14pt
		`w:line="360" w:lineRule="auto"`,     // полуторный интервал
		`w:firstLine="709"`,                  // отступ первой строки 1,25 см
		`<w:jc w:val="both"/>`,               // выравнивание по ширине
		`w:jc w:val="center"`,                // заголовки по центру
	} {
		if !strings.Contains(styles, want) {
			t.Errorf("styles.xml missing %q", want)
		}
	}
	if !strings.Contains(readZipEntry(t, data, "word/_rels/document.xml.rels"), "styles.xml") {
		t.Error("document.xml.rels: нет связи styles.xml")
	}
	if !strings.Contains(readZipEntry(t, data, "[Content_Types].xml"), "styles+xml") {
		t.Error("[Content_Types].xml: нет override для styles.xml")
	}
	// ячейки таблицы — 10pt (sz=20), обычный абзац без явного jc наследует Normal
	if !strings.Contains(doc, `<w:sz w:val="20"/>`) {
		t.Error("docx: ячейки таблицы не переведены на 10pt")
	}
	// все XML-части OOXML-пакета — корректный well-formed XML (Word откроет файл)
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("zip: %v", err)
	}
	for _, f := range zr.File {
		if !strings.HasSuffix(f.Name, ".xml") && !strings.HasSuffix(f.Name, ".rels") {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open %s: %v", f.Name, err)
		}
		b, _ := io.ReadAll(rc)
		rc.Close()
		if err := xml.Unmarshal(b, new(any)); err != nil {
			t.Errorf("part %s невалидный XML: %v", f.Name, err)
		}
	}
}

func toJSON(t *testing.T, v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}
