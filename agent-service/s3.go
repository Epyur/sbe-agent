package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// S3Store — загрузка файлов через rclone CLI (remote firstvds_agent -> бакет sbe-agent).
// Используем rclone вместо aws-sdk-go-v2: он стабильно работает с этим Ceph (проверено),
// а SDK внутри HTTP-обработчика зависал и дестабилизировал сервер (см. documents-service).
type S3Store struct {
	bucket     string
	configPath string
	remote     string
}

// NewS3Store создаёт конфиг rclone из env и возвращает S3Store.
func NewS3Store() (*S3Store, error) {
	endpoint := os.Getenv("S3_ENDPOINT")
	if endpoint == "" {
		return nil, fmt.Errorf("S3_ENDPOINT is required")
	}
	accessKey := os.Getenv("S3_ACCESS_KEY")
	secretKey := os.Getenv("S3_SECRET_KEY")
	if accessKey == "" || secretKey == "" {
		return nil, fmt.Errorf("S3_ACCESS_KEY and S3_SECRET_KEY are required")
	}
	bucket := os.Getenv("AGENT_S3_BUCKET")
	if bucket == "" {
		bucket = "sbe-agent"
	}

	configDir := "/root/.config/rclone"
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		return nil, err
	}
	configPath := filepath.Join(configDir, "rclone.conf")
	conf := fmt.Sprintf(`[firstvds_agent]
type = s3
provider = Other
access_key_id = %s
secret_access_key = %s
endpoint = %s
`, accessKey, secretKey, endpoint)
	if err := os.WriteFile(configPath, []byte(conf), 0o600); err != nil {
		return nil, err
	}

	return &S3Store{
		bucket:     bucket,
		configPath: configPath,
		remote:     "firstvds_agent",
	}, nil
}

// remoteAddr возвращает полный адрес объекта: remote:bucket/key.
func (s *S3Store) remoteAddr(key string) string {
	return fmt.Sprintf("%s:%s/%s", s.remote, s.bucket, key)
}

func (s *S3Store) rcloneArgs(args ...string) *exec.Cmd {
	cmd := exec.Command("rclone", args...)
	cmd.Env = append(os.Environ(), "RCLONE_CONFIG="+s.configPath)
	return cmd
}

// Put загружает файл в S3. data — содержимое целиком; во временный файл, затем rclone copyto.
func (s *S3Store) Put(ctx context.Context, key string, data []byte) (int64, error) {
	tmp, err := os.CreateTemp("", "rclone-upload-*")
	if err != nil {
		return 0, err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return 0, err
	}
	if err := tmp.Close(); err != nil {
		return 0, err
	}

	start := time.Now()
	cmd := s.rcloneArgs("copyto", "--log-level", "ERROR", tmp.Name(), s.remoteAddr(key))
	out, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("rclone copyto failed: %v (%s) out=%s", err, time.Since(start), strings.TrimSpace(string(out)))
		return 0, err
	}
	log.Printf("rclone copyto OK: %s (elapsed %s, %d bytes)", key, time.Since(start), len(data))
	return int64(len(data)), nil
}

// Link возвращает подписанную ссылку на скачивание (rclone link, срок действия из expire).
func (s *S3Store) Link(ctx context.Context, key, expire string) (string, error) {
	start := time.Now()
	cmd := s.rcloneArgs("link", s.remoteAddr(key), "--expire", expire)
	out, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("rclone link failed: %v (%s) out=%s", err, time.Since(start), strings.TrimSpace(string(out)))
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// Get скачивает объект из S3 (rclone copyto из бакета во временный файл).
// Нужен для скретч-хранилища (scratch.go) — в отличие от Put/Link, которые
// используются только для генерируемых-на-скачивание файлов, тут файл нужно
// прочитать обратно на сервере.
func (s *S3Store) Get(ctx context.Context, key string) ([]byte, error) {
	tmp, err := os.CreateTemp("", "rclone-download-*")
	if err != nil {
		return nil, err
	}
	tmp.Close()
	defer os.Remove(tmp.Name())

	start := time.Now()
	cmd := s.rcloneArgs("copyto", "--log-level", "ERROR", s.remoteAddr(key), tmp.Name())
	out, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("rclone copyto(download) failed: %v (%s) out=%s", err, time.Since(start), strings.TrimSpace(string(out)))
		return nil, err
	}
	data, err := os.ReadFile(tmp.Name())
	if err != nil {
		return nil, err
	}
	log.Printf("rclone copyto(download) OK: %s (elapsed %s, %d bytes)", key, time.Since(start), len(data))
	return data, nil
}

// randomID возвращает hex-строку для уникального ключа.
func randomID() string {
	b := make([]byte, 16)
	if f, err := os.Open("/dev/urandom"); err == nil {
		_, _ = f.Read(b)
		_ = f.Close()
	}
	return fmt.Sprintf("%x", b)
}

// sanitizeFileName убирает небезопасные символы из имени файла.
func sanitizeFileName(s string) string {
	replacer := strings.NewReplacer("/", "_", "\\", "_", ":", "_", " ", "_", "{", "", "}", "")
	s = replacer.Replace(s)
	s = strings.TrimSpace(s)
	if s == "" {
		return "file"
	}
	return s
}
