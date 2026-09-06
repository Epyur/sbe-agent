package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Server struct {
	pool *pgxpool.Pool
	s3   *S3Store
	// Ограничение одновременных тяжёлых операций (generate/parse).
	// Вместо ошибки «занято» — очередь: запросы ждут свободный слот.
	sem chan struct{}
}

const maxConcurrentFileOps = 4

func main() {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL is required")
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	if err := loadJWTSecret(); err != nil {
		log.Fatalf("JWT: %v", err)
	}
	if err := loadSecretEncryptionKey(); err != nil {
		log.Fatalf("crypto: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatalf("pgxpool.New: %v", err)
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		log.Fatalf("ping: %v", err)
	}

	s3Store, err := NewS3Store()
	if err != nil {
		log.Fatalf("S3: %v", err)
	}

	s := &Server{pool: pool, s3: s3Store, sem: make(chan struct{}, maxConcurrentFileOps)}

	if err := s.migrate(ctx); err != nil {
		log.Fatalf("migrate: %v", err)
	}
	if err := s.seedOwner(ctx); err != nil {
		log.Fatalf("seedOwner: %v", err)
	}
	regCtx, regCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer regCancel()
	if err := s.registerApp(regCtx); err != nil {
		log.Printf("registerApp (non-fatal): %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/agent/health", s.handleHealth)
	mux.HandleFunc("POST /api/agent/file/generate", s.requirePerm("viewer")(s.handleGenerate))
	mux.HandleFunc("POST /api/agent/file/parse", s.requirePerm("viewer")(s.handleParse))
	mux.HandleFunc("GET /api/agent/permissions", s.requirePerm("admin")(s.handleListPermissions))
	mux.HandleFunc("POST /api/agent/permissions", s.requirePerm("admin")(s.handleSetPermission))
	mux.HandleFunc("GET /api/agent/permissions/me", s.requirePerm("viewer")(s.handleMyPermission))
	// Глобальные скилы (Блок B6): список/чтение — viewer, запись — admin.
	mux.HandleFunc("GET /api/agent/skills", s.requirePerm("viewer")(s.handleListGlobalSkills))
	mux.HandleFunc("GET /api/agent/skills/{name}", s.requirePerm("viewer")(s.handleGetGlobalSkill))
	mux.HandleFunc("POST /api/agent/skills", s.requirePerm("admin")(s.handleUpsertGlobalSkill))
	mux.HandleFunc("DELETE /api/agent/skills/{name}", s.requirePerm("admin")(s.handleDeleteGlobalSkill))
	// Скрытый серверный режим работы с сайтами (fetch_url): GET/POST/JSON.
	mux.HandleFunc("POST /api/agent/fetch", s.requirePerm("viewer")(s.handleFetch))
	// Веб-портал (2026-09-04): история диалогов/правила/системный промпт —
	// per-user, без вольта Obsidian, см. chat_history.go/agent_rules.go/
	// agent_settings.go. Все под requirePerm("viewer") — тем же гейтом, что
	// уже стоит на остальных тулах агента (есть доступ к агенту вообще —
	// есть доступ и к своим истории/правилам/настройкам).
	mux.HandleFunc("GET /api/agent/history", s.requirePerm("viewer")(s.handleGetHistory))
	mux.HandleFunc("POST /api/agent/history", s.requirePerm("viewer")(s.handleSaveDialog))
	mux.HandleFunc("DELETE /api/agent/history/{id}", s.requirePerm("viewer")(s.handleDeleteDialog))
	mux.HandleFunc("GET /api/agent/rules", s.requirePerm("viewer")(s.handleListRules))
	mux.HandleFunc("POST /api/agent/rules", s.requirePerm("viewer")(s.handleSaveRule))
	mux.HandleFunc("DELETE /api/agent/rules", s.requirePerm("viewer")(s.handleDeleteRule))
	mux.HandleFunc("GET /api/agent/settings", s.requirePerm("viewer")(s.handleGetAgentSettings))
	mux.HandleFunc("POST /api/agent/settings", s.requirePerm("viewer")(s.handleSetAgentSettings))
	mux.HandleFunc("DELETE /api/agent/settings", s.requirePerm("viewer")(s.handleDeleteAgentSettings))
	// Скретч-хранилище (read_text_part, постраничный сбор списков) — см. scratch.go.
	mux.HandleFunc("POST /api/agent/scratch/text", s.requirePerm("viewer")(s.handleSaveScratchText))
	mux.HandleFunc("GET /api/agent/scratch/text", s.requirePerm("viewer")(s.handleReadScratchText))
	mux.HandleFunc("POST /api/agent/scratch/records", s.requirePerm("viewer")(s.handleSaveScratchRecords))
	mux.HandleFunc("GET /api/agent/scratch/records", s.requirePerm("viewer")(s.handleReadScratchRecords))
	// ЮГайл (веб-агент, 2026-09-06) — чтение + ограниченная запись (создание
	// задачи, сообщение/файл в чат, смена статуса/колонки); удаления НЕТ нигде
	// в коде — структурная гарантия, см. docs/superpowers/specs/
	// 2026-09-06-web-agent-yougile-design.md.
	mux.HandleFunc("GET /api/agent/yougile/settings", s.requirePerm("viewer")(s.handleGetYougileSettings))
	mux.HandleFunc("POST /api/agent/yougile/settings", s.requirePerm("viewer")(s.handleSetYougileSettings))
	mux.HandleFunc("DELETE /api/agent/yougile/settings", s.requirePerm("viewer")(s.handleDeleteYougileSettings))
	mux.HandleFunc("GET /api/agent/yougile/tasks", s.requirePerm("viewer")(s.handleYougileTasks))
	mux.HandleFunc("POST /api/agent/yougile/tasks", s.requirePerm("viewer")(s.handleYougileCreateTask))
	mux.HandleFunc("PUT /api/agent/yougile/tasks/{id}/status", s.requirePerm("viewer")(s.handleYougileSetTaskStatus))
	mux.HandleFunc("POST /api/agent/yougile/tasks/{id}/message", s.requirePerm("viewer")(s.handleYougileTaskMessage))
	mux.HandleFunc("GET /api/agent/yougile/board-tree", s.requirePerm("viewer")(s.handleYougileBoardTree))

	httpServer := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	log.Printf("agent-service listening on :%s", port)
	if err := httpServer.ListenAndServe(); err != nil {
		log.Fatalf("ListenAndServe: %v", err)
	}
}

func (s *Server) migrate(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS agent_permissions (
	app   TEXT NOT NULL,
	email TEXT NOT NULL,
	role  TEXT NOT NULL,
	PRIMARY KEY (app, email)
)`); err != nil {
		return err
	}
	if err := s.migrateSkills(ctx); err != nil {
		return err
	}
	if err := s.migrateChatHistory(ctx); err != nil {
		return err
	}
	if err := s.migrateAgentRules(ctx); err != nil {
		return err
	}
	if err := s.migrateAgentSettings(ctx); err != nil {
		return err
	}
	return s.migrateYougileCredentials(ctx)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}
