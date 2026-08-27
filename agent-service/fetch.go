package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// maxFetchResponse — лимит тела ответа серверного фетча (1 МБ).
const maxFetchResponse = 1 << 20

// isPrivateIP — локальные/приватные/служебные адреса (SSRF-защита).
func isPrivateIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() {
		return true
	}
	if ip4 := ip.To4(); ip4 != nil {
		// 169.254.0.0/16 (link-local / облачная metadata-точка)
		if ip4[0] == 169 && ip4[1] == 254 {
			return true
		}
	}
	return false
}

// isPrivateHost — true, если hostname/адрес относится к локальной инфраструктуре
// (сервер живёт в docker-сети рядом с auth-service, БД, agent-mermaid и т.п.).
func isPrivateHost(host string) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	if h == "localhost" || h == "127.0.0.1" || h == "::1" {
		return true
	}
	if ip := net.ParseIP(h); ip != nil {
		return isPrivateIP(ip)
	}
	ips, err := net.LookupIP(h)
	if err == nil {
		for _, ip := range ips {
			if isPrivateIP(ip) {
				return true
			}
		}
	}
	return false
}

// handleFetch — скрытый серверный режим работы с сайтами (2026-08-27):
// GET/POST к страницам и JSON/API-эндпоинтам (например DataTables serverSide).
// Браузер для этого не нужен — ответ возвращается текстом.
func (s *Server) handleFetch(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Method    string            `json:"method"`
		URL       string            `json:"url"`
		Body      string            `json:"body"`
		Headers   map[string]string `json:"headers"`
		TimeoutMs int               `json:"timeout_ms"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	req.URL = strings.TrimSpace(req.URL)
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = http.MethodGet
	}
	switch method {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "unsupported method"})
		return
	}
	u, err := url.Parse(req.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid url (http/https)"})
		return
	}
	if isPrivateHost(u.Hostname()) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "локальные адреса недоступны"})
		return
	}

	timeoutMs := 30000
	if req.TimeoutMs > 0 && req.TimeoutMs <= 120000 {
		timeoutMs = req.TimeoutMs
	}

	var body io.Reader
	if req.Body != "" {
		body = strings.NewReader(req.Body)
	}
	httpReq, err := http.NewRequestWithContext(r.Context(), method, u.String(), body)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "request build failed"})
		return
	}
	httpReq.Header.Set("User-Agent", "Mozilla/5.0 (LogicTEAM.007 research bot)")
	httpReq.Header.Set("Accept", "text/html,application/xhtml+xml,application/json,*/*;q=0.8")
	if req.Headers != nil {
		for k, v := range req.Headers {
			httpReq.Header.Set(k, v)
		}
	}

	client := &http.Client{
		Timeout: time.Duration(timeoutMs) * time.Millisecond,
		CheckRedirect: func(inner *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return fmt.Errorf("too many redirects")
			}
			if isPrivateHost(inner.URL.Hostname()) {
				return fmt.Errorf("redirect to local address blocked")
			}
			return nil
		},
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "request failed: " + err.Error()})
		return
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, maxFetchResponse))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "read failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":       resp.StatusCode,
		"content_type": resp.Header.Get("Content-Type"),
		"text":         string(data),
	})
}
