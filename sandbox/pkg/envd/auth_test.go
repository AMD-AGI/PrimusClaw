// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"crypto/rand"
	"crypto/rsa"
	"fmt"
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

// TestHandlerCapturesOnlyAuthenticatedTokens checks which bearer envd keeps for
// its calls to Workload Manager: the newest one Router-signed for this sandbox,
// and never one from the public health check.
func TestHandlerCapturesOnlyAuthenticatedTokens(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	sessionFile := filepath.Join(t.TempDir(), "session-id")
	require.NoError(t, os.WriteFile(sessionFile, []byte("session-a\n"), 0o600))
	t.Setenv(SessionIDFileEnvVar, sessionFile)

	sign := func(sessionID string, exp time.Duration) string {
		claims := jwt.MapClaims{
			"iss": jwtIssuer, "aud": jwtAudience, "session_id": sessionID,
			"iat": time.Now().Unix(), "exp": time.Now().Add(exp).Unix(),
		}
		token, signErr := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(key)
		require.NoError(t, signErr)
		return token
	}
	fresh := sign("session-a", 5*time.Minute)

	tests := []struct {
		name       string
		verify     bool
		path       string
		token      string
		wantStatus int
		wantKept   bool // false: the earlier token is still the one kept
	}{
		{name: "router token", verify: true, path: "/api/jobs", token: fresh, wantStatus: http.StatusOK, wantKept: true},
		{name: "health check bearer", verify: true, path: "/health", token: "forged", wantStatus: http.StatusOK},
		{name: "token for another sandbox", verify: true, path: "/api/jobs", token: sign("session-b", 5*time.Minute), wantStatus: http.StatusForbidden},
		{name: "expired token", verify: true, path: "/api/jobs", token: sign("session-a", -2*time.Minute), wantStatus: http.StatusUnauthorized},
		{name: "forged token", verify: true, path: "/api/jobs", token: "forged", wantStatus: http.StatusUnauthorized},
		{name: "no verification key", path: "/api/jobs", token: "unverified", wantStatus: http.StatusOK, wantKept: true},
		{name: "health check bearer without verification key", path: "/health", token: "unverified", wantStatus: http.StatusOK},
	}

	for _, tc := range tests {
		// Each case runs before any token is held, and after one is.
		for _, earlier := range []string{"", "earlier"} {
			t.Run(fmt.Sprintf("%s/held=%q", tc.name, earlier), func(t *testing.T) {
				s := &Server{auth: &authManager{}, inference: &inferenceKeyCache{jwtToken: earlier, ready: make(chan struct{})}}
				if tc.verify {
					s.auth.publicKey = &key.PublicKey
				}
				req := httptest.NewRequest(http.MethodGet, tc.path, nil)
				req.Header.Set("Authorization", "Bearer "+tc.token)
				rec := httptest.NewRecorder()
				s.Handler().ServeHTTP(rec, req)
				require.Equal(t, tc.wantStatus, rec.Code)
				want := earlier
				if tc.wantKept {
					want = tc.token
				}
				require.Equal(t, want, s.inference.jwtToken)
			})
		}
	}
}

// TestSessionIDComesFromTheVerifiedToken: with a verification key, the session
// envd calls Workload Manager for is the one in the token it verified, whatever
// x-session-id the first request carried. Without one, the header is all there is.
func TestSessionIDComesFromTheVerifiedToken(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	sessionFile := filepath.Join(t.TempDir(), "session-id")
	require.NoError(t, os.WriteFile(sessionFile, []byte("session-a\n"), 0o600))
	t.Setenv(SessionIDFileEnvVar, sessionFile)
	claims := jwt.MapClaims{
		"iss": jwtIssuer, "aud": jwtAudience, "session_id": "session-a",
		"iat": time.Now().Unix(), "exp": time.Now().Add(5 * time.Minute).Unix(),
	}
	token, err := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(key)
	require.NoError(t, err)

	for _, tc := range []struct {
		name   string
		verify bool
		want   string
	}{
		{name: "verified token", verify: true, want: "session-a"},
		{name: "no verification key", want: "session-other"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &Server{auth: &authManager{}, inference: &inferenceKeyCache{ready: make(chan struct{})}}
			if tc.verify {
				s.auth.publicKey = &key.PublicKey
			}
			req := httptest.NewRequest(http.MethodGet, "/api/jobs", nil)
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("x-session-id", "session-other")
			rec := httptest.NewRecorder()
			s.Handler().ServeHTTP(rec, req)
			require.Equal(t, http.StatusOK, rec.Code)
			require.Equal(t, tc.want, s.inference.getSessionID())
		})
	}
}
