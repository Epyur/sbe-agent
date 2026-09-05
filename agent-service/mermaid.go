package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

// ================= Mermaid-рендер (через agent-mermaid) =================

func renderMermaid(ctx context.Context, code, format string) ([]byte, error) {
	base := os.Getenv("MERMAID_SERVICE_URL")
	if base == "" {
		base = "http://agent-mermaid:3000"
	}
	body, err := json.Marshal(map[string]string{"code": code, "format": format})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/render", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	// Общий токен с agent-mermaid (ревью 2.4): без него рендер открыт любому
	// контейнеру в docker-сети.
	if tok := os.Getenv("MERMAID_AUTH_TOKEN"); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	client := &http.Client{Timeout: 90 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("agent-mermaid status %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	return io.ReadAll(resp.Body)
}

// ================= Графики → mermaid (xychart-beta / pie) =================

func chartToMermaid(c *ChartSpec) string {
	var sb strings.Builder
	if len(c.Series) > 0 {
		// Несколько именованных рядов на общих категориях (например
		// «поступление»/«завершение» по датам) — mermaid xychart-beta НЕ
		// поддерживает оператор legend (в отличие от других диаграмм mermaid);
		// имя ряда записываем комментарием %% в исходнике для человека,
		// визуально ряды различаются цветом самого mermaid.
		sb.WriteString("xychart-beta\n")
		if c.Title != "" {
			sb.WriteString("  title \"" + c.Title + "\"\n")
		}
		labels := make([]string, 0, len(c.Categories))
		for _, l := range c.Categories {
			labels = append(labels, "\""+l+"\"")
		}
		sb.WriteString("  x-axis [" + strings.Join(labels, ", ") + "]\n")
		sb.WriteString("  y-axis \"value\"\n")
		for _, s := range c.Series {
			t := s.Type
			if t == "" {
				t = c.Type
			}
			if t != "line" {
				t = "bar"
			}
			values := make([]string, 0, len(s.Values))
			for _, v := range s.Values {
				values = append(values, fmt.Sprintf("%g", v))
			}
			sb.WriteString("  " + t + " [" + strings.Join(values, ", ") + "]")
			if s.Name != "" {
				sb.WriteString(" %% " + s.Name)
			}
			sb.WriteString("\n")
		}
		return sb.String()
	}
	switch c.Type {
	case "pie":
		sb.WriteString("pie showData\n")
		if c.Title != "" {
			sb.WriteString("  title " + c.Title + "\n")
		}
		for _, d := range c.Data {
			fmt.Fprintf(&sb, "  \"%s\" : %g\n", d.Label, d.Value)
		}
	case "bar", "line":
		sb.WriteString("xychart-beta\n")
		if c.Title != "" {
			sb.WriteString("  title \"" + c.Title + "\"\n")
		}
		labels := make([]string, 0, len(c.Data))
		values := make([]string, 0, len(c.Data))
		for _, d := range c.Data {
			labels = append(labels, "\""+d.Label+"\"")
			values = append(values, fmt.Sprintf("%g", d.Value))
		}
		sb.WriteString("  x-axis [" + strings.Join(labels, ", ") + "]\n")
		sb.WriteString("  y-axis \"value\"\n")
		if c.Type == "bar" {
			sb.WriteString("  bar [" + strings.Join(values, ", ") + "]\n")
		} else {
			sb.WriteString("  line [" + strings.Join(values, ", ") + "]\n")
		}
	default:
		sb.WriteString("pie showData\n")
		for _, d := range c.Data {
			fmt.Fprintf(&sb, "  \"%s\" : %g\n", d.Label, d.Value)
		}
	}
	return sb.String()
}

// ================= HTML =================

// renderHtml собирает самодостаточный HTML: base64-изображения (url -> data URI),
// inline SVG, mermaid-блоки (рендерятся сервером в SVG и встраиваются).
func (s *Server) renderHtml(ctx context.Context, spec DocSpec) ([]byte, error) {
	var sb strings.Builder
	sb.WriteString(`<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">`)
	sb.WriteString(`<title>` + escapeHTML(spec.Title) + `</title>`)
	sb.WriteString(`<style>body{font-family:sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#171725}h1{border-bottom:2px solid #E11B17;padding-bottom:8px}.img-block{margin:12px 0}.img-block img{max-width:100%;border:1px solid #ddd;border-radius:6px}.cap{color:#667387;font-size:13px;margin-top:4px}.diagram{margin:16px 0;overflow-x:auto}table{border-collapse:collapse;margin:12px 0}th,td{border:1px solid #ddd;padding:6px 10px;text-align:left}th{background:#f5f5f7}</style></head><body>`)
	sb.WriteString(`<h1>` + escapeHTML(spec.Title) + `</h1>`)
	for _, sct := range spec.Sections {
		if sct.Heading != "" {
			sb.WriteString(`<h2>` + escapeHTML(sct.Heading) + `</h2>`)
		}
		for _, p := range sct.Paragraphs {
			sb.WriteString(`<p>` + escapeHTML(p.Text) + `</p>`)
		}
		if sct.Table != nil && len(sct.Table.Headers) > 0 {
			sb.WriteString(`<table><thead><tr>`)
			for _, h := range sct.Table.Headers {
				sb.WriteString(`<th>` + escapeHTML(h) + `</th>`)
			}
			sb.WriteString(`</tr></thead><tbody>`)
			for _, row := range sct.Table.Rows {
				sb.WriteString(`<tr>`)
				for _, cell := range row {
					sb.WriteString(`<td>` + escapeHTML(cell) + `</td>`)
				}
				sb.WriteString(`</tr>`)
			}
			sb.WriteString(`</tbody></table>`)
		}
	}
	for _, img := range spec.Images {
		data, err := s.fetchImageBytes(ctx, img.URL)
		if err != nil {
			log.Printf("html: image fetch failed: %v", err)
			continue
		}
		dataURI := "data:image/png;base64," + base64.StdEncoding.EncodeToString(data)
		sb.WriteString(`<div class="img-block"><img src="` + escapeAttr(dataURI) + `" alt="">`)
		if img.Caption != "" {
			sb.WriteString(`<div class="cap">` + escapeHTML(img.Caption) + `</div>`)
		}
		sb.WriteString(`</div>`)
	}
	for _, svg := range spec.Svgs {
		sb.WriteString(`<div class="diagram">` + svg + `</div>`)
	}
	for _, code := range spec.MermaidBlocks {
		svg, err := renderMermaid(ctx, code, "svg")
		if err != nil {
			log.Printf("html: mermaid render failed: %v", err)
			continue
		}
		sb.WriteString(`<div class="diagram">` + string(svg) + `</div>`)
	}
	sb.WriteString(`</body></html>`)
	return []byte(sb.String()), nil
}

// fetchImageBytes скачивает изображение для встраивания в HTML (только S3-ссылки agent).
func (s *Server) fetchImageBytes(ctx context.Context, url string) ([]byte, error) {
	if !strings.HasPrefix(url, "https://s3.firstvds.ru/") {
		return nil, fmt.Errorf("image url must be S3")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("image status %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

func escapeHTML(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;", "'", "&#39;").Replace(s)
}

func escapeAttr(s string) string {
	return strings.NewReplacer("&", "&amp;", "\"", "&quot;", "<", "&lt;", ">", "&gt;").Replace(s)
}
