// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"crypto/rand"
	"crypto/rsa"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/require"
)

func TestJWTMiddlewareBindsTokenToPodSession(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)

	sessionFile := filepath.Join(t.TempDir(), "session-id")
	require.NoError(t, os.WriteFile(sessionFile, []byte("session-a\n"), 0o600))
	t.Setenv(SessionIDFileEnvVar, sessionFile)

	server := &Server{auth: &authManager{publicKey: &key.PublicKey}}
	handler := server.jwtMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	sign := func(sessionID, issuer, audience string) string {
		claims := jwt.MapClaims{
			"iss": issuer, "aud": audience, "session_id": sessionID,
			"iat": time.Now().Unix(), "exp": time.Now().Add(time.Minute).Unix(),
		}
		token, signErr := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(key)
		require.NoError(t, signErr)
		return token
	}

	tests := []struct {
		name       string
		token      string
		wantStatus int
	}{
		{name: "matching session", token: sign("session-a", jwtIssuer, jwtAudience), wantStatus: http.StatusNoContent},
		{name: "token replayed to another pod", token: sign("session-b", jwtIssuer, jwtAudience), wantStatus: http.StatusForbidden},
		{name: "wrong issuer", token: sign("session-a", "attacker", jwtAudience), wantStatus: http.StatusUnauthorized},
		{name: "wrong audience", token: sign("session-a", jwtIssuer, "other-service"), wantStatus: http.StatusUnauthorized},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "/api/files", nil)
			req.Header.Set("Authorization", "Bearer "+tc.token)
			req.Header.Set("x-session-id", "session-a")
			handler.ServeHTTP(rec, req)
			require.Equal(t, tc.wantStatus, rec.Code)
		})
	}
}
