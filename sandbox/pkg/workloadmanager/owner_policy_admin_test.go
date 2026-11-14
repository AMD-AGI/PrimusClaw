// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	ctrlfake "sigs.k8s.io/controller-runtime/pkg/client/fake"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/grant"
	"sigs.k8s.io/agent-sandbox/pkg/identity"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

const ownerPolicySpec = `{"fromImage":"harbor.example/runner@sha256:0123456789abcdef"}`

// newOwnerPolicyServer serves the owner policy API over a fake cluster. Tokens
// map to roles through a stand-in identity provider.
func newOwnerPolicyServer(t *testing.T, enableAuth bool) *Server {
	t.Helper()
	gin.SetMode(gin.TestMode)
	roles := map[string]string{"admin": RoleSystemAdmin, "readonly": RoleSystemAdminReadonly, "user": RoleDefault}
	idp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		role, ok := roles[r.PostForm.Get("token")]
		_ = json.NewEncoder(w).Encode(map[string]any{"active": ok, "sub": "u-" + r.PostForm.Get("token"), "roles": []string{role}})
	}))
	t.Cleanup(idp.Close)

	sch := k8sruntime.NewScheme()
	utilruntime.Must(runtimev1alpha1.AddToScheme(sch))
	utilruntime.Must(corev1.AddToScheme(sch))
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: "owner-policy", Namespace: "agent-sandbox-system"},
		Data: map[string]string{grant.OwnerPolicyKey: `{"templates":[{"name":"runner","perGpuCount":[1],"spec":` +
			ownerPolicySpec + `}]}`},
	}
	cl := ctrlfake.NewClientBuilder().WithScheme(sch).WithObjects(cm).
		WithStatusSubresource(&runtimev1alpha1.SandboxGrant{}).Build()
	grants := grant.New(grant.Options{Client: cl, Namespace: "agent-sandbox-system"})

	cfg := DefaultConfig()
	cfg.EnableAuth = enableAuth
	cfg.Identity = identity.NewClient(idp.URL, "agent-sandbox", "secret", "")
	s := New(cfg, store.NewMemoryStore())
	s.WithOwnerPolicyStore(grant.NewOwnerPolicyStore(cl, cl, "agent-sandbox-system", "owner-policy", grants, nil))
	return s
}

func serveOwnerPolicy(s *Server, method, path, token, body string, headers map[string]string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	s.router.ServeHTTP(w, req)
	return w
}

func TestOwnerPolicyAPIOnlySystemAdmin(t *testing.T) {
	s := newOwnerPolicyServer(t, true)
	put := `{"perGpuCount":[1],"spec":` + ownerPolicySpec + `}`
	for _, tc := range []struct {
		token, method, path, body string
		want                      int
	}{
		{"", http.MethodGet, ownerPolicyTemplatesPath, "", http.StatusUnauthorized},
		{"user", http.MethodGet, ownerPolicyTemplatesPath, "", http.StatusForbidden},
		{"readonly", http.MethodGet, ownerPolicyTemplatesPath, "", http.StatusForbidden},
		{"user", http.MethodPut, ownerPolicyTemplatesPath + "/extra", put, http.StatusForbidden},
		{"readonly", http.MethodDelete, ownerPolicyTemplatesPath + "/runner", "", http.StatusForbidden},
		{"admin", http.MethodGet, ownerPolicyTemplatesPath, "", http.StatusOK},
		{"admin", http.MethodPut, ownerPolicyTemplatesPath + "/extra", put, http.StatusOK},
		{"admin", http.MethodGet, ownerPolicyTemplatesPath + "/extra", "", http.StatusOK},
		{"admin", http.MethodPut, ownerPolicyTemplatesPath + "/extra", `{"name":"other","spec":` + ownerPolicySpec + `}`, http.StatusBadRequest},
		{"admin", http.MethodDelete, ownerPolicyTemplatesPath + "/extra", "", http.StatusNoContent},
		{"admin", http.MethodGet, ownerPolicyTemplatesPath + "/extra", "", http.StatusNotFound},
	} {
		w := serveOwnerPolicy(s, tc.method, tc.path, tc.token, tc.body, nil)
		if w.Code != tc.want {
			t.Fatalf("%s %s as %q = %d, want %d: %s", tc.method, tc.path, tc.token, w.Code, tc.want, w.Body.String())
		}
	}
}

func TestOwnerPolicyAPIWithoutStoreIs404(t *testing.T) {
	gin.SetMode(gin.TestMode)
	s := New(DefaultConfig(), store.NewMemoryStore())
	w := serveOwnerPolicy(s, http.MethodGet, ownerPolicyTemplatesPath, "", "", nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("no store = %d, want 404", w.Code)
	}
}

func TestOwnerPolicyAPINeedsCallerAuth(t *testing.T) {
	s := newOwnerPolicyServer(t, false)
	spoofed := map[string]string{UserIDHeader: "root", UserRoleHeader: RoleSystemAdmin}
	for _, headers := range []map[string]string{nil, spoofed} {
		w := serveOwnerPolicy(s, http.MethodGet, ownerPolicyTemplatesPath, "", "", headers)
		if w.Code != http.StatusForbidden {
			t.Fatalf("auth disabled, headers %v = %d, want 403", headers, w.Code)
		}
	}
}
