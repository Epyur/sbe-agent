package main

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// ================= Р“Р»РѕР±Р°Р»СЊРЅС‹Рµ СЃРєРёР»С‹ (Р‘Р»РѕРє B6 вЂ” supply-chain) =================
// Р“Р»РѕР±Р°Р»СЊРЅС‹Р№ СЃРєРёР» вЂ” СѓС‚РІРµСЂР¶РґС‘РЅРЅР°СЏ Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂРѕРј РєРѕРїРёСЏ (owner Р·Р°РіСЂСѓР¶Р°РµС‚ РїР°РїРєСѓ
// СЃРєРёР»Р° С‡РµСЂРµР· UI РїР»Р°РіРёРЅР° РЅР° СЃРµСЂРІРµСЂ). Р­С‚Рѕ В«Р±РµР»С‹Р№ СЃРїРёСЃРѕРєВ»: РїСЂРё add_skill С‚Р°РєРѕРіРѕ
// СЃРєРёР»Р° Р°РіРµРЅС‚ РќР• РєР°С‡Р°РµС‚ РµРіРѕ СЃ GitHub, Р° СЃРѕРѕР±С‰Р°РµС‚ РїРѕР»СЊР·РѕРІР°С‚РµР»СЋ, С‡С‚Рѕ РѕРЅ СѓР¶Рµ
// СѓСЃС‚Р°РЅРѕРІР»РµРЅ РіР»РѕР±Р°Р»СЊРЅРѕ Рё РґРѕСЃС‚СѓРїРµРЅ С‡РµСЂРµР· list_skills/read_skill (trusted-РёСЃС‚РѕС‡РЅРёРє вЂ”
// СЃРµСЂРІРµСЂ, Р° РЅРµ РїСЂРѕРёР·РІРѕР»СЊРЅС‹Р№ СЂРµРїРѕР·РёС‚РѕСЂРёР№).

var (
	skillNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)
	skillFileRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._ -]{0,120}$`)
)

// maxGlobalSkillBytes вЂ” СЃСѓРјРјР°СЂРЅС‹Р№ Р»РёРјРёС‚ СЃРѕРґРµСЂР¶РёРјРѕРіРѕ СЃРєРёР»Р° (SKILL.md + С„Р°Р№Р»С‹).
const maxGlobalSkillBytes = 8 << 20

// SkillFile вЂ” РІСЃРїРѕРјРѕРіР°С‚РµР»СЊРЅС‹Р№ С„Р°Р№Р» СЃРєРёР»Р° (С‚РµРєСЃС‚РѕРІС‹Р№).
type SkillFile struct {
	Name    string `json:"name"`
	Content string `json:"content"`
}

// GlobalSkill вЂ” РїРѕР»РЅР°СЏ Р·Р°РїРёСЃСЊ РіР»РѕР±Р°Р»СЊРЅРѕРіРѕ СЃРєРёР»Р°.
type GlobalSkill struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	Content     string      `json:"content"`
	Files       []SkillFile `json:"files"`
	InstalledBy string      `json:"installed_by"`
	CreatedAt   string      `json:"created_at"`
}

// migrateSkills вЂ” С‚Р°Р±Р»РёС†Р° РіР»РѕР±Р°Р»СЊРЅС‹С… СЃРєРёР»РѕРІ.
func (s *Server) migrateSkills(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS skills (
    name         TEXT PRIMARY KEY,
    description  TEXT NOT NULL DEFAULT '',
    content      TEXT NOT NULL DEFAULT '',
    files        JSONB NOT NULL DEFAULT '[]',
    installed_by TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
)`)
	return err
}

// handleListGlobalSkills вЂ” СЃРїРёСЃРѕРє РіР»РѕР±Р°Р»СЊРЅС‹С… СЃРєРёР»РѕРІ (РёРјСЏ + РѕРїРёСЃР°РЅРёРµ), viewer.
func (s *Server) handleListGlobalSkills(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `SELECT name, description FROM skills ORDER BY name`)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	defer rows.Close()
	type item struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	items := make([]item, 0)
	for rows.Next() {
		var it item
		if err := rows.Scan(&it.Name, &it.Description); err != nil {
			continue
		}
		items = append(items, it)
	}
	writeJSON(w, http.StatusOK, map[string]any{"skills": items})
}

// handleGetGlobalSkill вЂ” РїРѕР»РЅРѕРµ СЃРѕРґРµСЂР¶РёРјРѕРµ РіР»РѕР±Р°Р»СЊРЅРѕРіРѕ СЃРєРёР»Р°, viewer.
func (s *Server) handleGetGlobalSkill(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(strings.ToLower(r.PathValue("name")))
	if !skillNameRe.MatchString(name) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid skill name"})
		return
	}
	skill, err := s.loadGlobalSkill(r.Context(), name)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "skill not found"})
		return
	}
	writeJSON(w, http.StatusOK, skill)
}

func (s *Server) loadGlobalSkill(ctx context.Context, name string) (*GlobalSkill, error) {
	var g GlobalSkill
	var filesRaw []byte
	var createdAt time.Time
	err := s.pool.QueryRow(ctx,
		`SELECT name, description, content, files, installed_by, created_at FROM skills WHERE name = $1`,
		name).Scan(&g.Name, &g.Description, &g.Content, &filesRaw, &g.InstalledBy, &createdAt)
	if err != nil {
		return nil, err
	}
	g.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	if len(filesRaw) > 0 {
		_ = json.Unmarshal(filesRaw, &g.Files)
	}
	if g.Files == nil {
		g.Files = []SkillFile{}
	}
	return &g, nil
}

// handleUpsertGlobalSkill вЂ” СЃРѕР·РґР°РЅРёРµ/РѕР±РЅРѕРІР»РµРЅРёРµ РіР»РѕР±Р°Р»СЊРЅРѕРіРѕ СЃРєРёР»Р° (admin).
func (s *Server) handleUpsertGlobalSkill(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name        string      `json:"name"`
		Description string      `json:"description"`
		Content     string      `json:"content"`
		Files       []SkillFile `json:"files"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxGlobalSkillBytes)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	req.Name = strings.TrimSpace(strings.ToLower(req.Name))
	req.Description = strings.TrimSpace(req.Description)
	if !skillNameRe.MatchString(req.Name) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid skill name"})
		return
	}
	if strings.TrimSpace(req.Content) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "content (SKILL.md) is required"})
		return
	}
	files := make([]SkillFile, 0, len(req.Files))
	total := len(req.Content)
	for _, f := range req.Files {
		fn := strings.TrimSpace(f.Name)
		if !skillFileRe.MatchString(fn) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid file name: " + fn})
			return
		}
		total += len(f.Content)
		files = append(files, SkillFile{Name: fn, Content: f.Content})
	}
	if total > maxGlobalSkillBytes {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "skill too large"})
		return
	}
	filesJSON, err := json.Marshal(files)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	if _, err := s.pool.Exec(r.Context(), `
INSERT INTO skills (name, description, content, files, installed_by)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (name) DO UPDATE SET
    description = EXCLUDED.description,
    content = EXCLUDED.content,
    files = EXCLUDED.files,
    installed_by = EXCLUDED.installed_by,
    created_at = now()`,
		req.Name, req.Description, req.Content, filesJSON, email); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "name": req.Name})
}

// handleDeleteGlobalSkill вЂ” СѓРґР°Р»РµРЅРёРµ РіР»РѕР±Р°Р»СЊРЅРѕРіРѕ СЃРєРёР»Р° (admin).
func (s *Server) handleDeleteGlobalSkill(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(strings.ToLower(r.PathValue("name")))
	if !skillNameRe.MatchString(name) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid skill name"})
		return
	}
	tag, err := s.pool.Exec(r.Context(), `DELETE FROM skills WHERE name = $1`, name)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	if tag.RowsAffected() == 0 {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "skill not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
