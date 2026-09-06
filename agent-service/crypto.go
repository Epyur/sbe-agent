package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
)

// secretEncryptionKey — 32-байтовый AES-256 ключ из AGENT_KEY_ENCRYPTION_KEY
// (base64), отдельный от AGENT_POSTGRES_PASSWORD/AGENT_SERVICE_SECRET: дамп БД
// сам по себе секреты пользователей не раскрывает. Порт sbe-llm/llm-service/
// crypto.go — тот же паттерн для пароля ЮГайла (yougile_credentials.go).
var secretEncryptionKey []byte

func loadSecretEncryptionKey() error {
	raw := os.Getenv("AGENT_KEY_ENCRYPTION_KEY")
	if raw == "" {
		return fmt.Errorf("AGENT_KEY_ENCRYPTION_KEY is required")
	}
	key, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return fmt.Errorf("AGENT_KEY_ENCRYPTION_KEY: invalid base64: %w", err)
	}
	if len(key) != 32 {
		return fmt.Errorf("AGENT_KEY_ENCRYPTION_KEY: expected 32 bytes after base64 decode, got %d", len(key))
	}
	secretEncryptionKey = key
	return nil
}

// encryptSecret шифрует произвольный секрет пользователя (AES-256-GCM).
// Хеширование не подходит: сервису нужно позже ПОДСТАВИТЬ секрет в внешний
// запрос (auth/keys ЮГайла), а не только сверить совпадение.
func encryptSecret(plain string) (ciphertext, nonce []byte, err error) {
	block, err := aes.NewCipher(secretEncryptionKey)
	if err != nil {
		return nil, nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, err
	}
	nonce = make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, nil, err
	}
	ciphertext = gcm.Seal(nil, nonce, []byte(plain), nil)
	return ciphertext, nonce, nil
}

func decryptSecret(ciphertext, nonce []byte) (string, error) {
	block, err := aes.NewCipher(secretEncryptionKey)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	plain, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}
