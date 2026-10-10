// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package router

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"

	"sigs.k8s.io/agent-sandbox/pkg/nsadmission"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

const admitLabel = "example.com/sandbox"

// newAdmitter returns an Admitter for admitLabel=enabled over a fake API server
// holding an admitted and a non-admitted namespace; synced controls whether
// its informer is started.
func newAdmitter(t *testing.T, synced bool) *nsadmission.Admitter {
	t.Helper()
	sel, err := nsadmission.ParseSelector(admitLabel + "=enabled")
	if err != nil {
		t.Fatal(err)
	}
	client := fake.NewClientset(
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "admitted", Labels: map[string]string{admitLabel: "enabled"}}},
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "denied"}},
	)
	a := nsadmission.New(client, sel)
	if !synced {
		return a
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	a.Start(ctx)
	deadline := time.Now().Add(10 * time.Second)
	for !a.Ready() {
		if time.Now().After(deadline) {
			t.Fatal("namespace informer did not sync")
		}
		time.Sleep(10 * time.Millisecond)
	}
	return a
}

// recordingSessionManager records every lookup, so a test can prove the
// admission check ran before the session layer -- which is where an
// auto-create would happen.
type recordingSessionManager struct {
	mu    sync.Mutex
	calls []string // "namespace|sessionID"
	info  *store.SandboxInfo
}

// GetSandboxBySession mirrors the real manager's namespace handling: an
// auto-create (no session ID) makes a sandbox in the URL namespace, while a
// session ID resolves to its sandbox wherever that lives (m.info.Namespace),
// whatever namespace the URL names.
func (m *recordingSessionManager) GetSandboxBySession(_ context.Context, sessionID, namespace, _, _ string) (*store.SandboxInfo, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls = append(m.calls, namespace+"|"+sessionID)
	info := *m.info
	if sessionID == "" {
		info.Namespace = namespace
	}
	return &info, nil
}

func (m *recordingSessionManager) setSessionNamespace(ns string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.info.Namespace = ns
}

func (m *recordingSessionManager) Calls() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.calls...)
}

type admissionRig struct {
	ts       *httptest.Server
	sessions *recordingSessionManager
	upstream *atomic.Int32
	port     string
}

// newAdmissionRig wires the real route table (setupRoutes), so removing the
// admission middleware from the namespaced group is visible here.
func newAdmissionRig(t *testing.T, admitter *nsadmission.Admitter) *admissionRig {
	t.Helper()
	gin.SetMode(gin.TestMode)

	var hits atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(upstream.Close)
	host, port, _ := net.SplitHostPort(strings.TrimPrefix(upstream.URL, "http://"))
	podPort, _ := strconv.Atoi(port)

	sessions := &recordingSessionManager{info: &store.SandboxInfo{
		SessionID: "sid-1", Namespace: "admitted", PodIP: host, PodPort: podPort,
	}}
	s := &Server{
		cfg:            Config{Namespaces: admitter},
		store:          store.NewMemoryStore(),
		sessionManager: sessions,
	}
	s.setupRoutes()
	ts := httptest.NewServer(s.engine)
	t.Cleanup(ts.Close)
	return &admissionRig{ts: ts, sessions: sessions, upstream: &hits, port: port}
}

type invokeCase struct {
	name      string
	method    string
	path      string // after .../invocations
	sessionID string
}

func invokeCases(port string) []invokeCase {
	return []invokeCase{
		{"invocation with session", http.MethodPost, "/api/execute", "sid-1"},
		// The auto-create path: POST with no x-session-id makes the session
		// manager create a sandbox.
		{"invocation without session (auto-create)", http.MethodPost, "/api/execute", ""},
		{"port proxy", http.MethodGet, "/proxy/" + port + "/mcp", "sid-1"},
	}
}

func (r *admissionRig) do(t *testing.T, tc invokeCase, namespace string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(tc.method,
		r.ts.URL+"/v1/namespaces/"+namespace+"/code-interpreters/ci/invocations"+tc.path,
		strings.NewReader(`{"command":["true"]}`))
	if tc.sessionID != "" {
		req.Header.Set("x-session-id", tc.sessionID)
	}
	resp, err := r.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body := map[string]any{}
	_ = json.NewDecoder(resp.Body).Decode(&body)
	return resp.StatusCode, body
}

func TestInvokeAdmittedNamespaceReachesSessionLayer(t *testing.T) {
	rig := newAdmissionRig(t, newAdmitter(t, true))
	for _, tc := range invokeCases(rig.port) {
		t.Run(tc.name, func(t *testing.T) {
			before := len(rig.sessions.Calls())
			code, body := rig.do(t, tc, "admitted")
			if code == http.StatusNotFound || code == http.StatusServiceUnavailable && body["code"] == "namespace_admission_unavailable" {
				t.Fatalf("admitted namespace was refused: %d %v", code, body)
			}
			calls := rig.sessions.Calls()
			if len(calls) != before+1 || calls[len(calls)-1] != "admitted|"+tc.sessionID {
				t.Fatalf("session layer not reached as expected: %v", calls)
			}
		})
	}
	// The port proxy actually reached the user service.
	if rig.upstream.Load() == 0 {
		t.Fatal("admitted port proxy never reached the upstream")
	}
}

func TestInvokeDeniedNamespaceGetsRouter404BeforeSessionLayer(t *testing.T) {
	rig := newAdmissionRig(t, newAdmitter(t, true))
	for _, tc := range invokeCases(rig.port) {
		t.Run(tc.name, func(t *testing.T) {
			for _, ns := range []string{"denied", "does-not-exist"} {
				code, body := rig.do(t, tc, ns)
				want := `CodeInterpreter "ci" not found in namespace "` + ns + `"`
				if code != http.StatusNotFound || body["error"] != want {
					t.Fatalf("%s: got %d %v, want 404 %q", ns, code, body, want)
				}
			}
		})
	}
	if calls := rig.sessions.Calls(); len(calls) != 0 {
		t.Fatalf("a denied namespace reached the session layer (lookup or auto-create): %v", calls)
	}
	if n := rig.upstream.Load(); n != 0 {
		t.Fatalf("a denied namespace reached the sandbox %d times", n)
	}
}

// A session ID resolves to its sandbox wherever that sandbox lives, so the
// URL namespace alone is not the boundary: a session from a non-admitted
// namespace, named through an admitted one, must get the same 404 and never
// reach the sandbox -- by invocation, port proxy or tunnel.
func TestInvokeSessionFromDeniedNamespaceThroughAdmittedPathGets404(t *testing.T) {
	rig := newAdmissionRig(t, newAdmitter(t, true))
	rig.sessions.setSessionNamespace("denied")
	cases := []invokeCase{
		{"invocation with session", http.MethodPost, "/api/execute", "sid-1"},
		{"port proxy", http.MethodGet, "/proxy/" + rig.port + "/mcp", "sid-1"},
		{"tunnel", http.MethodGet, "/tunnel/" + rig.port, "sid-1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, body := rig.do(t, tc, "admitted")
			want := `CodeInterpreter "ci" not found in namespace "admitted"`
			if code != http.StatusNotFound || body["error"] != want {
				t.Fatalf("got %d %v, want 404 %q", code, body, want)
			}
		})
	}
	if n := rig.upstream.Load(); n != 0 {
		t.Fatalf("a sandbox in a non-admitted namespace was reached %d times", n)
	}
}

func TestInvokeUnsyncedAdmissionFailsClosed(t *testing.T) {
	rig := newAdmissionRig(t, newAdmitter(t, false))
	for _, tc := range invokeCases(rig.port) {
		t.Run(tc.name, func(t *testing.T) {
			code, body := rig.do(t, tc, "admitted")
			if code != http.StatusServiceUnavailable || body["code"] != "namespace_admission_unavailable" {
				t.Fatalf("got %d %v, want 503 namespace_admission_unavailable", code, body)
			}
		})
	}
	if calls := rig.sessions.Calls(); len(calls) != 0 {
		t.Fatalf("an unsynced cache let requests through: %v", calls)
	}
	if n := rig.upstream.Load(); n != 0 {
		t.Fatalf("an unsynced cache let %d requests reach the sandbox", n)
	}
}

func TestInvokeWithoutSelectorAdmitsEveryNamespace(t *testing.T) {
	rig := newAdmissionRig(t, nil)
	tc := invokeCases(rig.port)[1]
	if code, body := rig.do(t, tc, "anything"); code == http.StatusNotFound {
		t.Fatalf("no selector must keep today's behaviour: %d %v", code, body)
	}
	if calls := rig.sessions.Calls(); len(calls) != 1 {
		t.Fatalf("session layer calls = %v", calls)
	}
}

func TestReadinessWaitsForNamespaceCache(t *testing.T) {
	wm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer wm.Close()

	s := newReadinessServer(t, wm.URL)
	s.cfg.Namespaces = newAdmitter(t, false)
	if w := get(t, s, "/health/ready"); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("unsynced namespace cache: ready = %d, want 503", w.Code)
	}
	s.cfg.Namespaces = newAdmitter(t, true)
	if w := get(t, s, "/health/ready"); w.Code != http.StatusOK {
		t.Fatalf("synced namespace cache: ready = %d, want 200", w.Code)
	}
}
