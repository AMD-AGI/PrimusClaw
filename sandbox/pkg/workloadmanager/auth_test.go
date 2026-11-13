// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"

	"sigs.k8s.io/agent-sandbox/pkg/authz"
	"sigs.k8s.io/agent-sandbox/pkg/identity"
	"sigs.k8s.io/agent-sandbox/pkg/usercr"
)

func newAuthTestServer(t *testing.T, introspect http.HandlerFunc) *gin.Engine {
	t.Helper()
	return newAuthTestServerWith(t, introspect, nil)
}

// newAuthTestServerWith builds the middleware test engine with src resolving the platform role.
func newAuthTestServerWith(t *testing.T, introspect http.HandlerFunc, src authz.RoleSource) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	idServer := httptest.NewServer(introspect)
	t.Cleanup(idServer.Close)

	s := &Server{cfg: Config{EnableAuth: true, Identity: identity.NewClient(idServer.URL, "agent-sandbox", "secret", ""), Authz: src}}
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

// userReader answers every User read with user and err.
type userReader struct {
	user usercr.User
	err  error
}

func (r userReader) Read(context.Context, string) (usercr.User, error) { return r.user, r.err }

// defaultCaller answers introspection for an active key with the default role.
func defaultCaller(w http.ResponseWriter, _ *http.Request) {
	_ = json.NewEncoder(w).Encode(map[string]any{"active": true, "sub": "verified-user", "roles": []string{"default"}})
}

func TestCallerAuthMiddlewareRoleFromTokenWithoutAuthorizer(t *testing.T) {
	engine := newAuthTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"active": true, "sub": "verified-user", "roles": []string{"default", RoleSystemAdmin}})
	})

	req := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
	req.Header.Set("Authorization", "Bearer ak-valid")
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"userRole":"`+RoleSystemAdmin+`"`)
}

func TestCallerAuthMiddlewareUserAuthorizerUpgradesRole(t *testing.T) {
	engine := newAuthTestServerWith(t, defaultCaller, usercr.NewFromReader(userReader{user: usercr.User{Found: true, Admin: true}}))

	req := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
	req.Header.Set("Authorization", "Bearer ak-valid")
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"userRole":"`+RoleSystemAdmin+`"`)
}

func TestCallerAuthMiddlewareUserReadUnavailable(t *testing.T) {
	engine := newAuthTestServerWith(t, defaultCaller, usercr.NewFromReader(userReader{err: fmt.Errorf("%w: apiserver down", authz.ErrUnavailable)}))

	req := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
	req.Header.Set("Authorization", "Bearer ak-valid")
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
	assert.Contains(t, rec.Body.String(), "membership_unavailable")
}
