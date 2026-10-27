// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package router

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/grant"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

func TestE2BGateChecksTokenAndSealedPath(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var got http.Header
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("from-envd"))
	}))
	defer up.Close()
	host, portStr, err := net.SplitHostPort(up.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatal(err)
	}

	scheme := runtime.NewScheme()
	if err := runtimev1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	cl := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&runtimev1alpha1.SandboxGrant{}).Build()
	token := "sat_gate"
	g := &runtimev1alpha1.SandboxGrant{
		ObjectMeta: metav1.ObjectMeta{Name: "gr-gate", Namespace: "ns"},
	}
	if err := cl.Create(context.Background(), g); err != nil {
		t.Fatal(err)
	}
	g.Status.Sandboxes = []runtimev1alpha1.GrantSandboxRef{{
		ID: "sbx-1", Role: "measurement", State: runtimev1alpha1.SandboxRunning,
		AccessTokenHash: grant.HashKey(token), Sealed: true,
		Inputs: []string{"/in"}, Outputs: []string{"/out"},
	}}
	if err := cl.Status().Update(context.Background(), g); err != nil {
		t.Fatal(err)
	}
	gs := grant.New(grant.Options{Client: cl, Namespace: "ns", Now: time.Now})
	st := store.NewMemoryStore()
	if err := st.StoreSandbox(context.Background(), &store.SandboxInfo{
		SessionID: "sbx-1", PodIP: host, PodPort: port, Status: "running",
	}); err != nil {
		t.Fatal(err)
	}

	mgr, err := NewJWTManager(nil)
	if err != nil {
		t.Fatal(err)
	}
	srv := &Server{store: st, grants: gs, jwt: mgr}
	srv.engine = gin.New()
	srv.engine.Use(srv.e2bAccessGate)
	srv.engine.POST("/api/execute", func(c *gin.Context) { c.String(http.StatusTeapot, "local") })
	srv.engine.GET("/api/files", func(c *gin.Context) { c.String(http.StatusTeapot, "local") })
	front := httptest.NewServer(srv.engine)
	defer front.Close()

	execute := gateRequest(t, front.URL+"/api/execute", token)
	if execute.code != http.StatusForbidden {
		t.Fatalf("execute=%d %s", execute.code, execute.body)
	}
	file := gateRequest(t, front.URL+"/api/files?path=/out/a", token)
	if file.code != http.StatusOK || file.body != "from-envd" {
		t.Fatalf("file=%d %s", file.code, file.body)
	}
	if got.Get("X-Sandbox-Sealed") != "true" || got.Get("X-Sandbox-Inputs") != "/in" || got.Get("X-Sandbox-Outputs") != "/out" {
		t.Fatalf("sealed headers: %#v", got)
	}
	if !strings.HasPrefix(got.Get("Authorization"), "Bearer ") {
		t.Fatalf("auth %q", got.Get("Authorization"))
	}
	if got.Get("x-session-id") != "sbx-1" {
		t.Fatalf("session %q", got.Get("x-session-id"))
	}
	plain := gateRequest(t, front.URL+"/api/execute", "")
	if plain.code != http.StatusTeapot {
		t.Fatalf("plain=%d %s", plain.code, plain.body)
	}
}

type gateResult struct {
	code int
	body string
}

func gateRequest(t *testing.T, rawURL, token string) gateResult {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.HasSuffix(rawURL, "/api/execute") || strings.Contains(rawURL, "/api/execute") {
		req.Method = http.MethodPost
	}
	if token != "" {
		req.Header.Set("E2b-Sandbox-Id", "sbx-1")
		req.Header.Set("X-Access-Token", token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return gateResult{code: resp.StatusCode, body: string(body)}
}
