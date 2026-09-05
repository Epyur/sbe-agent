package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
)

// ================= История диалогов агента (веб-портал) =================
// Per-user JSONB-массив (по образцу skills.go): в отличие от Obsidian-плагина
// (yourbase/sbe_agent/chat_history.json), история хранится на сервере, чтобы
// быть доступной с любого браузера/устройства и переживать очистку данных
// сайта. Структура Dialog зеркалит формат из плагина.

const maxHistoryBytes = 16 << 20

type AgentMessageLink struct {
	URL   string `json:"url"`
	Label string `json:"label"`
}

type AgentMessage struct {
	Role      string            `json:"role"`
	Content   string            `json:"content"`
	Files     []string          `json:"files,omitempty"`
	Tool      string            `json:"tool,omitempty"`
	ToolOk    *bool             `json:"toolOk,omitempty"`
	Link      *AgentMessageLink `json:"link,omitempty"`
	CreatedAt string            `json:"created_at"`
}

type Dialog struct {
	ID        string         `json:"id"`
	Title     string         `json:"title"`
	Messages  []AgentMessage `json:"messages"`
	CreatedAt string         `json:"created_at"`
	UpdatedAt string         `json:"updated_at"`
}

func (s *Server) migrateChatHistory(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS chat_history (
	email      TEXT PRIMARY KEY,
	dialogs    JSONB NOT NULL DEFAULT '[]',
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`)
	return err
}

func (s *Server) loadDialogs(ctx context.Context, email string) ([]Dialog, error) {
	var raw []byte
	err := s.pool.QueryRow(ctx, `SELECT dialogs FROM chat_history WHERE email = $1`, email).Scan(&raw)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return []Dialog{}, nil
		}
		return nil, err
	}
	dialogs := []Dialog{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &dialogs)
	}
	if dialogs == nil {
		dialogs = []Dialog{}
	}
	return dialogs, nil
}

func (s *Server) saveDialogs(ctx context.Context, email string, dialogs []Dialog) error {
	data, err := json.Marshal(dialogs)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `
INSERT INTO chat_history (email, dialogs, updated_at) VALUES ($1, $2::jsonb, now())
ON CONFLICT (email) DO UPDATE SET dialogs = EXCLUDED.dialogs, updated_at = now()`,
		email, string(data))
	return err
}

// handleGetHistory — GET /api/agent/history: вся история текущего пользователя.
func (s *Server) handleGetHistory(w http.ResponseWriter, r *http.Request) {
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	dialogs, err := s.loadDialogs(r.Context(), email)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"dialogs": dialogs})
}

// handleSaveDialog — POST /api/agent/history: upsert ОДНОГО диалога (по id)
// в массив пользователя. Веб-клиент вызывает это после каждого сообщения —
// не только для истории между устройствами, но и чтобы ключи скретч-хранилища
// (parse_file/fetch_url save_to, см. scratch.go), упомянутые в сообщениях
// тулов, оставались в транскрипте на весь 48-часовой срок жизни объекта в S3.
func (s *Server) handleSaveDialog(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Dialog Dialog `json:"dialog"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxHistoryBytes)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	req.Dialog.ID = strings.TrimSpace(req.Dialog.ID)
	if req.Dialog.ID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "dialog.id is required"})
		return
	}
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	dialogs, err := s.loadDialogs(r.Context(), email)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	replaced := false
	for i, d := range dialogs {
		if d.ID == req.Dialog.ID {
			dialogs[i] = req.Dialog
			replaced = true
			break
		}
	}
	if !replaced {
		dialogs = append(dialogs, req.Dialog)
	}
	if err := s.saveDialogs(r.Context(), email, dialogs); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleDeleteDialog — DELETE /api/agent/history/{id}.
func (s *Server) handleDeleteDialog(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "id is required"})
		return
	}
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	dialogs, err := s.loadDialogs(r.Context(), email)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	kept := make([]Dialog, 0, len(dialogs))
	for _, d := range dialogs {
		if d.ID != id {
			kept = append(kept, d)
		}
	}
	if err := s.saveDialogs(r.Context(), email, kept); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
