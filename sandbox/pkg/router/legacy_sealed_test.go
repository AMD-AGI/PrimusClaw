// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package router

import (
	"context"
	"fmt"
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
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/grant"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

// sessionsByID resolves each session id to its own sandbox record.
type sessionsByID map[string]*store.SandboxInfo

func (m sessionsByID) GetSandboxBySession(_ context.Context, sessionID, _, _, _ string) (*store.SandboxInfo, error) {
	if info, ok := m[sessionID]; ok {
		return info, nil
	}
	return nil, fmt.Errorf("session %q not found", sessionID)
}

func TestLegacyRouteRefusesSealedGrantSandbox(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var hits atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
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
	g := &runtimev1alpha1.SandboxGrant{ObjectMeta: metav1.ObjectMeta{Name: "gr-legacy", Namespace: "ns"}}
	if err := cl.Create(context.Background(), g); err != nil {
		t.Fatal(err)
	}
	g.Status.Sandboxes = []runtimev1alpha1.GrantSandboxRef{
		{ID: "sbx-sealed", Role: "measurement", State: runtimev1alpha1.SandboxRunning, Sealed: true,
			Inputs: []string{"/in"}, Outputs: []string{"/out"}},
		{ID: "sbx-open", Role: "dev", State: runtimev1alpha1.SandboxRunning},
	}
	if err := cl.Status().Update(context.Background(), g); err != nil {
		t.Fatal(err)
	}
	mgr, err := NewJWTManager(nil)
	if err != nil {
		t.Fatal(err)
	}
	sessions := sessionsByID{}
	for _, id := range []string{"sbx-sealed", "sbx-open", "sbx-missing"} {
		sessions[id] = &store.SandboxInfo{SessionID: id, PodIP: host, PodPort: port, Status: "running"}
	}
	srv := &Server{
		sessionManager: sessions,
		grants:         grant.New(grant.Options{Client: cl, Namespace: "ns", Now: time.Now}),
		jwt:            mgr,
	}
	srv.engine = gin.New()
	srv.engine.Any("/v1/namespaces/:namespace/code-interpreters/:name/invocations/*path", srv.handleCodeInterpreterInvoke)
	front := httptest.NewServer(srv.engine)
	defer front.Close()

	cases := []struct {
		name, session, method, path string
		status                      int
		code                        string
	}{
		{"session exec", "sbx-sealed", http.MethodPost, "/api/session/create", http.StatusForbidden, "sealed_denied"},
		{"terminal", "sbx-sealed", http.MethodPost, "/api/terminal/t1/send_keys", http.StatusForbidden, "sealed_denied"},
		{"files", "sbx-sealed", http.MethodGet, "/api/files?path=/in/a", http.StatusForbidden, "sealed_denied"},
		{"port proxy", "sbx-sealed", http.MethodGet, "/proxy/" + portStr + "/x", http.StatusForbidden, "sealed_denied"},
		{"tunnel", "sbx-sealed", http.MethodGet, "/tunnel/" + portStr, http.StatusForbidden, "sealed_denied"},
		{"no grant record", "sbx-missing", http.MethodPost, "/api/session/create", http.StatusForbidden, "sandbox_grant_missing"},
		{"unsealed", "sbx-open", http.MethodPost, "/api/session/create", http.StatusOK, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			before := hits.Load()
			req, err := http.NewRequest(tc.method, front.URL+"/v1/namespaces/default/code-interpreters/ci/invocations"+tc.path, nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("x-session-id", tc.session)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode != tc.status || !strings.Contains(string(body), tc.code) {
				t.Fatalf("status=%d body=%s", resp.StatusCode, body)
			}
			if reached := hits.Load() != before; reached != (tc.status == http.StatusOK) {
				t.Fatalf("upstream reached=%v", reached)
			}
		})
	}
}

func TestSessionPolicyIsCached(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := runtimev1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	cl := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&runtimev1alpha1.SandboxGrant{}).Build()
	g := &runtimev1alpha1.SandboxGrant{ObjectMeta: metav1.ObjectMeta{Name: "gr-cache", Namespace: "ns"}}
	if err := cl.Create(context.Background(), g); err != nil {
		t.Fatal(err)
	}
	g.Status.Sandboxes = []runtimev1alpha1.GrantSandboxRef{{ID: "sbx-1", Role: "measurement", Sealed: true}}
	if err := cl.Status().Update(context.Background(), g); err != nil {
		t.Fatal(err)
	}
	srv := &Server{grants: grant.New(grant.Options{Client: cl, Namespace: "ns", Now: time.Now})}
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodGet, "/", nil)
	if policy, err := srv.sessionPolicy(c, "sbx-1"); err != nil || !policy.Sealed {
		t.Fatalf("policy=%+v err=%v", policy, err)
	}
	if err := cl.Delete(context.Background(), g); err != nil {
		t.Fatal(err)
	}
	if policy, err := srv.sessionPolicy(c, "sbx-1"); err != nil || !policy.Sealed {
		t.Fatalf("cached policy=%+v err=%v", policy, err)
	}
}
