package main

import (
	"strings"
	"testing"
)

func TestChartToMermaidMultiSeries(t *testing.T) {
	spec := &ChartSpec{
		Title:      "Заявки за август",
		Categories: []string{"01", "02", "03"},
		Series: []ChartSeries{
			{Name: "поступление", Type: "bar", Values: []float64{2, 0, 1}},
			{Name: "завершение", Type: "line", Values: []float64{0, 1, 1}},
		},
	}
	code := chartToMermaid(spec)

	if !strings.HasPrefix(code, "xychart-beta\n") {
		t.Fatalf("expected xychart-beta header, got: %s", code)
	}
	if !strings.Contains(code, `x-axis ["01", "02", "03"]`) {
		t.Fatalf("categories not rendered correctly: %s", code)
	}
	if !strings.Contains(code, "bar [2, 0, 1]") {
		t.Fatalf("bar series missing/incorrect: %s", code)
	}
	if !strings.Contains(code, "line [0, 1, 1]") {
		t.Fatalf("line series missing/incorrect: %s", code)
	}
	if strings.Contains(code, "\n  legend") || strings.Contains(code, " legend\n") {
		t.Fatalf("mermaid xychart-beta has no legend statement, must never be emitted: %s", code)
	}
}

func TestChartToMermaidSingleSeriesBackwardCompat(t *testing.T) {
	spec := &ChartSpec{
		Type:  "bar",
		Title: "Старый формат",
	}
	spec.Data = append(spec.Data, struct {
		Label string  `json:"label"`
		Value float64 `json:"value"`
	}{Label: "A", Value: 1})
	spec.Data = append(spec.Data, struct {
		Label string  `json:"label"`
		Value float64 `json:"value"`
	}{Label: "B", Value: 2})

	code := chartToMermaid(spec)
	if !strings.Contains(code, `x-axis ["A", "B"]`) {
		t.Fatalf("legacy single-series path broke: %s", code)
	}
	if !strings.Contains(code, "bar [1, 2]") {
		t.Fatalf("legacy single-series bar values wrong: %s", code)
	}
}
