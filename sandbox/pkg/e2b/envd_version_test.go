// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package e2b

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// The E2B SDK gates close_stdin at envd 0.5.2; 0.1.0 made it refuse the call
// before it reached EnvD.
func TestCreateAndConnectReportTheEnvdVersion(t *testing.T) {
	gin.SetMode(gin.TestMode)
	svc, _, keys := testPlane(t, 600, []int32{1}, 2)
	r := gin.New()
	NewHandler(svc).Mount(r)
	key := keys["measurement"]

	do := func(method, path, body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-API-KEY", key)
		r.ServeHTTP(w, req)
		return w
	}
	var created struct {
		SandboxID   string `json:"sandboxID"`
		EnvdVersion string `json:"envdVersion"`
	}
	w := do(http.MethodPost, "/v2/sandboxes", `{"templateID":"ar-01ja-runner-g1","timeout":30}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("create=%d %s", w.Code, w.Body.String())
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.EnvdVersion != "0.5.2" {
		t.Fatalf("create envdVersion=%q", created.EnvdVersion)
	}

	var connected struct {
		EnvdVersion string `json:"envdVersion"`
	}
	w = do(http.MethodPost, "/v2/sandboxes/"+created.SandboxID+"/connect", `{"timeout":30}`)
	if w.Code/100 != 2 {
		t.Fatalf("connect=%d %s", w.Code, w.Body.String())
	}
	if err := json.Unmarshal(w.Body.Bytes(), &connected); err != nil {
		t.Fatal(err)
	}
	if connected.EnvdVersion != "0.5.2" {
		t.Fatalf("connect envdVersion=%q", connected.EnvdVersion)
	}
}

// From envd 0.1.5 the SDK asks the control plane for metrics. None are
// collected, so the route must fail rather than answer an empty series.
func TestMetricsAreRefusedNotEmpty(t *testing.T) {
	gin.SetMode(gin.TestMode)
	svc, _, keys := testPlane(t, 600, []int32{1}, 2)
	r := gin.New()
	NewHandler(svc).Mount(r)
	key := keys["measurement"]

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/sandboxes", strings.NewReader(`{"templateID":"ar-01ja-runner-g1","timeout":30}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-KEY", key)
	r.ServeHTTP(w, req)
	var created struct {
		SandboxID string `json:"sandboxID"`
	}
	if w.Code != http.StatusCreated || json.Unmarshal(w.Body.Bytes(), &created) != nil {
		t.Fatalf("create=%d %s", w.Code, w.Body.String())
	}
	for _, prefix := range []string{"/sandboxes/", "/v2/sandboxes/"} {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, prefix+created.SandboxID+"/metrics", nil)
		req.Header.Set("X-API-KEY", key)
		r.ServeHTTP(w, req)
		if w.Code != http.StatusNotImplemented || !strings.Contains(w.Body.String(), `"reason":"unimplemented"`) {
			t.Fatalf("%s metrics=%d %s", prefix, w.Code, w.Body.String())
		}
	}
}
