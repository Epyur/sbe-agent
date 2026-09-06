package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strings"
)

// ================= HTTP-хендлеры ЮГайла для веб-агента =================
// За requirePerm("viewer") — тем же гейтом, что у остальных тулов агента.
// Удаления здесь НЕТ ни одного — ни хендлера, ни метода клиента: структурная
// гарантия, не только текст в системном промпте (см. design §6).

func yougileErrorStatus(err error) int {
	if errors.Is(err, errYougileNotConnected) {
		return http.StatusPreconditionRequired // 428 — «сначала подключите ЮГайл в настройках»
	}
	return http.StatusBadGateway
}

// handleYougileTasks — GET /api/agent/yougile/tasks?projectId=&boardId=&columnId=&assignedTo=.
func (s *Server) handleYougileTasks(w http.ResponseWriter, r *http.Request) {
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	filter := map[string]string{}
	for _, k := range []string{"columnId", "assignedTo"} {
		if v := r.URL.Query().Get(k); v != "" {
			filter[k] = v
		}
	}
	tasks, err := s.yougileListTasks(r.Context(), email, filter)
	if err != nil {
		writeJSON(w, yougileErrorStatus(err), map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"content": tasks})
}

// handleYougileBoardTree — GET /api/agent/yougile/board-tree: проекты+доски+
// колонки+пользователи одним вызовом (небольшие справочники всей компании,
// нужны, чтобы сопоставить имена → id при создании задачи/смене статуса).
func (s *Server) handleYougileBoardTree(w http.ResponseWriter, r *http.Request) {
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	ctx := r.Context()
	projects, err := s.yougileListContent(ctx, email, "/projects")
	if err != nil {
		writeJSON(w, yougileErrorStatus(err), map[string]any{"error": err.Error()})
		return
	}
	boards, err := s.yougileListContent(ctx, email, "/boards")
	if err != nil {
		writeJSON(w, yougileErrorStatus(err), map[string]any{"error": err.Error()})
		return
	}
	columns, err := s.yougileListContent(ctx, email, "/columns")
	if err != nil {
		writeJSON(w, yougileErrorStatus(err), map[string]any{"error": err.Error()})
		return
	}
	users, err := s.yougileListContent(ctx, email, "/users")
	if err != nil {
		writeJSON(w, yougileErrorStatus(err), map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"projects": projects, "boards": boards, "columns": columns, "users": users,
	})
}

// handleYougileCreateTask — POST /api/agent/yougile/tasks {title, description?,
// columnId, assigned?, deadline?}.
func (s *Server) handleYougileCreateTask(w http.ResponseWriter, r *http.Request) {
	var req map[string]any
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	title, _ := req["title"].(string)
	columnID, _ := req["columnId"].(string)
	if title == "" || columnID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "title и columnId обязательны"})
		return
	}
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	task, err := s.yougileCreateTask(r.Context(), email, req)
	if err != nil {
		writeJSON(w, yougileErrorStatus(err), map[string]any{"error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(task)
}

// handleYougileSetTaskStatus — PUT /api/agent/yougile/tasks/{id}/status {columnId}.
func (s *Server) handleYougileSetTaskStatus(w http.ResponseWriter, r *http.Request) {
	taskID := r.PathValue("id")
	var req struct {
		ColumnID string `json:"columnId"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ColumnID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "columnId is required"})
		return
	}
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	if err := s.yougileSetTaskColumn(r.Context(), email, taskID, req.ColumnID); err != nil {
		writeJSON(w, yougileErrorStatus(err), map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// maxYougileMessageAttachment — лимит файла-вложения в сообщение чата задачи (10 МБ).
const maxYougileMessageAttachment = 10 << 20

// handleYougileTaskMessage — POST /api/agent/yougile/tasks/{id}/message, multipart:
// text (обязателен) + необязательный file. Если есть файл — сначала грузится
// через /upload-file, ссылка/картинка встраивается в textHtml сообщения (в API
// ЮГайла нет отдельного поля «вложение» у сообщения, см. yougile_client.go).
func (s *Server) handleYougileTaskMessage(w http.ResponseWriter, r *http.Request) {
	taskID := r.PathValue("id")
	if err := r.ParseMultipartForm(maxYougileMessageAttachment); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid multipart"})
		return
	}
	text := r.FormValue("text")
	email, _ := r.Context().Value(permEmailCtx{}).(string)

	textHTML := escapeHTML(text)
	if file, header, err := r.FormFile("file"); err == nil {
		defer file.Close()
		data, readErr := io.ReadAll(io.LimitReader(file, maxYougileMessageAttachment))
		if readErr != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "cannot read file"})
			return
		}
		fullURL, uploadErr := s.yougileUploadFile(r.Context(), email, data, header.Filename)
		if uploadErr != nil {
			writeJSON(w, yougileErrorStatus(uploadErr), map[string]any{"error": uploadErr.Error()})
			return
		}
		if isImageFileName(header.Filename) {
			textHTML += `<br><img src="` + fullURL + `" alt="` + escapeHTML(header.Filename) + `">`
		} else {
			textHTML += `<br><a href="` + fullURL + `">` + escapeHTML(header.Filename) + `</a>`
		}
	}
	if text == "" && textHTML == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "text или file обязательны"})
		return
	}
	if err := s.yougileSendMessage(r.Context(), email, taskID, textHTML); err != nil {
		writeJSON(w, yougileErrorStatus(err), map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func isImageFileName(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".bmp":
		return true
	default:
		return false
	}
}
