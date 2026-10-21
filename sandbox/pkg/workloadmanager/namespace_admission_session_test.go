// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"sigs.k8s.io/agent-sandbox/pkg/audit"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

// stubAuditStore answers QueryBySession with no events; nothing else is used.
type stubAuditStore struct{ audit.AuditStore }

func (stubAuditStore) Store(context.Context, *audit.AuditEvent) error { return nil }
func (stubAuditStore) QueryBySession(context.Context, string) ([]*audit.AuditEvent, error) {
	return nil, nil
}

// seedSessions stores one running session in "admitted" (sid-admitted) and
// one in "denied" (sid-denied).
func seedSessions(t *testing.T, r *wmRig) {
	t.Helper()
	now := time.Now()
	for _, ns := range []string{"admitted", "denied"} {
		if err := r.store.StoreSandbox(context.Background(), &store.SandboxInfo{
			SessionID: "sid-" + ns, SandboxName: "sb-" + ns, Namespace: ns, Status: "running",
			CreatedAt: now, LastActivity: now, ExpiresAt: now.Add(time.Hour),
		}); err != nil {
			t.Fatal(err)
		}
	}
	r.s.WithAuditStore(stubAuditStore{})
}

func (r *wmRig) session(t *testing.T, sid string) *store.SandboxInfo {
	t.Helper()
	info, err := r.store.GetSandboxBySessionID(context.Background(), sid)
	if err != nil {
		return nil
	}
	return info
}

type sessionRoute struct {
	name         string
	method, path string
	body         string
	admittedCode int
	// unchanged reports whether the session in the store is as seeded.
	unchanged func(t *testing.T, r *wmRig, sid string) bool
}

func sessionRoutes() []sessionRoute {
	present := func(t *testing.T, r *wmRig, sid string) bool { return r.session(t, sid) != nil }
	policyUnchanged := func(t *testing.T, r *wmRig, sid string) bool {
		info := r.session(t, sid)
		return info != nil && info.PolicyVersion == 0
	}
	return []sessionRoute{
		{"GET session", http.MethodGet, "/v1/code-interpreter/sessions/%s", "", http.StatusOK, present},
		{"DELETE session", http.MethodDelete, "/v1/code-interpreter/sessions/%s", "", http.StatusNoContent, present},
		{"GET policy", http.MethodGet, "/v1/sandbox/sessions/%s/policy", "", http.StatusOK, present},
		{"PATCH policy", http.MethodPatch, "/v1/sandbox/sessions/%s/policy", `{"policyMode":"audit"}`, http.StatusOK, policyUnchanged},
		{"GET logs", http.MethodGet, "/v1/sandbox/sessions/%s/logs", "", http.StatusOK, present},
	}
}

func (sr sessionRoute) url(sid string) string { return fmt.Sprintf(sr.path, sid) }

// Routes keyed by session ID are judged by the namespace the session lives
// in: a session in an admitted namespace is served, one in a namespace this
// deployment does not serve gets 403 namespace_not_admitted with no effect.
func TestWMSessionRoutesJudgeTheSessionNamespace(t *testing.T) {
	for _, sr := range sessionRoutes() {
		t.Run(sr.name, func(t *testing.T) {
			rig := newWMRig(t, wmAdmitter(t, true), false)
			seedSessions(t, rig)

			w := rig.serve(sr.method, sr.url("sid-admitted"), sr.body)
			if w.Code != sr.admittedCode {
				t.Fatalf("admitted: got %d %s, want %d", w.Code, w.Body, sr.admittedCode)
			}

			w = rig.serve(sr.method, sr.url("sid-denied"), sr.body)
			var body map[string]any
			_ = json.Unmarshal(w.Body.Bytes(), &body)
			if w.Code != http.StatusForbidden || body["code"] != "namespace_not_admitted" {
				t.Fatalf("denied: got %d %s, want 403 namespace_not_admitted", w.Code, w.Body)
			}
			if !sr.unchanged(t, rig, "sid-denied") {
				t.Fatal("a session in a non-admitted namespace was changed")
			}
		})
	}
}

func TestWMSessionRoutesFailClosedWhenUnsynced(t *testing.T) {
	for _, sr := range sessionRoutes() {
		t.Run(sr.name, func(t *testing.T) {
			rig := newWMRig(t, wmAdmitter(t, false), false)
			seedSessions(t, rig)
			w := rig.serve(sr.method, sr.url("sid-admitted"), sr.body)
			var body map[string]any
			_ = json.Unmarshal(w.Body.Bytes(), &body)
			if w.Code != http.StatusServiceUnavailable || body["code"] != "namespace_admission_unavailable" {
				t.Fatalf("unsynced: got %d %s, want 503", w.Code, w.Body)
			}
			if !sr.unchanged(t, rig, "sid-admitted") {
				t.Fatal("an unsynced cache let a change through")
			}
		})
	}
}

func TestWMSessionListShowsOnlyAdmittedNamespaces(t *testing.T) {
	rig := newWMRig(t, wmAdmitter(t, true), false)
	seedSessions(t, rig)
	for _, q := range []string{"", "?namespace=denied"} {
		w := rig.serve(http.MethodGet, "/v1/code-interpreter/sessions"+q, "")
		var resp SandboxListResponse
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil || w.Code != http.StatusOK {
			t.Fatalf("list%s: %d %s", q, w.Code, w.Body)
		}
		for _, it := range resp.Items {
			if it.Namespace != "admitted" {
				t.Fatalf("list%s showed a session in %q", q, it.Namespace)
			}
		}
		if want := map[string]int{"": 1, "?namespace=denied": 0}[q]; resp.TotalCount != want {
			t.Fatalf("list%s: totalCount %d, want %d", q, resp.TotalCount, want)
		}
	}

	unsynced := newWMRig(t, wmAdmitter(t, false), false)
	seedSessions(t, unsynced)
	if w := unsynced.serve(http.MethodGet, "/v1/code-interpreter/sessions", ""); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("unsynced list: got %d %s, want 503", w.Code, w.Body)
	}

	none := newWMRig(t, nil, false)
	seedSessions(t, none)
	w := none.serve(http.MethodGet, "/v1/code-interpreter/sessions", "")
	var resp SandboxListResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.TotalCount != 2 {
		t.Fatalf("no selector must list every session, got %d", resp.TotalCount)
	}
}

func TestWMTemplateListShowsOnlyAdmittedNamespaces(t *testing.T) {
	rig := newWMRig(t, wmAdmitter(t, true), true)
	w := rig.serve(http.MethodGet, "/v1/templates", "")
	var resp TemplateListResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil || w.Code != http.StatusOK {
		t.Fatalf("list: %d %s", w.Code, w.Body)
	}
	if resp.TotalCount != 1 || resp.Items[0].Namespace != "admitted" {
		t.Fatalf("template list = %d items %v, want only the admitted one", resp.TotalCount, resp.Items)
	}

	unsynced := newWMRig(t, wmAdmitter(t, false), true)
	if w := unsynced.serve(http.MethodGet, "/v1/templates", ""); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("unsynced template list: got %d %s, want 503", w.Code, w.Body)
	}

	none := newWMRig(t, nil, true)
	w = none.serve(http.MethodGet, "/v1/templates", "")
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.TotalCount != 2 {
		t.Fatalf("no selector must list every template, got %d", resp.TotalCount)
	}
}
