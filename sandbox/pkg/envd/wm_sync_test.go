// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"k8s.io/client-go/kubernetes/fake"

	"sigs.k8s.io/agent-sandbox/pkg/audit"
	"sigs.k8s.io/agent-sandbox/pkg/envd/egress"
	"sigs.k8s.io/agent-sandbox/pkg/router"
	"sigs.k8s.io/agent-sandbox/pkg/store"
	"sigs.k8s.io/agent-sandbox/pkg/workloadmanager"
)

// inProcessScheme routes envd's Workload Manager calls to a WM handler in this
// process, so the whole exchange runs inside a synctest bubble on its fake clock.
const inProcessScheme = "wm-inproc"

var wmTransport = &inProcessWM{}

func init() {
	gin.SetMode(gin.TestMode)
	http.DefaultTransport.(*http.Transport).RegisterProtocol(inProcessScheme, wmTransport)
}

type inProcessWM struct {
	mu      sync.Mutex
	handler http.Handler
	calls   []string
	fault   map[string]wmFault // per internal API
}

// wmFault is how WM fails calls to one internal API.
type wmFault struct {
	refuse int  // answer the next refuse calls 401
	down   bool // the connection fails
	hang   bool // no answer until the caller gives up
}

func (p *inProcessWM) RoundTrip(req *http.Request) (*http.Response, error) {
	api, _, _ := strings.Cut(strings.TrimPrefix(req.URL.Path, "/v1/internal/"), "/")
	p.mu.Lock()
	h, fault := p.handler, p.fault[api]
	if fault.refuse > 0 {
		f := p.fault[api]
		f.refuse--
		p.fault[api] = f
	}
	p.mu.Unlock()
	switch {
	case fault.down:
		p.record(api + " down")
		return nil, fmt.Errorf("dial workload manager: connection refused")
	case fault.hang:
		<-req.Context().Done()
		p.record(api + " hung")
		return nil, req.Context().Err()
	}
	rec := httptest.NewRecorder()
	if fault.refuse > 0 {
		rec.WriteHeader(http.StatusUnauthorized)
	} else {
		served := req.Clone(req.Context())
		served.RequestURI = req.URL.RequestURI()
		h.ServeHTTP(rec, served)
	}
	p.record(fmt.Sprintf("%s %d", api, rec.Code))
	return rec.Result(), nil
}

func (p *inProcessWM) record(call string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls = append(p.calls, call)
}

func (p *inProcessWM) use(h http.Handler) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.handler, p.calls, p.fault = h, nil, map[string]wmFault{}
}

func (p *inProcessWM) setFault(api string, f wmFault) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.fault[api] = f
}

// summary counts WM's answers per internal API, e.g. "policy 200=2 401=1".
func (p *inProcessWM) summary() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	counts := map[string]int{}
	for _, c := range p.calls {
		counts[c]++
	}
	keys := make([]string, 0, len(counts))
	for k := range counts {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s x%d", k, counts[k]))
	}
	return strings.Join(parts, ", ")
}

func (p *inProcessWM) count(status int) int {
	return p.countCalls(fmt.Sprintf(" %d", status))
}

// countCalls counts calls whose record ends in suffix, e.g. "audit hung".
func (p *inProcessWM) countCalls(suffix string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := 0
	for _, c := range p.calls {
		if strings.HasSuffix(c, suffix) {
			n++
		}
	}
	return n
}

type recordingAuditStore struct {
	mu      sync.Mutex
	domains []string
}

func (r *recordingAuditStore) Store(_ context.Context, e *audit.AuditEvent) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if e.Egress != nil {
		r.domains = append(r.domains, e.Egress.Domain+"@"+e.Timestamp.Format(time.RFC3339))
	}
	return nil
}

func (r *recordingAuditStore) delivered() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.domains...)
}

func (*recordingAuditStore) QueryBySession(context.Context, string) ([]*audit.AuditEvent, error) {
	return nil, nil
}

func (*recordingAuditStore) QueryByTimeRange(context.Context, time.Time, time.Time, audit.QueryOptions) (*audit.QueryResult, error) {
	return nil, nil
}

func (*recordingAuditStore) DeleteBefore(context.Context, time.Time) (int64, error) { return 0, nil }

const (
	syncSessionID    = "sess_wm_sync"
	syncInferenceKey = "sk-wm-sync"
)

// wmSyncHarness is one sandbox: an EnvD built by New with egress on, the
// Router's signer, and Workload Manager's real routes behind the in-process
// transport.
type wmSyncHarness struct {
	t      *testing.T
	jm     *router.JWTManager
	envd   *Server
	wm     http.Handler
	audits *recordingAuditStore
}

func newWMSyncHarness(t *testing.T, jm *router.JWTManager) *wmSyncHarness {
	t.Helper()
	st := store.NewMemoryStore()
	require.NoError(t, st.StoreSandbox(context.Background(), &store.SandboxInfo{
		SessionID: syncSessionID, SandboxName: "sbx", Namespace: "default",
		RuntimePolicy: "agent-default", PolicyMode: "enforce",
		AllowedEgressHosts: []string{"v1.example"}, PolicyVersion: 1,
		InferenceApiKey: syncInferenceKey,
	}))
	audits := &recordingAuditStore{}
	cfg := workloadmanager.DefaultConfig()
	cfg.Inference.Enabled = true
	wm := workloadmanager.New(cfg, st).WithAuditStore(audits).Handler()
	wmTransport.use(wm)

	s, err := New(Config{EgressEnabled: true})
	require.NoError(t, err)
	return &wmSyncHarness{t: t, jm: jm, envd: s, wm: wm, audits: audits}
}

// routerRequest is what the Router's proxy sends EnvD: a freshly signed JWT and
// the session header, here on the path Claw's keepalive probes.
func (h *wmSyncHarness) routerRequest() {
	h.t.Helper()
	token, err := h.jm.GenerateToken(syncSessionID)
	require.NoError(h.t, err)
	h.request("/api/jobs", "Bearer "+token, http.StatusOK)
}

func (h *wmSyncHarness) request(path, authorization string, want int) {
	h.t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", authorization)
	req.Header.Set("x-session-id", syncSessionID)
	rec := httptest.NewRecorder()
	h.envd.Handler().ServeHTTP(rec, req)
	require.Equal(h.t, want, rec.Code, "envd %s", path)
}

func (h *wmSyncHarness) patchPolicy(host string) {
	h.t.Helper()
	req := httptest.NewRequest(http.MethodPatch, "/v1/sandbox/sessions/"+syncSessionID+"/policy",
		strings.NewReader(`{"allowedEgressHosts":["`+host+`"]}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.wm.ServeHTTP(rec, req)
	require.Equal(h.t, http.StatusOK, rec.Code, rec.Body.String())
}

func (h *wmSyncHarness) deny(domain string) {
	h.envd.auditReporter.ReportDecision(egress.DecisionEvent{Action: "deny", Stage: "policy", Domain: domain})
}

// childHasInferenceKey reports whether a command started now gets the session's
// inference API key.
func (h *wmSyncHarness) childHasInferenceKey() bool {
	for _, kv := range h.envd.buildChildEnv(nil) {
		if kv == "OPENAI_API_KEY="+syncInferenceKey {
			return true
		}
	}
	return false
}

func (h *wmSyncHarness) appliedHosts() []string {
	return h.envd.policyEngine.GetConfig().AllowedEgressHosts
}

// TestEnvDStaysInSyncWithWMPastRouterTokenTTL runs the Router's signer, Workload
// Manager's internal API and EnvD's capture, policy syncer and audit uploader
// together on a fake clock, so a session can outlive the 5 minute Router token.
// The sync workers are started by startWMSync, as Server.Run does once its
// privileged egress setup is done; that setup and the proxy's own decision
// reporting are not exercised here.
func TestEnvDStaysInSyncWithWMPastRouterTokenTTL(t *testing.T) {
	cs := fake.NewClientset()
	jm, err := router.NewJWTManager(cs)
	require.NoError(t, err)
	require.NoError(t, jm.EnsureJWTIdentity(context.Background()))
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	workloadmanager.InitPublicKeyCache(ctx, cs)
	require.Eventually(t, workloadmanager.IsPublicKeyCached, 10*time.Second, 10*time.Millisecond)
	pub, err := jm.GetPublicKeyPEM()
	require.NoError(t, err)

	sessionFile := filepath.Join(t.TempDir(), "session-id")
	require.NoError(t, os.WriteFile(sessionFile, []byte(syncSessionID), 0o600))
	t.Setenv(SessionIDFileEnvVar, sessionFile)
	t.Setenv("WORKLOAD_MANAGER_URL", inProcessScheme+"://workload-manager")

	scenarios := []struct {
		name string
		run  func(t *testing.T, h *wmSyncHarness)
	}{
		{
			// Requests keep arriving (Claw's keepalive probes every minute), so
			// a fresh token is always at hand.
			name: "active session past the token TTL",
			run: func(t *testing.T, h *wmSyncHarness) {
				h.routerRequest()
				synctest.Wait()
				require.Equal(t, []string{"v1.example"}, h.appliedHosts())
				for range 10 {
					time.Sleep(time.Minute)
					h.routerRequest()
				}
				h.patchPolicy("v2.example")
				h.deny("blocked.example")
				time.Sleep(31 * time.Second)
				synctest.Wait()
				assert.Equal(t, []string{"v2.example"}, h.appliedHosts(), "policy update not applied; WM answered: %s", wmTransport.summary())
				assert.Equal(t, []string{"blocked.example@2000-01-01T00:10:00Z"}, h.audits.delivered(), "audit event lost; WM answered: %s", wmTransport.summary())
			},
		},
		{
			// An agent's background shell runs for hours with nothing sent
			// through the Router: WM cannot be reached until the next request,
			// and must not be polled with a token it already refused.
			name: "idle for hours, then a request",
			run: func(t *testing.T, h *wmSyncHarness) {
				h.routerRequest()
				synctest.Wait()
				time.Sleep(time.Hour)
				h.patchPolicy("v2.example")
				h.deny("during-idle.example")
				time.Sleep(time.Hour)
				synctest.Wait()
				assert.Equal(t, []string{"v1.example"}, h.appliedHosts(), "last good policy must stay in force while WM is unreachable")
				assert.Empty(t, h.audits.delivered())
				assert.LessOrEqual(t, wmTransport.count(http.StatusUnauthorized), 2, "WM polled with a refused token: %s", wmTransport.summary())

				// The request that ends the idle period delivers what was held at
				// once: the sandbox may be torn down right after it.
				h.routerRequest()
				synctest.Wait()
				assert.Equal(t, []string{"during-idle.example@2000-01-01T01:00:00Z"}, h.audits.delivered(), "audit event from the idle period not delivered on resume; WM answered: %s", wmTransport.summary())
				time.Sleep(31 * time.Second)
				synctest.Wait()
				assert.Equal(t, []string{"v2.example"}, h.appliedHosts(), "policy update not applied after the session resumed; WM answered: %s", wmTransport.summary())
			},
		},
		{
			// A warm-pool Pod starts long before it is claimed and sees its
			// first request.
			name: "first request long after start",
			run: func(t *testing.T, h *wmSyncHarness) {
				time.Sleep(10 * time.Minute)
				h.routerRequest()
				time.Sleep(time.Second)
				synctest.Wait()
				assert.Equal(t, []string{"v1.example"}, h.appliedHosts(), "session policy never synced; WM answered: %s", wmTransport.summary())
			},
		},
		{
			// /health is public: whatever bearer it carries was never verified.
			name: "unverified bearer on /health",
			run: func(t *testing.T, h *wmSyncHarness) {
				h.routerRequest()
				synctest.Wait()
				time.Sleep(time.Minute)
				h.routerRequest()
				h.request("/health", "Bearer forged", http.StatusOK)
				h.patchPolicy("v2.example")
				time.Sleep(31 * time.Second)
				synctest.Wait()
				assert.Equal(t, []string{"v2.example"}, h.appliedHosts(), "WM answered: %s", wmTransport.summary())
			},
		},
		{
			// WM refuses the token of the first fetch: its key cache has not
			// caught up with a rotated Router key, or a concurrent audit
			// upload had the same token refused first.
			name: "first policy fetch refused",
			run: func(t *testing.T, h *wmSyncHarness) {
				wmTransport.setFault("policy", wmFault{refuse: 1})
				h.routerRequest()
				synctest.Wait()
				time.Sleep(time.Minute)
				h.routerRequest()
				synctest.Wait()
				assert.True(t, h.childHasInferenceKey(), "inference API key never fetched; WM answered: %s", wmTransport.summary())
				time.Sleep(31 * time.Second)
				synctest.Wait()
				assert.Equal(t, []string{"v1.example"}, h.appliedHosts(), "WM answered: %s", wmTransport.summary())
			},
		},
		{
			// A Workload Manager rollout: connections fail for 30 seconds.
			name: "WM unreachable for a rollout",
			run: func(t *testing.T, h *wmSyncHarness) {
				h.routerRequest()
				synctest.Wait()
				wmTransport.setFault("audit", wmFault{down: true})
				h.deny("during-rollout.example")
				time.Sleep(30 * time.Second)
				synctest.Wait()
				wmTransport.setFault("audit", wmFault{})
				time.Sleep(auditRetryInterval + time.Second)
				synctest.Wait()
				assert.Equal(t, []string{"during-rollout.example@2000-01-01T00:00:00Z"}, h.audits.delivered(), "WM answered: %s", wmTransport.summary())
			},
		},
		{
			// WM accepts connections but never answers. A burst of denials
			// arrives while an upload waits for it, then one a second for a
			// minute: the newest decisions must be the ones kept, and WM is not
			// retried back to back.
			name: "WM hangs while denials pile up",
			run: func(t *testing.T, h *wmSyncHarness) {
				h.routerRequest()
				synctest.Wait()
				wmTransport.setFault("audit", wmFault{hang: true})
				const total = maxHeldAuditEvents + 44
				for i := range total {
					h.deny(fmt.Sprintf("d%d.example", i))
					time.Sleep(10 * time.Millisecond)
				}
				const trickle = 60
				for i := range trickle {
					h.deny(fmt.Sprintf("t%d.example", i))
					time.Sleep(time.Second)
				}
				hung := wmTransport.countCalls("audit hung")
				assert.LessOrEqual(t, hung, 5, "WM retried without backing off: %s", wmTransport.summary())
				// An upload hung when WM recovered times out, and the retry
				// follows one interval later.
				wmTransport.setFault("audit", wmFault{})
				h.routerRequest()
				time.Sleep(5*time.Second + auditRetryInterval + time.Second)
				synctest.Wait()
				var all, delivered []string
				for i := range total {
					all = append(all, fmt.Sprintf("d%d.example", i))
				}
				for i := range trickle {
					all = append(all, fmt.Sprintf("t%d.example", i))
				}
				for _, d := range h.audits.delivered() {
					domain, _, _ := strings.Cut(d, "@")
					delivered = append(delivered, domain)
				}
				assert.Equal(t, all[len(all)-maxHeldAuditEvents:], delivered, "the newest denials must be the ones kept; WM answered: %s", wmTransport.summary())
			},
		},
	}

	for _, authMode := range []string{"envd", "none"} {
		for _, sc := range scenarios {
			t.Run(authMode+"/"+sc.name, func(t *testing.T) {
				if authMode == "envd" {
					t.Setenv(PublicKeyEnvVar, string(pub))
				} else {
					t.Setenv(PublicKeyEnvVar, "")
				}
				synctest.Test(t, func(t *testing.T) {
					h := newWMSyncHarness(t, jm)
					ctx, cancel := context.WithCancel(context.Background())
					h.envd.startWMSync(ctx)
					sc.run(t, h)
					cancel()
				})
			})
		}
	}
}
