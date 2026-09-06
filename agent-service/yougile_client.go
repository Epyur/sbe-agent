package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"sync"
	"time"
)

// ================= Клиент ЮГайла (server-to-server, без CORS) =================
// Порт sbe-yougile/src/api/client.ts — тот же base URL и формы запросов, но
// вызывается ИЗ agent-service (не из браузера): ключ ЮГайла никогда не попадает
// в код веб-агента, а YouGile CORS вообще не имеет значения для server-to-server.
// См. §2-3 docs/superpowers/specs/2026-09-06-web-agent-yougile-design.md.

const yougileBaseURL = "https://ru.yougile.com/api-v2"

var errYougileNotConnected = errors.New("yougile: не подключено — задайте пароль в настройках")

// companyId — одна константа на всю компанию (весь штат работает в одном
// пространстве ЮГайла), не хранится по пользователям.
func yougileCompanyID() string {
	return os.Getenv("YOUGILE_COMPANY_ID")
}

// yougileKeyEntry — ключ ЮГайла, полученный обменом пароля через /auth/keys.
type yougileKeyEntry struct {
	key        string
	obtainedAt time.Time
}

// keyCache — ключи ЮГайла в памяти процесса, per-email. Обмен пароля на ключ —
// только при отсутствии в кэше или после 401 от ЮГайла (реактивное обновление,
// как в sbe-yougile/src/services/auth.ts), не на каждый вызов.
type keyCache struct {
	mu      sync.Mutex
	entries map[string]yougileKeyEntry
}

var yougileKeyCache = &keyCache{entries: map[string]yougileKeyEntry{}}

func (c *keyCache) get(email string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[email]
	return e.key, ok
}

func (c *keyCache) set(email, key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[email] = yougileKeyEntry{key: key, obtainedAt: time.Now()}
}

func (c *keyCache) forget(email string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, email)
}

var yougileHTTPClient = &http.Client{Timeout: 30 * time.Second}

// yougileAuth — обменивает логин(email)+пароль+companyId на ключ ЮГайла (POST
// /auth/keys). Ключ — bearer-токен для всех остальных вызовов.
func yougileAuth(ctx context.Context, email, password string) (string, error) {
	companyID := yougileCompanyID()
	if companyID == "" {
		return "", fmt.Errorf("yougile: YOUGILE_COMPANY_ID не задан на сервере")
	}
	body, _ := json.Marshal(map[string]string{"login": email, "password": password, "companyId": companyID})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, yougileBaseURL+"/auth/keys", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := yougileHTTPClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("yougile auth: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("yougile auth error (HTTP %d): %s", resp.StatusCode, truncate(string(data), 300))
	}
	var parsed struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil || parsed.Key == "" {
		return "", fmt.Errorf("yougile auth: ключ не получен в ответе")
	}
	return parsed.Key, nil
}

// yougileKeyFor — ключ ЮГайла для email: из кэша, иначе обмен пароля на ключ.
func (s *Server) yougileKeyFor(ctx context.Context, email string) (string, error) {
	if key, ok := yougileKeyCache.get(email); ok {
		return key, nil
	}
	password, err := s.yougilePassword(ctx, email)
	if err != nil {
		return "", err
	}
	key, err := yougileAuth(ctx, email, password)
	if err != nil {
		return "", err
	}
	yougileKeyCache.set(email, key)
	return key, nil
}

// yougileRequest — один вызов API ЮГайла с реактивным обновлением ключа: если
// текущий ключ уже недействителен (401), обменивает пароль заново РОВНО ОДИН
// РАЗ и повторяет запрос.
func (s *Server) yougileRequest(ctx context.Context, email, method, path string, body any) ([]byte, error) {
	do := func(key string) (*http.Response, []byte, error) {
		var reader io.Reader
		if body != nil {
			b, err := json.Marshal(body)
			if err != nil {
				return nil, nil, err
			}
			reader = bytes.NewReader(b)
		}
		req, err := http.NewRequestWithContext(ctx, method, yougileBaseURL+path, reader)
		if err != nil {
			return nil, nil, err
		}
		req.Header.Set("Authorization", "Bearer "+key)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := yougileHTTPClient.Do(req)
		if err != nil {
			return nil, nil, err
		}
		defer resp.Body.Close()
		data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		return resp, data, err
	}

	key, err := s.yougileKeyFor(ctx, email)
	if err != nil {
		return nil, err
	}
	resp, data, err := do(key)
	if err != nil {
		return nil, fmt.Errorf("yougile request failed: %w", err)
	}
	if resp.StatusCode == http.StatusUnauthorized {
		yougileKeyCache.forget(email)
		key, err = s.yougileKeyFor(ctx, email)
		if err != nil {
			return nil, err
		}
		resp, data, err = do(key)
		if err != nil {
			return nil, fmt.Errorf("yougile request failed: %w", err)
		}
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("yougile API error (HTTP %d): %s", resp.StatusCode, truncate(string(data), 300))
	}
	return data, nil
}

// ---- Задачи ----

type yougileListResponse struct {
	Content json.RawMessage `json:"content"`
	Paging  struct {
		Next bool `json:"next"`
	} `json:"paging"`
}

// yougileListTasks — GET /tasks с фильтрами и пагинацией (лимит по количеству
// СТРАНИЦ, не по общему числу — тот же порог, что и в остальных агентских
// тулах, см. maxYougileTasksPages).
const maxYougileTasksPages = 5

func (s *Server) yougileListTasks(ctx context.Context, email string, filter map[string]string) ([]json.RawMessage, error) {
	var all []json.RawMessage
	offset := 0
	const pageLimit = 100
	for page := 0; page < maxYougileTasksPages; page++ {
		q := url.Values{}
		q.Set("limit", strconv.Itoa(pageLimit))
		q.Set("offset", strconv.Itoa(offset))
		for k, v := range filter {
			if v != "" {
				q.Set(k, v)
			}
		}
		data, err := s.yougileRequest(ctx, email, http.MethodGet, "/tasks?"+q.Encode(), nil)
		if err != nil {
			return nil, err
		}
		var parsed yougileListResponse
		if err := json.Unmarshal(data, &parsed); err != nil {
			return nil, fmt.Errorf("yougile: unexpected response shape: %w", err)
		}
		var items []json.RawMessage
		if err := json.Unmarshal(parsed.Content, &items); err != nil {
			return nil, err
		}
		all = append(all, items...)
		if !parsed.Paging.Next || len(items) < pageLimit {
			break
		}
		offset += pageLimit
	}
	return all, nil
}

func (s *Server) yougileCreateTask(ctx context.Context, email string, payload map[string]any) (json.RawMessage, error) {
	return s.yougileRequest(ctx, email, http.MethodPost, "/tasks", payload)
}

// yougileSetTaskColumn — смена статуса задачи = смена колонки: в API ЮГайла
// нет отдельного поля статуса (тот же приём использует sbe-yougile).
func (s *Server) yougileSetTaskColumn(ctx context.Context, email, taskID, columnID string) error {
	_, err := s.yougileRequest(ctx, email, http.MethodPut, "/tasks/"+url.PathEscape(taskID), map[string]any{"columnId": columnID})
	return err
}

// ---- Справочники (для сопоставления имён → id при создании задачи/смене статуса) ----

func (s *Server) yougileListContent(ctx context.Context, email, path string) ([]json.RawMessage, error) {
	data, err := s.yougileRequest(ctx, email, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	var parsed yougileListResponse
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, fmt.Errorf("yougile: unexpected response shape: %w", err)
	}
	var items []json.RawMessage
	if err := json.Unmarshal(parsed.Content, &items); err != nil {
		return nil, err
	}
	return items, nil
}

// ---- Чат задачи ----
// taskId САМ является chatId для собственного чата задачи в ЮГайле (см.
// sbe-yougile: getMessages(taskId)/sendMessage(task.id, text) — отдельного
// поля chatId у задачи нет).

func (s *Server) yougileSendMessage(ctx context.Context, email, taskID, textHTML string) error {
	_, err := s.yougileRequest(ctx, email, http.MethodPost, "/chats/"+url.PathEscape(taskID)+"/messages", map[string]any{
		"text":     textHTML,
		"textHtml": textHTML,
		"label":    "",
	})
	return err
}

// yougileUploadFile — POST /upload-file (multipart), возвращает fullUrl для
// встраивания ссылки/картинки в текст сообщения (в API ЮГайла нет отдельного
// поля «вложение» у сообщения чата — см. yougile-tntn/src/ui/tasks-view.ts).
func (s *Server) yougileUploadFile(ctx context.Context, email string, data []byte, fileName string) (string, error) {
	key, err := s.yougileKeyFor(ctx, email)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	part, err := writer.CreateFormFile("file", fileName)
	if err != nil {
		return "", err
	}
	if _, err := part.Write(data); err != nil {
		return "", err
	}
	if err := writer.Close(); err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, yougileBaseURL+"/upload-file", &buf)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err := yougileHTTPClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("yougile upload failed: %w", err)
	}
	defer resp.Body.Close()
	respData, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("yougile upload error (HTTP %d): %s", resp.StatusCode, truncate(string(respData), 300))
	}
	var parsed struct {
		FullURL string `json:"fullUrl"`
	}
	if err := json.Unmarshal(respData, &parsed); err != nil || parsed.FullURL == "" {
		return "", fmt.Errorf("yougile upload: fullUrl не получен в ответе")
	}
	return parsed.FullURL, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
