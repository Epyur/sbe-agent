package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
)

// ================= Учётные данные ЮГайла (веб-агент) =================
// Пароль ЮГайла пользователя — по образцу user_llm_keys в sbe-llm/llm-service:
// per-email строка, AES-256-GCM (crypto.go), пароль никогда не возвращается
// клиенту. Логин ЮГайла = email пользователя (тот же, что в ЦУП) — отдельно
// не хранится. companyId — одна константа на всю компанию, см. yougileCompanyID().
// См. docs/superpowers/specs/2026-09-06-web-agent-yougile-design.md.

func (s *Server) migrateYougileCredentials(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS yougile_credentials (
	email          TEXT PRIMARY KEY,
	password_enc   BYTEA NOT NULL,
	password_nonce BYTEA NOT NULL,
	created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
)`)
	return err
}

// handleGetYougileSettings — GET /api/agent/yougile/settings. Пароль не возвращается.
func (s *Server) handleGetYougileSettings(w http.ResponseWriter, r *http.Request) {
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	var exists bool
	err := s.pool.QueryRow(r.Context(),
		`SELECT true FROM yougile_credentials WHERE email = $1`, email).Scan(&exists)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"connected": exists})
}

// handleSetYougileSettings — POST /api/agent/yougile/settings {password}.
func (s *Server) handleSetYougileSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxSettingsBytes)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	if req.Password == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "password is required"})
		return
	}
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	enc, nonce, err := encryptSecret(req.Password)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "encryption error"})
		return
	}
	if _, err := s.pool.Exec(r.Context(), `
INSERT INTO yougile_credentials (email, password_enc, password_nonce) VALUES ($1, $2, $3)
ON CONFLICT (email) DO UPDATE SET password_enc = EXCLUDED.password_enc, password_nonce = EXCLUDED.password_nonce, updated_at = now()`,
		email, enc, nonce); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	// Смена пароля — старый закэшированный ключ ЮГайла (если был) больше не годится.
	yougileKeyCache.forget(email)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleDeleteYougileSettings — DELETE /api/agent/yougile/settings.
func (s *Server) handleDeleteYougileSettings(w http.ResponseWriter, r *http.Request) {
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	if _, err := s.pool.Exec(r.Context(), `DELETE FROM yougile_credentials WHERE email = $1`, email); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	yougileKeyCache.forget(email)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// yougilePassword — расшифрованный пароль пользователя, или ошибка «не подключено».
func (s *Server) yougilePassword(ctx context.Context, email string) (string, error) {
	var encPass, nonce []byte
	err := s.pool.QueryRow(ctx,
		`SELECT password_enc, password_nonce FROM yougile_credentials WHERE email = $1`, email).
		Scan(&encPass, &nonce)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", errYougileNotConnected
		}
		return "", err
	}
	return decryptSecret(encPass, nonce)
}
