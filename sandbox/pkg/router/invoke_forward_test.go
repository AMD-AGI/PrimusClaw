// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package router

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/gin-gonic/gin"

	"sigs.k8s.io/agent-sandbox/pkg/identity"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

const forwardSession = "claw-brain-1"

// forwardPair is a managing Router in front of one cluster Router and its sandbox.
type forwardPair struct {
	front     *httptest.Server
	cluster   *httptest.Server
	exec      *Server
	global    *Server
	envdHits  *atomic.Int32
	envdPath  *atomic.Value
	execIDHit *atomic.Int32
}

// newForwardPair builds a global Router that locates forwardSession on cluster crusoe
// and a crusoe Router in upstream-only mode that serves it.
func newForwardPair(t *testing.T, caller string) *forwardPair {
	t.Helper()
	gin.SetMode(gin.TestMode)
	p := &forwardPair{envdHits: &atomic.Int32{}, envdPath: &atomic.Value{}, execIDHit: &atomic.Int32{}}

	envd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.envdHits.Add(1)
		p.envdPath.Store(r.URL.Path)
		_, _ = w.Write([]byte("from-envd"))
	}))
	t.Cleanup(envd.Close)

	globalJWT := mustJWT(t)
	execID := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.execIDHit.Add(1)
		introspectAnswer("u1", "u1@example.com")(w, r)
	}))
	t.Cleanup(execID.Close)
	execStore := store.NewMemoryStore()
	if err := execStore.StoreSandbox(context.Background(), &store.SandboxInfo{
		SessionID: forwardSession, Namespace: "crusoe-ws", UserID: "u1",
		PodIP: envdHost(t, envd), PodPort: envdPort(t, envd),
	}); err != nil {
		t.Fatal(err)
	}
	sm, err := NewSessionManager(execStore, "http://127.0.0.1:1")
	if err != nil {
		t.Fatal(err)
	}
	p.exec = &Server{
		cfg:            Config{EnableAuth: true, Identity: identity.NewClient(execID.URL, "agent-sandbox", "secret", "")},
		store:          execStore,
		sessionManager: sm,
		jwt:            mustJWT(t),
	}
	p.exec.setupRoutes()
	if err := p.exec.ConfigureDataPlane("crusoe", "", string(mustPEM(t, globalJWT)), nil); err != nil {
		t.Fatal(err)
	}
	if err := p.exec.SetUpstreamOnly(true); err != nil {
		t.Fatal(err)
	}
	p.cluster = httptest.NewServer(p.exec.engine)
	t.Cleanup(p.cluster.Close)

	globalID := httptest.NewServer(introspectAnswer(caller, caller+"@example.com"))
	t.Cleanup(globalID.Close)
	p.global = &Server{
		cfg:   Config{EnableAuth: true, Identity: identity.NewClient(globalID.URL, "agent-sandbox", "secret", "")},
		store: store.NewMemoryStore(),
		jwt:   globalJWT,
	}
	p.global.setupRoutes()
	if err := p.global.ConfigureDataPlane("global", "crusoe="+p.cluster.URL, "", nil); err != nil {
		t.Fatal(err)
	}
	p.global.WithWorkloadLocator(func(_ context.Context, name string) (string, string, string, error) {
		if name != forwardSession {
			return "", "", "", store.ErrNotFound
		}
		return "crusoe", "crusoe-ws", "u1", nil
	})
	p.front = httptest.NewServer(p.global.engine)
	t.Cleanup(p.front.Close)
	return p
}

// invoke posts an execute call for session to base with the given bearer credential.
func invoke(t *testing.T, base, session, credential string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost,
		base+"/v1/namespaces/crusoe-ws/code-interpreters/"+forwardSession+"/invocations/api/execute",
		strings.NewReader(`{"command":["true"]}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("x-session-id", session)
	req.Header.Set("Authorization", "Bearer "+credential)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}

// errorCode returns the "code" field of a JSON error body.
func errorCode(body string) string {
	var out struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal([]byte(body), &out)
	return out.Code
}

func TestForwardRemoteInvocationReachesClusterSandbox(t *testing.T) {
	p := newForwardPair(t, "u1")
	status, body := invoke(t, p.front.URL, forwardSession, "ak-owner")
	if status != http.StatusOK || body != "from-envd" {
		t.Fatalf("status=%d body=%s", status, body)
	}
	if got, _ := p.envdPath.Load().(string); got != "/api/execute" {
		t.Fatalf("envd path=%q", got)
	}
	if p.execIDHit.Load() != 0 {
		t.Fatal("cluster Router introspected a forwarded invocation")
	}
}

func TestForwardRemoteInvocationDeniesNonOwner(t *testing.T) {
	p := newForwardPair(t, "intruder")
	status, body := invoke(t, p.front.URL, forwardSession, "ak-other")
	if status != http.StatusForbidden || errorCode(body) != "caller_not_session_owner" {
		t.Fatalf("status=%d body=%s", status, body)
	}
	if p.envdHits.Load() != 0 {
		t.Fatal("sandbox reached for a non-owner")
	}
}

func TestUpstreamOnlyRejectsDirectCaller(t *testing.T) {
	p := newForwardPair(t, "u1")
	status, body := invoke(t, p.cluster.URL, forwardSession, "ak-owner")
	if status != http.StatusUnauthorized || errorCode(body) != "upstream_hop_required" {
		t.Fatalf("status=%d body=%s", status, body)
	}
	if p.envdHits.Load() != 0 || p.execIDHit.Load() != 0 {
		t.Fatal("direct caller reached the sandbox or identity")
	}
}

func TestInvokeTokenIsBoundToItsSession(t *testing.T) {
	p := newForwardPair(t, "u1")
	token, err := p.global.jwt.generateInvokeToken("claw-other", "crusoe", "crusoe-ws", "u1", "", "default")
	if err != nil {
		t.Fatal(err)
	}
	status, body := invoke(t, p.cluster.URL, forwardSession, token)
	if status != http.StatusForbidden || errorCode(body) != "invoke_hop_mismatch" {
		t.Fatalf("status=%d body=%s", status, body)
	}
}

func TestInvokeTokenForAnotherClusterIsRejected(t *testing.T) {
	p := newForwardPair(t, "u1")
	token, err := p.global.jwt.generateInvokeToken(forwardSession, "other", "crusoe-ws", "u1", "", "default")
	if err != nil {
		t.Fatal(err)
	}
	status, body := invoke(t, p.cluster.URL, forwardSession, token)
	if status != http.StatusUnauthorized || errorCode(body) != "upstream_hop_required" {
		t.Fatalf("status=%d body=%s", status, body)
	}
}

func TestDataPlaneHopTokenIsNotAnInvokeToken(t *testing.T) {
	p := newForwardPair(t, "u1")
	token, err := p.global.jwt.GenerateHopToken(forwardSession, "crusoe")
	if err != nil {
		t.Fatal(err)
	}
	status, body := invoke(t, p.cluster.URL, forwardSession, token)
	if status != http.StatusUnauthorized || errorCode(body) != "upstream_hop_required" {
		t.Fatalf("status=%d body=%s", status, body)
	}
}

func TestLocalSessionIsNotForwarded(t *testing.T) {
	p := newForwardPair(t, "u1")
	located := false
	p.global.WithWorkloadLocator(func(context.Context, string) (string, string, string, error) {
		located = true
		return "crusoe", "crusoe-ws", "u1", nil
	})
	if err := p.global.store.StoreSandbox(context.Background(), &store.SandboxInfo{
		SessionID: forwardSession, Namespace: "crusoe-ws", UserID: "u1",
	}); err != nil {
		t.Fatal(err)
	}
	invoke(t, p.front.URL, forwardSession, "ak-owner")
	if located || p.envdHits.Load() != 0 {
		t.Fatalf("local session located=%v envdHits=%d", located, p.envdHits.Load())
	}
}

func TestUpstreamOnlyFromEnv(t *testing.T) {
	if !UpstreamOnlyFromEnv("") || !UpstreamOnlyFromEnv("true") || !UpstreamOnlyFromEnv("  ") {
		t.Fatal("upstream-only defaults on")
	}
	if UpstreamOnlyFromEnv("false") || UpstreamOnlyFromEnv(" false ") {
		t.Fatal("the exact value false turns upstream-only off")
	}
}

func TestSetUpstreamOnlyRequiresUpstreamKey(t *testing.T) {
	s := &Server{}
	if err := s.SetUpstreamOnly(true); err == nil {
		t.Fatal("upstream-only accepted without an upstream key")
	}
	if err := s.SetUpstreamOnly(false); err != nil {
		t.Fatal(err)
	}
}
