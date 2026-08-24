package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
)

func ownerEmailFromEnv() string {
	return os.Getenv("AGENT_OWNER_EMAIL")
}

// handleMyPermission возвращает роль текущего пользователя (по JWT email).
func (s *Server) handleMyPermission(w http.ResponseWriter, r *http.Request) {
	email, ok := r.Context().Value(permEmailCtx{}).(string)
	if !ok || email == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return
	}
	role, err := s.effectiveRole(r.Context(), appIDFromEnv(), email)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	if role == "" {
		writeJSON(w, http.StatusOK, map[string]any{"email": email, "role": "", "hasAccess": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"email": email, "role": role, "hasAccess": true})
}

// handleListPermissions возвращает все права (для admin).
func (s *Server) handleListPermissions(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
SELECT email, role FROM agent_permissions WHERE app = $1 ORDER BY email`, appIDFromEnv())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	defer rows.Close()

	type perm struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	perms := make([]perm, 0, 16)
	for rows.Next() {
		var p perm
		if err := rows.Scan(&p.Email, &p.Role); err != nil {
			log.Printf("permissions scan: %v", err)
			continue
		}
		perms = append(perms, p)
	}
	if err := rows.Err(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"permissions": perms})
}

// handleSetPermission устанавливает роль ({email, role}); role="" — удаляет доступ.
func (s *Server) handleSetPermission(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	req.Email = strings.TrimSpace(req.Email)
	req.Role = strings.TrimSpace(req.Role)
	if req.Email == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "email is required"})
		return
	}
	if req.Role != "" && req.Role != "viewer" && req.Role != "editor" && req.Role != "admin" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "role must be viewer, editor or admin"})
		return
	}

	if req.Role == "" || req.Role != "admin" {
		owner := ownerEmailFromEnv()
		if req.Email == owner {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "нельзя отозвать доступ владельца"})
			return
		}
	}

	var err error
	if req.Role == "" {
		_, err = s.pool.Exec(r.Context(), `
DELETE FROM agent_permissions WHERE app = $1 AND email = $2`, appIDFromEnv(), req.Email)
	} else {
		_, err = s.pool.Exec(r.Context(), `
INSERT INTO agent_permissions (app, email, role) VALUES ($1, $2, $3)
ON CONFLICT (app, email) DO UPDATE SET role = EXCLUDED.role`,
			appIDFromEnv(), req.Email, req.Role)
	}
	if err != nil {
		log.Printf("set permission: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("writeJSON: %v", err)
	}
}
