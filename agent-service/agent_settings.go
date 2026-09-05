package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
)

// ================= Настройки агента (веб-портал) =================
// Пока только редактируемый системный промпт (аналог yourbase/sbe_agent/
// agent_context.md в Obsidian-плагине — там это заметка вольта, здесь —
// per-user строка). Пустое значение/нет строки — используется дефолтный
// SYSTEM_PROMPT_TEMPLATE на клиенте.

const maxSettingsBytes = 256 << 10

func (s *Server) migrateAgentSettings(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS agent_settings (
	email         TEXT PRIMARY KEY,
	system_prompt TEXT NOT NULL DEFAULT '',
	updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
)`)
	return err
}

// handleGetAgentSettings — GET /api/agent/settings.
func (s *Server) handleGetAgentSettings(w http.ResponseWriter, r *http.Request) {
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	var prompt string
	err := s.pool.QueryRow(r.Context(),
		`SELECT system_prompt FROM agent_settings WHERE email = $1`, email).Scan(&prompt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"system_prompt": prompt})
}

// handleSetAgentSettings — POST /api/agent/settings {system_prompt}.
func (s *Server) handleSetAgentSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SystemPrompt string `json:"system_prompt"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxSettingsBytes)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	if _, err := s.pool.Exec(r.Context(), `
INSERT INTO agent_settings (email, system_prompt) VALUES ($1, $2)
ON CONFLICT (email) DO UPDATE SET system_prompt = EXCLUDED.system_prompt, updated_at = now()`,
		email, req.SystemPrompt); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleDeleteAgentSettings — DELETE /api/agent/settings: сброс на дефолт.
func (s *Server) handleDeleteAgentSettings(w http.ResponseWriter, r *http.Request) {
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	if _, err := s.pool.Exec(r.Context(), `DELETE FROM agent_settings WHERE email = $1`, email); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
