package main

import (
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"time"
)

// ================= Хранение уже отрисованных на клиенте файлов =================
// Некоторые форматы рендерятся в браузере, не на сервере — графики (ApexCharts,
// см. docs/superpowers/specs/2026-09-06-web-agent-chart-rendering-design.md) и
// презентации (готовый self-contained HTML, см. docs/superpowers/specs/
// 2026-09-06-web-agent-presentations-design.md). Сервер здесь только сохраняет
// готовый файл в S3 и отдаёт ссылку — тот же формат ответа, что у generateFile,
// чтобы клиентские тулы не меняли контракт для модели.

const maxClientFileBytes = 8 << 20

// clientStoreAllowedExt — какие расширения можно сохранить этим путём (не
// путать с generateFile/buildFiles — там сервер сам решает формат).
var clientStoreAllowedExt = map[string]bool{
	".png":  true,
	".html": true,
}

// handleStoreClientFile — POST /api/agent/file/store, multipart: file
// (обязателен, имя файла определяет расширение/тип), file_name (базовое имя
// без расширения, необязательно).
func (s *Server) handleStoreClientFile(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(maxClientFileBytes); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid multipart"})
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "file is required"})
		return
	}
	defer file.Close()

	ext := strings.ToLower(filepath.Ext(header.Filename))
	if !clientStoreAllowedExt[ext] {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "unsupported file extension"})
		return
	}

	data, err := io.ReadAll(io.LimitReader(file, maxClientFileBytes))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "cannot read file"})
		return
	}

	name := r.FormValue("file_name")
	if name == "" {
		name = "file"
	}
	baseName := sanitizeFileName(name)

	key := "agent/" + randomID() + ext
	if _, err := s.s3.Put(r.Context(), key, data); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "s3 error"})
		return
	}
	link, err := s.s3.Link(r.Context(), key, "48h")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "s3 link error"})
		return
	}
	writeJSON(w, http.StatusOK, GenerateResponse{
		URL:       link,
		ExpiresAt: time.Now().Add(48 * time.Hour).Format(time.RFC3339),
		FileName:  baseName + ext,
	})
}
