// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package router

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"sigs.k8s.io/agent-sandbox/pkg/identity"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

// introspectAnswer writes an RFC 7662 answer for an active key owned by sub.
func introspectAnswer(sub, email string, roles ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"active": true, "sub": sub, "email": email, "roles": roles,
		})
	}
}

// inactiveAnswer writes the RFC 7662 answer for a key identity does not accept.
func inactiveAnswer(w http.ResponseWriter, _ *http.Request) {
	_ = json.NewEncoder(w).Encode(map[string]any{"active": false})
}

// newTestRouterWithAuth creates a Router with auth enabled, backed by a stand-in identity introspection endpoint.
func newTestRouterWithAuth(t *testing.T, introspect http.HandlerFunc) (*Server, *httptest.Server) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	idServer := httptest.NewServer(introspect)
	t.Cleanup(idServer.Close)

	s := &Server{
		cfg: Config{
			Port:       8080,
			EnableAuth: true,
			Identity:   identity.NewClient(idServer.URL, "agent-sandbox", "secret", ""),
		},
		store: store.NewMemoryStore(),
	}

	s.engine = gin.New()
	s.engine.Use(gin.Recovery())
	s.engine.GET("/health", s.handleHealthLive)

	v1 := s.engine.Group("/v1")
	v1.Use(stripUntrustedIdentityHeaders())
	v1.Use(s.callerAuthMiddleware())
	v1.GET("/test", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"userId":         c.GetString("userId"),
			"userName":       c.GetString("userName"),
			"headerUserId":   c.GetHeader(UserIDHeader),
			"headerUserName": c.GetHeader(UserNameHeader),
			"headerUserRole": c.GetHeader(UserRoleHeader),
		})
	})

	return s, idServer
}

func TestCallerAuth_NoHeader(t *testing.T) {
	s, _ := newTestRouterWithAuth(t, func(http.ResponseWriter, *http.Request) {
		t.Fatal("should not call identity")
	})

	w := httptest.NewRecorder()
	s.engine.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/test", nil))

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), "authentication required")
}

func TestCallerAuth_NotBearer(t *testing.T) {
	s, _ := newTestRouterWithAuth(t, func(http.ResponseWriter, *http.Request) {
		t.Fatal("should not call identity")
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
	req.Header.Set("Authorization", "Basic dXNlcjpwYXNz")
	s.engine.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), "authentication required")
}

func TestCallerAuth_ValidKey(t *testing.T) {
	var calls atomic.Int32
	s, _ := newTestRouterWithAuth(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		require.NoError(t, r.ParseForm())
		assert.Equal(t, "ak-valid-key", r.PostForm.Get("token"))
		user, pass, ok := r.BasicAuth()
		assert.True(t, ok)
		assert.Equal(t, "agent-sandbox", user)
		assert.Equal(t, "secret", pass)
		introspectAnswer("uid-123", "test-user@example.com", "default")(w, r)
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
	req.Header.Set("Authorization", "Bearer ak-valid-key")
	s.engine.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "uid-123", resp["userId"])
	assert.Equal(t, "test-user@example.com", resp["userName"])
	assert.Equal(t, "uid-123", resp["headerUserId"])
	assert.Equal(t, "test-user@example.com", resp["headerUserName"])
	assert.Equal(t, "default", resp["headerUserRole"])
	assert.EqualValues(t, 1, calls.Load())
}

func TestCallerAuth_AccessTokenIsIntrospected(t *testing.T) {
	s, _ := newTestRouterWithAuth(t, introspectAnswer("uid-admin", "", "default", "system-admin"))

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
	req.Header.Set("Authorization", "Bearer eyJhbGciOiJFUzI1NiJ9.e30.sig")
	s.engine.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "uid-admin", resp["headerUserId"])
	assert.Equal(t, "system-admin", resp["headerUserRole"])
}

func TestCallerAuth_InactiveCredential(t *testing.T) {
	s, _ := newTestRouterWithAuth(t, inactiveAnswer)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
	req.Header.Set("Authorization", "Bearer hands-token-not-a-platform-credential")
	s.engine.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), "caller_credential_invalid")
}

func TestCallerAuth_IdentityUnavailable(t *testing.T) {
	s, _ := newTestRouterWithAuth(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
	req.Header.Set("Authorization", "Bearer ak-valid-key")
	s.engine.ServeHTTP(w, req)

	assert.Equal(t, http.StatusServiceUnavailable, w.Code)
	assert.Contains(t, w.Body.String(), "caller_auth_unavailable")
}

func TestCallerAuth_NoIdentityClientFailsClosed(t *testing.T) {
	gin.SetMode(gin.TestMode)
	s := &Server{cfg: Config{EnableAuth: true}, store: store.NewMemoryStore()}
	engine := gin.New()
	engine.GET("/v1/test", s.callerAuthMiddleware(), func(c *gin.Context) { c.Status(http.StatusOK) })

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
	req.Header.Set("Authorization", "Bearer ak-valid-key")
	engine.ServeHTTP(w, req)

	assert.Equal(t, http.StatusServiceUnavailable, w.Code)
}

func TestCallerAuth_CookieIsNotACredential(t *testing.T) {
	s, _ := newTestRouterWithAuth(t, func(http.ResponseWriter, *http.Request) {
		t.Fatal("should not call identity")
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
	req.AddCookie(&http.Cookie{Name: "Token", Value: "test-token-123"})
	s.engine.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestCallerAuth_FakeUserIdHeader(t *testing.T) {
	s, _ := newTestRouterWithAuth(t, func(http.ResponseWriter, *http.Request) {
		t.Fatal("should not call identity for requests without a credential")
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
	req.Header.Set("userId", "forged-user-id")
	s.engine.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestCallerAuth_HealthBypass(t *testing.T) {
	s, _ := newTestRouterWithAuth(t, func(http.ResponseWriter, *http.Request) {
		t.Fatal("should not call identity for health check")
	})

	w := httptest.NewRecorder()
	s.engine.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/health", nil))

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestSetupRoutesRegistersCallerAuth(t *testing.T) {
	gin.SetMode(gin.TestMode)
	idServer := httptest.NewServer(http.HandlerFunc(inactiveAnswer))
	t.Cleanup(idServer.Close)

	cfg := DefaultConfig()
	cfg.EnableAuth = true
	cfg.Identity = identity.NewClient(idServer.URL, "agent-sandbox", "secret", "")
	s := &Server{cfg: cfg, store: store.NewMemoryStore()}
	s.setupRoutes()

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/code-interpreter/sessions", nil)
	req.Header.Set(UserIDHeader, "upstream-user")
	s.engine.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestIdentityHeadersPreservedWhenAuthDisabled(t *testing.T) {
	forwardedHeaders := make(chan http.Header, 1)
	wmServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		forwardedHeaders <- r.Header.Clone()
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(wmServer.Close)

	cfg := DefaultConfig()
	cfg.WorkloadManagerURL = wmServer.URL
	s := &Server{
		cfg:   cfg,
		store: store.NewMemoryStore(),
	}
	s.setupRoutes()

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/code-interpreter", nil)
	req.Header.Set(UserIDHeader, "upstream-user")
	req.Header.Set(UserNameHeader, "Upstream User")
	req.Header.Set(UserRoleHeader, "system-admin-readonly")
	s.engine.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	headers := <-forwardedHeaders
	assert.Equal(t, "upstream-user", headers.Get(UserIDHeader))
	assert.Equal(t, "Upstream User", headers.Get(UserNameHeader))
	assert.Equal(t, "system-admin-readonly", headers.Get(UserRoleHeader))
}
