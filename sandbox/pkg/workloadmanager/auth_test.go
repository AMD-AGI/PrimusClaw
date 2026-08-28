// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"

	"sigs.k8s.io/agent-sandbox/pkg/safe"
)

func newAuthTestServer(t *testing.T, safeHandler http.HandlerFunc) (*gin.Engine, *httptest.Server) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	safeServer := httptest.NewServer(safeHandler)
	t.Cleanup(safeServer.Close)

	s := &Server{safeClient: safe.NewClient(safeServer.URL)}
	engine := gin.New()
	engine.Use(s.safeAuthMiddleware())
	engine.GET("/v1/test", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"userId":   c.GetString("userId"),
			"userRole": c.GetString("userRole"),
		})
	})
	return engine, safeServer
}

func TestSafeAuthMiddlewareRejectsForgedIdentityHeaders(t *testing.T) {
	engine, _ := newAuthTestServer(t, func(http.ResponseWriter, *http.Request) {
		t.Fatal("SaFE must not be called without a credential")
	})

	req := httptest.NewRequest(http.MethodGet, "/v1/test", nil)
	req.Header.Set(UserIDHeader, "victim")
	req.Header.Set(UserRoleHeader, RoleSystemAdmin)
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestForLogNeutralizesForgedRecords(t *testing.T) {
	forged := "10.0.0.1\nlevel=INFO msg=\"WM: SaFE auth OK\" userId=admin"
	got := forLog(forged)

	assert.NotContains(t, got, "\n")
	assert.NotContains(t, got, "\r")
	assert.Contains(t, got, "10.0.0.1")

	long := forLog(strings.Repeat("a", maxLoggedValueLen*2))
	assert.Len(t, long, maxLoggedValueLen+len("...(truncated)"))
}

func TestSafeAuthMiddlewareOverwritesSpoofedRole(t *testing.T) {
	engine, _ := newAuthTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"id":    "verified-user",
			"name":  "Verified User",
			"roles": []string{"default"},
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
