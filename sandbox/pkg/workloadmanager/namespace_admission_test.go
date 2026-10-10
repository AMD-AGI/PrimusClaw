// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	"k8s.io/client-go/kubernetes/fake"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	ctrlfake "sigs.k8s.io/controller-runtime/pkg/client/fake"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/nsadmission"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

const wmAdmitLabel = "example.com/sandbox"

func wmAdmitter(t *testing.T, synced bool) *nsadmission.Admitter {
	t.Helper()
	sel, err := nsadmission.ParseSelector(wmAdmitLabel + "=enabled")
	if err != nil {
		t.Fatal(err)
	}
	a := nsadmission.New(fake.NewClientset(
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "admitted", Labels: map[string]string{wmAdmitLabel: "enabled"}}},
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "denied"}},
	), sel)
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

// existingTemplate is seeded in both namespaces so that, for the entries that
// act on an existing template, a missing admission check shows up as a 200/204
// instead of the 404 the test expects.
const existingTemplate = "existing"

type wmRig struct {
	s     *Server
	store store.Store
	k8s   ctrlclient.Client
}

func newWMRig(t *testing.T, admitter *nsadmission.Admitter, withK8s bool) *wmRig {
	t.Helper()
	gin.SetMode(gin.TestMode)
	cfg := DefaultConfig()
	cfg.Namespaces = admitter
	st := store.NewMemoryStore()
	rig := &wmRig{s: New(cfg, st), store: st}
	if withK8s {
		sch := k8sruntime.NewScheme()
		utilruntime.Must(runtimev1alpha1.AddToScheme(sch))
		var objs []ctrlclient.Object
		for _, ns := range []string{"admitted", "denied"} {
			objs = append(objs, &runtimev1alpha1.CodeInterpreter{
				ObjectMeta: metav1.ObjectMeta{Name: existingTemplate, Namespace: ns},
			})
		}
		rig.k8s = ctrlfake.NewClientBuilder().WithScheme(sch).WithObjects(objs...).Build()
		rig.s.WithK8s(&K8sSandboxCreator{client: rig.k8s})
	}
	return rig
}

func (r *wmRig) serve(method, path, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.s.router.ServeHTTP(w, req)
	return w
}

func (r *wmRig) sessions(t *testing.T) int {
	t.Helper()
	all, err := r.store.ListAllSandboxes(context.Background(), 1000)
	if err != nil {
		t.Fatal(err)
	}
	return len(all)
}

func (r *wmRig) templateExists(t *testing.T, namespace, name string) bool {
	t.Helper()
	err := r.k8s.Get(context.Background(), ctrlclient.ObjectKey{Namespace: namespace, Name: name},
		&runtimev1alpha1.CodeInterpreter{})
	return err == nil
}

// wmEntry is one namespace-scoped Workload Manager endpoint.
type wmEntry struct {
	name    string
	withK8s bool
	// request returns method, path and body targeting namespace ns.
	request func(ns string) (string, string, string)
	// admittedCode is the status an admitted namespace gets.
	admittedCode int
	// effect reports whether the request changed state in ns; nil when the
	// entry is read-only.
	effect func(t *testing.T, r *wmRig, ns string) bool
	// target is the object name the 404 names.
	target string
}

const templateSpec = `"spec":{"template":{"fromImage":"example.invalid/sandbox:1"}}`

func wmEntries() []wmEntry {
	sessionCreated := func(t *testing.T, r *wmRig, _ string) bool { return r.sessions(t) > 0 }
	return []wmEntry{
		{
			name: "POST /v1/code-interpreter",
			request: func(ns string) (string, string, string) {
				return http.MethodPost, "/v1/code-interpreter", `{"name":"tmpl","namespace":"` + ns + `"}`
			},
			admittedCode: http.StatusOK, effect: sessionCreated, target: "tmpl",
		},
		{
			name: "POST /v1/code-interpreter/stream",
			request: func(ns string) (string, string, string) {
				return http.MethodPost, "/v1/code-interpreter/stream", `{"name":"tmpl","namespace":"` + ns + `"}`
			},
			admittedCode: http.StatusOK, effect: sessionCreated, target: "tmpl",
		},
		{
			name: "POST /v1/templates", withK8s: true,
			request: func(ns string) (string, string, string) {
				return http.MethodPost, "/v1/templates", `{"name":"new","namespace":"` + ns + `",` + templateSpec + `}`
			},
			admittedCode: http.StatusCreated, target: "new",
			effect: func(t *testing.T, r *wmRig, ns string) bool { return r.templateExists(t, ns, "new") },
		},
		{
			name: "POST /v1/templates/stream", withK8s: true,
			request: func(ns string) (string, string, string) {
				return http.MethodPost, "/v1/templates/stream", `{"name":"new","namespace":"` + ns + `",` + templateSpec + `}`
			},
			admittedCode: http.StatusOK, target: "new",
			effect: func(t *testing.T, r *wmRig, ns string) bool { return r.templateExists(t, ns, "new") },
		},
		{
			name: "GET /v1/templates/:namespace/:name", withK8s: true,
			request: func(ns string) (string, string, string) {
				return http.MethodGet, "/v1/templates/" + ns + "/" + existingTemplate, ""
			},
			admittedCode: http.StatusOK, target: existingTemplate,
		},
		{
			name: "PUT /v1/templates/:namespace/:name", withK8s: true,
			request: func(ns string) (string, string, string) {
				return http.MethodPut, "/v1/templates/" + ns + "/" + existingTemplate, `{` + templateSpec + `}`
			},
			admittedCode: http.StatusOK, target: existingTemplate,
			effect: func(t *testing.T, r *wmRig, ns string) bool {
				ci := &runtimev1alpha1.CodeInterpreter{}
				if err := r.k8s.Get(context.Background(), ctrlclient.ObjectKey{Namespace: ns, Name: existingTemplate}, ci); err != nil {
					t.Fatal(err)
				}
				return ci.Spec.Template != nil && ci.Spec.Template.FromImage != ""
			},
		},
		{
			name: "DELETE /v1/templates/:namespace/:name", withK8s: true,
			request: func(ns string) (string, string, string) {
				return http.MethodDelete, "/v1/templates/" + ns + "/" + existingTemplate, ""
			},
			admittedCode: http.StatusNoContent, target: existingTemplate,
			effect: func(t *testing.T, r *wmRig, ns string) bool { return !r.templateExists(t, ns, existingTemplate) },
		},
	}
}

func TestWMAdmittedNamespaceIsServed(t *testing.T) {
	for _, e := range wmEntries() {
		t.Run(e.name, func(t *testing.T) {
			rig := newWMRig(t, wmAdmitter(t, true), e.withK8s)
			w := rig.serve(e.request("admitted"))
			if w.Code != e.admittedCode {
				t.Fatalf("admitted: got %d %s, want %d", w.Code, w.Body, e.admittedCode)
			}
			if e.effect != nil && !e.effect(t, rig, "admitted") {
				t.Fatal("admitted request had no effect")
			}
		})
	}
}

func TestWMDeniedNamespaceGets404WithoutSideEffects(t *testing.T) {
	for _, e := range wmEntries() {
		t.Run(e.name, func(t *testing.T) {
			rig := newWMRig(t, wmAdmitter(t, true), e.withK8s)
			w := rig.serve(e.request("denied"))
			var body map[string]any
			_ = json.Unmarshal(w.Body.Bytes(), &body)
			want := `CodeInterpreter "` + e.target + `" not found in namespace "denied"`
			if w.Code != http.StatusNotFound || body["error"] != want {
				t.Fatalf("denied: got %d %s, want 404 %q", w.Code, w.Body, want)
			}
			if e.effect != nil && e.effect(t, rig, "denied") {
				t.Fatal("a denied namespace was changed")
			}
		})
	}
}

func TestWMUnsyncedAdmissionFailsClosed(t *testing.T) {
	for _, e := range wmEntries() {
		t.Run(e.name, func(t *testing.T) {
			rig := newWMRig(t, wmAdmitter(t, false), e.withK8s)
			w := rig.serve(e.request("admitted"))
			var body map[string]any
			_ = json.Unmarshal(w.Body.Bytes(), &body)
			if w.Code != http.StatusServiceUnavailable || body["code"] != "namespace_admission_unavailable" {
				t.Fatalf("unsynced: got %d %s, want 503", w.Code, w.Body)
			}
			if e.effect != nil && e.effect(t, rig, "admitted") {
				t.Fatal("an unsynced cache let a change through")
			}
		})
	}
}

func TestWMWithoutSelectorAdmitsEveryNamespace(t *testing.T) {
	rig := newWMRig(t, nil, false)
	w := rig.serve(http.MethodPost, "/v1/code-interpreter", `{"name":"tmpl","namespace":"anything"}`)
	if w.Code != http.StatusOK || rig.sessions(t) != 1 {
		t.Fatalf("no selector must keep today's behaviour: %d %s", w.Code, w.Body)
	}
}
