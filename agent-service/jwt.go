package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
)

var jwtSecret []byte

func loadJWTSecret() error {
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		return errors.New("JWT_SECRET is required")
	}
	jwtSecret = []byte(secret)
	return nil
}

type jwtClaims struct {
	Email    string `json:"email"`
	DeviceID string `json:"device_id"`
	AppID    string `json:"app_id"`
	jwt.RegisteredClaims
}

func parseJWT(tokenStr string) (*jwtClaims, error) {
	claims := &jwtClaims{}
	token, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return jwtSecret, nil
	}, jwt.WithExpirationRequired(), jwt.WithLeeway(30*time.Second))
	if err != nil || !token.Valid {
		return nil, errors.New("invalid token")
	}
	return claims, nil
}

func appIDFromEnv() string {
	if v := os.Getenv("AGENT_APP_ID"); v != "" {
		return v
	}
	return "agent"
}

func roleRank(role string) int {
	switch role {
	case "admin":
		return 3
	case "editor":
		return 2
	case "viewer":
		return 1
	default:
		return 0
	}
}

type permEmailCtx struct{}

func (s *Server) roleFor(ctx context.Context, appID, email string) (string, error) {
	var role string
	err := s.pool.QueryRow(ctx,
		`SELECT role FROM agent_permissions WHERE app = $1 AND email = $2`,
		appID, email).Scan(&role)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil
		}
		return "", err
	}
	return role, nil
}

func (s *Server) effectiveRole(ctx context.Context, appID, email string) (string, error) {
	role, err := s.roleFor(ctx, appID, email)
	if err != nil {
		return "", err
	}
	return role, nil
}

func (s *Server) requirePerm(minRole string) func(http.HandlerFunc) http.HandlerFunc {
	return func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			auth := r.Header.Get("Authorization")
			tokenStr := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer"))
			if tokenStr == "" {
				writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
				return
			}

			claims, err := parseJWT(tokenStr)
			if err != nil {
				writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
				return
			}
			if claims.AppID != appIDFromEnv() {
				writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden"})
				return
			}

			role, err := s.effectiveRole(r.Context(), claims.AppID, claims.Email)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
				return
			}
			if roleRank(role) < roleRank(minRole) {
				writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden: insufficient role"})
				return
			}

			ctx := context.WithValue(r.Context(), permEmailCtx{}, claims.Email)
			next(w, r.WithContext(ctx))
		}
	}
}
