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
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
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
	var gotPath string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		gotPath = r.URL.Path
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
	if file.code != http.StatusForbidden {
		t.Fatalf("file=%d %s", file.code, file.body)
	}
	file = gateRequest(t, front.URL+"/files?path=/out/a", token)
	if file.code != http.StatusOK || file.body != "from-envd" {
		t.Fatalf("file=%d %s", file.code, file.body)
	}
	if got.Get("X-Sandbox-Sealed") != "" || got.Get("X-Sandbox-Inputs") != "" || got.Get("X-Sandbox-Outputs") != "" {
		t.Fatalf("sealed headers forwarded: %#v", got)
	}
	parsed, err := jwt.Parse(strings.TrimPrefix(got.Get("Authorization"), "Bearer "), func(token *jwt.Token) (any, error) {
		return mgr.publicKey, nil
	})
	if err != nil || !parsed.Valid {
		t.Fatalf("token: %v", err)
	}
	claims := parsed.Claims.(jwt.MapClaims)
	if claims["sealed"] != true || claimList(claims["inputs"]) != "/in" || claimList(claims["outputs"]) != "/out" {
		t.Fatalf("claims %#v", claims)
	}
	if got.Get("x-session-id") != "sbx-1" {
		t.Fatalf("session %q", got.Get("x-session-id"))
	}
	gotPath = ""
	rewrite := gateRequest(t, front.URL+"/filesystem.Filesystem/internal/v1/dataplane/x/api/execute", token)
	if rewrite.code != http.StatusForbidden || gotPath != "" {
		t.Fatalf("rewrite status=%d path=%q", rewrite.code, gotPath)
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

func TestE2BGateRejectsSealedDirectoryReads(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var hits atomic.Int32
	var gotBody string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		w.WriteHeader(http.StatusNoContent)
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
	token := "sat_dir"
	g := &runtimev1alpha1.SandboxGrant{ObjectMeta: metav1.ObjectMeta{Name: "gr-dir", Namespace: "ns"}}
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
	st := store.NewMemoryStore()
	if err := st.StoreSandbox(context.Background(), &store.SandboxInfo{
		SessionID: "sbx-1", PodIP: host, PodPort: port, Status: "running",
	}); err != nil {
		t.Fatal(err)
	}
	srv := &Server{store: st, grants: grant.New(grant.Options{Client: cl, Namespace: "ns", Now: time.Now})}
	srv.engine = gin.New()
	srv.engine.Use(srv.e2bAccessGate)
	front := httptest.NewServer(srv.engine)
	defer front.Close()

	denied := []struct{ path, body string }{
		{"/filesystem.Filesystem/ListDir", `{"path":"/in"}`},
		{"/filesystem.Filesystem/Stat", `{"path":"/in/.."}`},
		{"/filesystem.Filesystem/ListDir", `{"path":"/"}`},
		{"/filesystem.Filesystem/Stat", `{"path":"/work"}`},
		{"/filesystem.Filesystem/Move", `{"source":"/in/a","destination":"/out/result.json"}`},
		{"/filesystem.Filesystem/Move", `{"source":"/out/a","destination":"/in/a"}`},
		{"/filesystem.Filesystem/Remove", `{"path":"/out/result.json"}`},
		{"/filesystem.Filesystem/Remove", `{"path":"/in"}`},
		{"/filesystem.Filesystem/MakeDir", `{"path":"/out/x"}`},
		{"/filesystem.Filesystem/WatchDir", `{"path":"/out"}`},
	}
	for _, tc := range denied {
		before := hits.Load()
		code, respBody := postGate(t, front.URL+tc.path, token, "application/json", []byte(tc.body))
		if code != http.StatusForbidden || !strings.Contains(respBody, "sealed_denied") || hits.Load() != before {
			t.Fatalf("%s %s status=%d hits=%d body=%s", tc.path, tc.body, code, hits.Load(), respBody)
		}
		if strings.Contains(respBody, "/app") {
			t.Fatalf("container path leaked: %s", respBody)
		}
	}
	code, respBody := postGate(t, front.URL+"/filesystem.Filesystem/ListDir", token, "application/json", []byte(`{"path":"/out"}`))
	if code != http.StatusNoContent || hits.Load() != 1 || !strings.Contains(gotBody, "/out") {
		t.Fatalf("allowed status=%d hits=%d upstream=%s body=%s", code, hits.Load(), gotBody, respBody)
	}
	allowed := []struct{ path, body string }{
		{"/filesystem.Filesystem/MakeDir", `{"path":"/in/sub"}`},
		{"/filesystem.Filesystem/Remove", `{"path":"/in/a"}`},
		{"/filesystem.Filesystem/Move", `{"source":"/in/a","destination":"/in/b"}`},
	}
	for _, tc := range allowed {
		before := hits.Load()
		code, respBody := postGate(t, front.URL+tc.path, token, "application/json", []byte(tc.body))
		if code != http.StatusNoContent || hits.Load() != before+1 || gotBody != tc.body {
			t.Fatalf("%s %s status=%d upstream=%s body=%s", tc.path, tc.body, code, gotBody, respBody)
		}
	}
}

func postGate(t *testing.T, rawURL, token, contentType string, body []byte) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, rawURL, strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("E2b-Sandbox-Id", "sbx-1")
	req.Header.Set("X-Access-Token", token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, string(raw)
}

func claimList(value any) string {
	items, ok := value.([]any)
	if !ok || len(items) != 1 {
		return ""
	}
	text, _ := items[0].(string)
	return text
}
