// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package envd implements the Pod-internal HTTP agent for agent-sandbox.
// JWT validation using the Router's RSA public key.
package envd

import (
	"context"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"sigs.k8s.io/agent-sandbox/pkg/e2b"
	log "sigs.k8s.io/agent-sandbox/pkg/logx"
)

const (
	// PublicKeyEnvVar is the env var injected by Workload Manager when authMode=envd.
	PublicKeyEnvVar = "ENVD_AUTH_PUBLIC_KEY"
	// SessionIDFileEnvVar optionally overrides the downward-API identity file.
	SessionIDFileEnvVar  = "ENVD_SESSION_ID_FILE"
	defaultSessionIDFile = "/var/run/agent-sandbox/session/session-id"
	jwtIssuer            = "agent-sandbox-router"
	jwtAudience          = "agent-sandbox-envd"
)

// authManager holds the Router's RSA public key for JWT verification.
type authManager struct {
	publicKey *rsa.PublicKey
	mu        sync.RWMutex
}

func newAuthManager() *authManager {
	return &authManager{}
}

// loadFromEnv loads the public key from ENVD_AUTH_PUBLIC_KEY env var.
// Returns nil if the env var is not set (authMode=none → auth disabled).
func (am *authManager) loadFromEnv() error {
	am.mu.Lock()
	defer am.mu.Unlock()

	keyData := os.Getenv(PublicKeyEnvVar)
	if keyData == "" {
		return nil // auth disabled
	}

	block, _ := pem.Decode([]byte(keyData))
	if block == nil {
		return fmt.Errorf("failed to decode PEM block from %s", PublicKeyEnvVar)
	}
	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return fmt.Errorf("parse public key: %w", err)
	}
	rsaPub, ok := pub.(*rsa.PublicKey)
	if !ok {
		return fmt.Errorf("%s is not an RSA public key", PublicKeyEnvVar)
	}
	am.publicKey = rsaPub
	return nil
}

// verifiedSessionIDKey carries, in a request's context, the session ID of the
// Router token jwtMiddleware verified for it.
type verifiedSessionIDKey struct{}

// jwtMiddleware validates the JWT token signed by the Router.
// If publicKey is nil (ENVD_AUTH_PUBLIC_KEY not set → authMode=none), auth is skipped.
func (s *Server) jwtMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.auth.mu.RLock()
		pubKey := s.auth.publicKey
		s.auth.mu.RUnlock()

		// No public key → auth disabled (authMode=none)
		if pubKey == nil {
			next.ServeHTTP(w, r)
			return
		}

		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			http.Error(w, `{"error":"missing Authorization header"}`, http.StatusUnauthorized)
			return
		}

		parts := strings.SplitN(authHeader, " ", 2)
		if len(parts) != 2 || parts[0] != "Bearer" {
			http.Error(w, `{"error":"invalid Authorization format, expected Bearer <token>"}`, http.StatusUnauthorized)
			return
		}

		tokenStr := parts[1]

		// Verify RS256 JWT, issuer and audience before binding it to the
		// Kubernetes downward-API session identity of this specific Pod.
		token, err := jwt.Parse(tokenStr, func(_ *jwt.Token) (interface{}, error) {
			s.auth.mu.RLock()
			defer s.auth.mu.RUnlock()
			return s.auth.publicKey, nil
		},
			jwt.WithValidMethods([]string{"RS256"}),
			jwt.WithIssuer(jwtIssuer),
			jwt.WithAudience(jwtAudience),
			jwt.WithExpirationRequired(),
			jwt.WithIssuedAt(),
			jwt.WithLeeway(time.Minute),
		)

		if err != nil || !token.Valid {
			log.Warn("JWT validation failed", "error", err)
			http.Error(w, `{"error":"invalid or expired token"}`, http.StatusUnauthorized)
			return
		}

		claims, ok := token.Claims.(jwt.MapClaims)
		if !ok {
			http.Error(w, `{"error":"invalid token claims"}`, http.StatusUnauthorized)
			return
		}
		tokenSessionID, _ := claims["session_id"].(string)
		sessionIDFile := os.Getenv(SessionIDFileEnvVar)
		if sessionIDFile == "" {
			sessionIDFile = defaultSessionIDFile
		}
		localSessionIDBytes, readErr := os.ReadFile(sessionIDFile)
		localSessionID := strings.TrimSpace(string(localSessionIDBytes))
		if readErr != nil || localSessionID == "" {
			log.Warn("Pod session identity unavailable", "error", readErr)
			http.Error(w, `{"error":"sandbox identity unavailable"}`, http.StatusServiceUnavailable)
			return
		}
		if tokenSessionID == "" || tokenSessionID != localSessionID {
			log.Warn("JWT session binding failed")
			http.Error(w, `{"error":"token is not valid for this sandbox"}`, http.StatusForbidden)
			return
		}

		ctx := context.WithValue(r.Context(), verifiedSessionIDKey{}, tokenSessionID)
		ctx = e2b.WithRequestPolicy(ctx, policyFromClaims(claims))
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// policyFromClaims reads the sealed allow-list from a verified Router token.
// Request headers are not a source for this policy.
func policyFromClaims(claims jwt.MapClaims) e2b.RequestPolicy {
	sealed, _ := claims["sealed"].(bool)
	if !sealed {
		return e2b.RequestPolicy{}
	}
	return e2b.RequestPolicy{
		Sealed:  true,
		Inputs:  claimStrings(claims["inputs"]),
		Outputs: claimStrings(claims["outputs"]),
	}
}

func claimStrings(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if ok && text != "" {
			out = append(out, text)
		}
	}
	return out
}
