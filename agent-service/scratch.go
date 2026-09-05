package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

// ================= Скретч-хранилище агента (веб-портал) =================
// Замена путей в вольте (yourbase/sbe_agent/parsed/... и .../*.jsonl) для
// тулов read_text_part и fetch_url(save_to)/save_records/
// build_xlsx_from_records: тот же бакет sbe-agent, префикс scratch/ вместо
// agent/ (сгенерированные файлы). ВАЖНО: cron на VDS чистит по возрасту
// только префикс agent/ — для scratch/ нужна отдельная строка крона
// (rclone delete firstvds:sbe-agent/scratch --min-age 48h), это ручная
// правка на сервере, не код в этом репозитории.

const (
	maxScratchTextBytes    = 20 << 20
	maxScratchRecordsBytes = 8 << 20
	defaultTextReadLength  = 24000
)

// emailHash — первые 8 байт SHA-256(email) в hex (16 символов), чтобы не
// класть сырой email в S3-путь.
func emailHash(email string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email))))
	return fmt.Sprintf("%x", sum[:8])
}

// scratchKey строит S3-ключ: scratch/{хеш email}/{имя}.{ext}.
func scratchKey(email, name, ext string) string {
	return fmt.Sprintf("scratch/%s/%s.%s", emailHash(email), sanitizeFileName(name), ext)
}

func emailScratchPrefix(email string) string {
	return "scratch/" + emailHash(email) + "/"
}

func validScratchKey(key string) bool {
	return strings.HasPrefix(key, "scratch/") && !strings.Contains(key, "..") && !strings.ContainsRune(key, 0)
}

// validScratchKeyForEmail — ключ, переданный клиентом (для дозаписи в уже
// начатый накопитель fetch_url/save_records), обязан лежать под хешем ЭТОГО
// ЖЕ email — иначе можно было бы дописывать в чужой скретч-файл, зная ключ.
func validScratchKeyForEmail(key, email string) bool {
	return validScratchKey(key) && strings.HasPrefix(key, emailScratchPrefix(email))
}

// handleSaveScratchText — POST /api/agent/scratch/text {name, text}: сохраняет
// большой распарсенный текст (parse_file, текст > лимита) в S3, возвращает
// key для последующих handleReadScratchText.
func (s *Server) handleSaveScratchText(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
		Text string `json:"text"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxScratchTextBytes)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	if strings.TrimSpace(req.Text) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "text is required"})
		return
	}
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	key := scratchKey(email, req.Name, "txt")
	if _, err := s.s3.Put(r.Context(), key, []byte(req.Text)); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "s3 error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"key": key, "total": len(req.Text)})
}

// handleReadScratchText — GET /api/agent/scratch/text?key=...&start=...&length=...
// (порт readTextPart на сервер — раз данные уже в S3, резать проще здесь).
func (s *Server) handleReadScratchText(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimSpace(r.URL.Query().Get("key"))
	if !validScratchKey(key) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid key"})
		return
	}
	start, _ := strconv.Atoi(r.URL.Query().Get("start"))
	if start < 0 {
		start = 0
	}
	length, _ := strconv.Atoi(r.URL.Query().Get("length"))
	if length <= 0 || length > defaultTextReadLength {
		length = defaultTextReadLength
	}
	data, err := s.s3.Get(r.Context(), key)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "файл больше не хранится (срок 48ч истёк) или не найден — пришлите его заново"})
		return
	}
	text := string(data)
	if start >= len(text) {
		writeJSON(w, http.StatusOK, map[string]any{"text": "", "start": start, "end": len(text), "total": len(text), "done": true})
		return
	}
	end := start + length
	if end > len(text) {
		end = len(text)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"text": text[start:end], "start": start, "end": end, "total": len(text), "done": end >= len(text),
	})
}

// handleSaveScratchRecords — POST /api/agent/scratch/records
// {key?, name?, records, mode?}: накапливает записи постраничного сбора
// (fetch_url save_to / save_records) в JSONL в S3, с дедупом по канонической
// JSON-форме записи (encoding/json сортирует ключи объектов при Marshal).
// Без key — создаёт новый накопитель (key вычисляется из name); с key —
// дозаписывает в существующий (должен принадлежать текущему email).
func (s *Server) handleSaveScratchRecords(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Key     string            `json:"key"`
		Name    string            `json:"name"`
		Records []json.RawMessage `json:"records"`
		Mode    string            `json:"mode"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxScratchRecordsBytes)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	if len(req.Records) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "records is required"})
		return
	}
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	key := strings.TrimSpace(req.Key)
	if key == "" {
		key = scratchKey(email, req.Name, "jsonl")
	} else if !validScratchKeyForEmail(key, email) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden"})
		return
	}

	var existing []json.RawMessage
	if req.Mode != "overwrite" {
		if data, err := s.s3.Get(r.Context(), key); err == nil {
			existing = parseJSONL(data)
		}
	}
	seen := make(map[string]bool, len(existing)+len(req.Records))
	all := make([]json.RawMessage, 0, len(existing)+len(req.Records))
	for _, rec := range existing {
		all = append(all, rec)
		seen[string(rec)] = true
	}
	added := 0
	for _, rec := range req.Records {
		norm, err := normalizeJSON(rec)
		if err != nil {
			continue
		}
		if seen[string(norm)] {
			continue
		}
		seen[string(norm)] = true
		all = append(all, norm)
		added++
	}

	var buf bytes.Buffer
	for _, rec := range all {
		buf.Write(rec)
		buf.WriteByte('\n')
	}
	if _, err := s.s3.Put(r.Context(), key, buf.Bytes()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "s3 error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"key": key, "added": added, "total": len(all)})
}

// handleReadScratchRecords — GET /api/agent/scratch/records?key=... — читает
// весь накопленный JSONL распарсенным (build_xlsx_from_records читает отсюда,
// затем сам собирает spec и вызывает уже существующий /api/agent/file/generate).
func (s *Server) handleReadScratchRecords(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimSpace(r.URL.Query().Get("key"))
	if !validScratchKey(key) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid key"})
		return
	}
	data, err := s.s3.Get(r.Context(), key)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "файл больше не хранится (срок 48ч истёк) или не найден — соберите список заново"})
		return
	}
	records := parseJSONL(data)
	writeJSON(w, http.StatusOK, map[string]any{"records": records, "total": len(records)})
}

func parseJSONL(data []byte) []json.RawMessage {
	lines := bytes.Split(data, []byte("\n"))
	out := make([]json.RawMessage, 0, len(lines))
	for _, line := range lines {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		out = append(out, json.RawMessage(append([]byte(nil), line...)))
	}
	return out
}

// normalizeJSON перекодирует произвольный JSON в каноническую форму (ключи
// объектов сортируются encoding/json при Marshal) — используется для дедупа.
func normalizeJSON(raw json.RawMessage) (json.RawMessage, error) {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, err
	}
	return json.Marshal(v)
}
