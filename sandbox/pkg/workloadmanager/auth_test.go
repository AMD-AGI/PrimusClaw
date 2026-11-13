// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"

	"sigs.k8s.io/agent-sandbox/pkg/identity"
)

func newAuthTestServer(t *testing.T, introspect http.HandlerFunc) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	idServer := httptest.NewServer(introspect)
	t.Cleanup(idServer.Close)

	s := &Server{cfg: Config{EnableAuth: true, Identity: identity.NewClient(idServer.URL, "agent-sandbox", "secret", "")}}
	engine := gin.New()
	engine.Use(s.callerAuthMiddleware())
	engine.GET("/v1/test", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"userId":   c.GetString("userId"),
			"userRole": c.GetString("userRole"),
		})
	})
	return engine
}

func TestCallerAuthMiddlewareRejectsForgedIdentityHeaders(t *testing.T) {
	engine := newAuthTestServer(t, func(http.ResponseWriter, *http.Request) {
		t.Fatal("identity must not be called without a credential")
	})

	req := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
	req.Header.Set(UserIDHeader, "victim")
	req.Header.Set(UserRoleHeader, RoleSystemAdmin)
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestCallerAuthMiddlewareOverwritesSpoofedRole(t *testing.T) {
	engine := newAuthTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"active": true,
			"sub":    "verified-user",
			"roles":  []string{"default"},
		})
	})

	req := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
	req.Header.Set("Authorization", "Bearer ak-valid")
	req.Header.Set(UserIDHeader, "victim")
	req.Header.Set(UserRoleHeader, RoleSystemAdmin)
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"userId":"verified-user"`)
	assert.Contains(t, rec.Body.String(), `"userRole":"default"`)
}

func TestCallerAuthMiddlewareAcceptsAPIKeyHeader(t *testing.T) {
	engine := newAuthTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		assert.Equal(t, "ak-header", r.PostForm.Get("token"))
		_ = json.NewEncoder(w).Encode(map[string]any{
			"active": true,
			"sub":    "key-user",
			"roles":  []string{"default"},
		})
	})

	req := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
	req.Header.Set("X-API-KEY", "ak-header")
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"userId":"key-user"`)
}

func TestCallerAuthMiddlewareRejectsInactiveCredential(t *testing.T) {
	engine := newAuthTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"active": false})
	})

	req := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
	req.Header.Set("Authorization", "Bearer not-a-platform-credential")
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestCallerAuthMiddlewareIdentityUnavailable(t *testing.T) {
	engine := newAuthTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})

	req := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
	req.Header.Set("Authorization", "Bearer ak-valid")
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
}
