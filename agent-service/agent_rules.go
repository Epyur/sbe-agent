package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
)

// ================= Правила агента (веб-портал) =================
// Аналог save_rule/list_rules/read_rule Obsidian-плагина (файлы в
// yourbase/sbe_agent/rules/, автоподмешиваются в системный промпт) — в вебе
// нет вольта, поэтому это новая per-user таблица, не перенос существующего
// файлового хранилища.

const maxRuleBytes = 2 << 20

type AgentRule struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

func (s *Server) migrateAgentRules(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS agent_rules (
	email      TEXT NOT NULL,
	path       TEXT NOT NULL,
	content    TEXT NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (email, path)
)`)
	return err
}

// handleListRules — GET /api/agent/rules: полный список правил пользователя
// (path+content сразу, без отдельного эндпоинта на один файл — правил у
// пользователя обычно немного, один HTTP-круг на диалог дешевле, чем N).
func (s *Server) handleListRules(w http.ResponseWriter, r *http.Request) {
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	rows, err := s.pool.Query(r.Context(),
		`SELECT path, content FROM agent_rules WHERE email = $1 ORDER BY path`, email)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	defer rows.Close()
	rules := make([]AgentRule, 0)
	for rows.Next() {
		var rule AgentRule
		if err := rows.Scan(&rule.Path, &rule.Content); err != nil {
			continue
		}
		rules = append(rules, rule)
	}
	writeJSON(w, http.StatusOK, map[string]any{"rules": rules})
}

// handleSaveRule — POST /api/agent/rules {path, content, append?}. append=true
// переносит на сервер конкатенацию, которую Obsidian-версия делала в тул-коде
// клиента (saveRule в rules-tools.ts).
func (s *Server) handleSaveRule(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
		Append  bool   `json:"append"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxRuleBytes)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	req.Path = strings.TrimSpace(req.Path)
	if req.Path == "" {
		req.Path = "правила.md"
	}
	if strings.TrimSpace(req.Content) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "content is required"})
		return
	}
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	content := req.Content
	if req.Append {
		var existing string
		if err := s.pool.QueryRow(r.Context(),
			`SELECT content FROM agent_rules WHERE email = $1 AND path = $2`,
			email, req.Path).Scan(&existing); err == nil && strings.TrimSpace(existing) != "" {
			content = strings.TrimRight(existing, " \t\n") + "\n\n" + req.Content
		}
	}
	if _, err := s.pool.Exec(r.Context(), `
INSERT INTO agent_rules (email, path, content) VALUES ($1, $2, $3)
ON CONFLICT (email, path) DO UPDATE SET content = EXCLUDED.content, updated_at = now()`,
		email, req.Path, content); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": req.Path})
}

// handleDeleteRule — DELETE /api/agent/rules?path=...
func (s *Server) handleDeleteRule(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "path is required"})
		return
	}
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	tag, err := s.pool.Exec(r.Context(), `DELETE FROM agent_rules WHERE email = $1 AND path = $2`, email, path)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	if tag.RowsAffected() == 0 {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "rule not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
