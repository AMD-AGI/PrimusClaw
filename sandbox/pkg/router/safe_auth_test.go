// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package router

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"sigs.k8s.io/agent-sandbox/pkg/safe"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

// newTestRouterWithAuth creates a Router with auth enabled, backed by a mock SaFE server.
func newTestRouterWithAuth(t *testing.T, safeHandler http.HandlerFunc) (*Server, *httptest.Server) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	safeServer := httptest.NewServer(safeHandler)
	t.Cleanup(safeServer.Close)

	memStore := store.NewMemoryStore()

	cfg := Config{
		Port:       8080,
		EnableAuth: true,
		SafeAPIURL: safeServer.URL,
	}

	s := &Server{
		cfg:        cfg,
		store:      memStore,
		safeClient: safe.NewClient(safeServer.URL),
	}

	// Setup minimal routes with auth
	s.engine = gin.New()
	s.engine.Use(gin.Recovery())

	s.engine.GET("/health", s.handleHealthLive)

	v1 := s.engine.Group("/v1")
	v1.Use(stripUntrustedIdentityHeaders())
	v1.Use(s.safeAuthMiddleware())
	v1.GET("/test", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"userId":         c.GetString("userId"),
			"userName":       c.GetString("userName"),
			"headerUserId":   c.GetHeader(UserIDHeader),
			"headerUserName": c.GetHeader(UserNameHeader),
			"headerUserRole": c.GetHeader(UserRoleHeader),
		})
	})

	return s, safeServer
}

func TestSafeAuthMiddleware_NoHeader(t *testing.T) {
	s, _ := newTestRouterWithAuth(t, func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("should not call SaFE")
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
	s.engine.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), "authentication required")
}

func TestSafeAuthMiddleware_InvalidFormat(t *testing.T) {
	s, _ := newTestRouterWithAuth(t, func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("should not call SaFE")
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
	req.Header.Set("Authorization", "Basic dXNlcjpwYXNz")
	s.engine.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), "authentication required")
}

func TestSafeAuthMiddleware_NotAPIKey(t *testing.T) {
	s, _ := newTestRouterWithAuth(t, func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("should not call SaFE")
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
	req.Header.Set("Authorization", "Bearer some-jwt-token")
	s.engine.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), "authentication required")
}

func TestSafeAuthMiddleware_ValidKey(t *testing.T) {
	s, _ := newTestRouterWithAuth(t, func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/api/v1/users/self", r.URL.Path)
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"id":   "uid-123",
			"name": "test-user",
		})
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
	req.Header.Set("Authorization", "Bearer ak-valid-key")
	s.engine.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "uid-123", resp["userId"])
	assert.Equal(t, "test-user", resp["userName"])
	assert.Equal(t, "uid-123", resp["headerUserId"])
	assert.Equal(t, "test-user", resp["headerUserName"])
	assert.Equal(t, "default", resp["headerUserRole"])
}

func TestSafeAuthMiddleware_CookiePath(t *testing.T) {
	// Browser carries SaFE Token cookie. Router validates against SaFE apiserver.
	s, _ := newTestRouterWithAuth(t, func(w http.ResponseWriter, r *http.Request) {
		// Verify the Token cookie is forwarded
		cookie, _ := r.Cookie("Token")
		assert.NotNil(t, cookie)
		assert.Equal(t, "test-token-123", cookie.Value)

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"id":   "uid-cookie-001",
			"name": "Zhang, San",
		})
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
	req.AddCookie(&http.Cookie{Name: "Token", Value: "test-token-123"})
	req.AddCookie(&http.Cookie{Name: "userType", Value: "sso"})
	s.engine.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "uid-cookie-001", resp["userId"])
	assert.Equal(t, "Zhang, San", resp["userName"])
	assert.Equal(t, "uid-cookie-001", resp["headerUserId"])
	assert.Equal(t, "Zhang, San", resp["headerUserName"])
	assert.Equal(t, "default", resp["headerUserRole"])
}

func TestSafeAuthMiddleware_FakeUserIdHeader(t *testing.T) {
	// Forged userId header should NOT be trusted — must go through cookie or API Key validation.
	s, _ := newTestRouterWithAuth(t, func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("should NOT call SaFE apiserver for requests without valid credentials")
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
	req.Header.Set("userId", "forged-user-id")
	s.engine.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestSafeAuthMiddleware_InvalidKey(t *testing.T) {
	s, _ := newTestRouterWithAuth(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"error":"invalid key"}`))
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
	req.Header.Set("Authorization", "Bearer ak-invalid-key")
	s.engine.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), "verification failed")
}

func TestSafeAuthMiddleware_HealthBypass(t *testing.T) {
	// Health endpoint should NOT require auth (it's not under /v1/)
	s, _ := newTestRouterWithAuth(t, func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("should not call SaFE for health check")
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	s.engine.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
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
