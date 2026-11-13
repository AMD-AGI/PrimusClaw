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
	front      *httptest.Server
	cluster    *httptest.Server
	exec       *Server
	global     *Server
	envdHits   *atomic.Int32
	envdPath   *atomic.Value
	envdAPIKey *atomic.Value
	execIDHit  *atomic.Int32
}

// newForwardPair builds a global Router that locates forwardSession on cluster cluster-a
// and a cluster-a Router in upstream-only mode that serves it.
func newForwardPair(t *testing.T, caller string) *forwardPair {
	t.Helper()
	gin.SetMode(gin.TestMode)
	p := &forwardPair{envdHits: &atomic.Int32{}, envdPath: &atomic.Value{}, envdAPIKey: &atomic.Value{}, execIDHit: &atomic.Int32{}}

	envd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.envdHits.Add(1)
		p.envdPath.Store(r.URL.Path)
		p.envdAPIKey.Store(r.Header.Get("X-API-KEY"))
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
		SessionID: forwardSession, Namespace: "ws-a", UserID: "u1",
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
	if err := p.exec.ConfigureDataPlane("cluster-a", "", string(mustPEM(t, globalJWT)), nil); err != nil {
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
	if err := p.global.ConfigureDataPlane("global", "cluster-a="+p.cluster.URL, "", nil); err != nil {
		t.Fatal(err)
	}
	p.global.WithWorkloadLocator(func(_ context.Context, name string) (string, string, string, error) {
		if name != forwardSession {
			return "", "", "", store.ErrNotFound
		}
		return "cluster-a", "ws-a", "u1", nil
	})
	p.front = httptest.NewServer(p.global.engine)
	t.Cleanup(p.front.Close)
	return p
}

// invoke posts an execute call for session to base with the given bearer credential.
func invoke(t *testing.T, base, session, credential string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost,
		base+"/v1/namespaces/ws-a/code-interpreters/"+forwardSession+"/invocations/api/execute",
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

func TestAPIKeyIsNotForwardedIntoTheSandbox(t *testing.T) {
	p := newForwardPair(t, "u1")
	req, err := http.NewRequest(http.MethodPost,
		p.front.URL+"/v1/namespaces/ws-a/code-interpreters/"+forwardSession+"/invocations/api/execute",
		strings.NewReader(`{"command":["true"]}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("x-session-id", forwardSession)
	req.Header.Set("X-API-KEY", "ak-owner")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "from-envd" {
		t.Fatalf("status=%d body=%s", resp.StatusCode, body)
	}
	if got, _ := p.envdAPIKey.Load().(string); got != "" {
		t.Fatalf("API key reached envd: %q", got)
	}
}

func TestProxyToClusterDropsAPIKey(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var gotKey, gotAuth string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey = r.Header.Get("X-API-KEY")
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	s := &Server{}
	engine := gin.New()
	engine.POST("/forward", func(c *gin.Context) {
		c.Request.Header.Set("X-API-KEY", "ak-caller")
		c.Request.Header.Set("Authorization", "Bearer caller")
		s.proxyToCluster(c, upstream.URL, "cluster-a", "hop-token")
	})
	front := httptest.NewServer(engine)
	defer front.Close()
	resp, err := http.Post(front.URL+"/forward", "text/plain", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status=%d body=%s", resp.StatusCode, body)
	}
	if gotKey != "" {
		t.Fatalf("API key reached cluster router: %q", gotKey)
	}
	if gotAuth != "Bearer hop-token" {
		t.Fatalf("hop token=%q", gotAuth)
	}
}

func TestForwardedMissDoesNotSendHopTokenToWM(t *testing.T) {
	p := newForwardPair(t, "u1")
	var wmAuth atomic.Value
	wm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wmAuth.Store(r.Header.Get("Authorization"))
		w.WriteHeader(http.StatusUnauthorized)
	}))
	t.Cleanup(wm.Close)
	emptyStore := store.NewMemoryStore()
	sm, err := NewSessionManager(emptyStore, wm.URL)
	if err != nil {
		t.Fatal(err)
	}
	p.exec.store = emptyStore
	p.exec.sessionManager = sm

	status, body := invoke(t, p.front.URL, forwardSession, "ak-owner")
	if status != http.StatusNotFound {
		t.Fatalf("status=%d body=%s", status, body)
	}
	if auth, _ := wmAuth.Load().(string); auth != "" {
		t.Fatalf("hop credential reached WM: %q", auth)
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
	token, err := p.global.jwt.generateInvokeToken("claw-other", "cluster-a", "ws-a", "u1", "", "default")
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
	token, err := p.global.jwt.generateInvokeToken(forwardSession, "other", "ws-a", "u1", "", "default")
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
	token, err := p.global.jwt.GenerateHopToken(forwardSession, "cluster-a")
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
		return "cluster-a", "ws-a", "u1", nil
	})
	if err := p.global.store.StoreSandbox(context.Background(), &store.SandboxInfo{
		SessionID: forwardSession, Namespace: "ws-a", UserID: "u1",
	}); err != nil {
		t.Fatal(err)
	}
	invoke(t, p.front.URL, forwardSession, "ak-owner")
	if located || p.envdHits.Load() != 0 {
		t.Fatalf("local session located=%v envdHits=%d", located, p.envdHits.Load())
	}
}

// countingSessionManager records how often the Router asks it for a session.
type countingSessionManager struct{ calls atomic.Int32 }

// GetSandboxBySession counts the call and reports the session as missing.
func (m *countingSessionManager) GetSandboxBySession(context.Context, string, string, string, string) (*store.SandboxInfo, error) {
	m.calls.Add(1)
	return nil, store.ErrNotFound
}

func TestLocalSessionIsResolvedOnce(t *testing.T) {
	p := newForwardPair(t, "u1")
	sm := &countingSessionManager{}
	p.global.sessionManager = sm
	if err := p.global.store.StoreSandbox(context.Background(), &store.SandboxInfo{
		SessionID: forwardSession, Namespace: "ws-a", UserID: "u1",
	}); err != nil {
		t.Fatal(err)
	}
	invoke(t, p.front.URL, forwardSession, "ak-owner")
	if n := sm.calls.Load(); n != 0 {
		t.Fatalf("session manager asked %d times for a session the store already returned", n)
	}
}

func TestUpstreamOnlyRejectsDirectE2B(t *testing.T) {
	p := newForwardPair(t, "u1")
	wmHits := &atomic.Int32{}
	wm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wmHits.Add(1)
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(wm.Close)
	p.exec.cfg.WorkloadManagerURL = wm.URL

	for _, path := range []string{"/sandboxes", "/v2/sandboxes", "/v2/sandboxes/" + forwardSession + "/connect"} {
		req, err := http.NewRequest(http.MethodPost, p.cluster.URL+path, strings.NewReader(`{}`))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("X-API-KEY", "e2b-key")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized || errorCode(string(body)) != "upstream_hop_required" {
			t.Fatalf("%s status=%d body=%s", path, resp.StatusCode, body)
		}
	}
	if wmHits.Load() != 0 {
		t.Fatal("direct E2B call reached the workload manager")
	}
}

func TestManagingRouterServesE2BLocally(t *testing.T) {
	p := newForwardPair(t, "u1")
	clusterWM := &atomic.Int32{}
	cwm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clusterWM.Add(1)
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(cwm.Close)
	p.exec.cfg.WorkloadManagerURL = cwm.URL
	var gotPath atomic.Value
	gwm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath.Store(r.URL.Path)
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(gwm.Close)
	p.global.cfg.WorkloadManagerURL = gwm.URL

	for _, path := range []string{"/sandboxes", "/v2/sandboxes/" + forwardSession + "/connect"} {
		req, err := http.NewRequest(http.MethodPost, p.front.URL+path, strings.NewReader(`{}`))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("X-API-KEY", "e2b-key")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusCreated || gotPath.Load() != path {
			t.Fatalf("%s status=%d path=%v body=%s", path, resp.StatusCode, gotPath.Load(), body)
		}
	}
	if clusterWM.Load() != 0 {
		t.Fatal("E2B control-plane call left the managing Router")
	}
}

func TestConfigureUpstreamOnlyIsOptIn(t *testing.T) {
	upstreamPEM := string(mustPEM(t, mustJWT(t)))
	cases := []struct {
		name     string
		upstream string
		raw      string
		want     bool
		wantErr  bool
	}{
		{name: "single cluster unset", raw: "", want: false},
		{name: "single cluster blank", raw: "  ", want: false},
		{name: "single cluster false", raw: "false", want: false},
		{name: "single cluster explicit on", raw: "true", wantErr: true},
		{name: "cluster Router unset", upstream: upstreamPEM, raw: "", want: false},
		{name: "cluster Router true", upstream: upstreamPEM, raw: "true", want: true},
		{name: "cluster Router false", upstream: upstreamPEM, raw: " false ", want: false},
		{name: "cluster Router invalid", upstream: upstreamPEM, raw: "yes", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := &Server{}
			if err := s.ConfigureDataPlane("cluster-a", "", tc.upstream, nil); err != nil {
				t.Fatal(err)
			}
			err := s.ConfigureUpstreamOnly(tc.raw)
			if tc.wantErr {
				if err == nil {
					t.Fatal("invalid upstream-only configuration accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if s.dp.upstreamOnly != tc.want {
				t.Fatalf("upstreamOnly = %v, want %v", s.dp.upstreamOnly, tc.want)
			}
		})
	}
}

func TestSingleClusterAcceptsDirectCaller(t *testing.T) {
	s := &Server{store: store.NewMemoryStore()}
	s.setupRoutes()
	if err := s.ConfigureDataPlane("cluster-a", "", "", nil); err != nil {
		t.Fatal(err)
	}
	if err := s.ConfigureUpstreamOnly(""); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v2/sandboxes", nil)
	s.engine.ServeHTTP(rec, req)
	if strings.Contains(rec.Body.String(), "upstream_hop_required") {
		t.Fatalf("single-cluster Router rejected a direct caller: %d %s", rec.Code, rec.Body.String())
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
