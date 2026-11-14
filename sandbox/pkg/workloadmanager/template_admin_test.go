// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/grant"
)

// serveAs sends a template request as userID with role.
func (r *wmRig) serveAs(userID, role, method, path, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(UserIDHeader, userID)
	req.Header.Set(UserRoleHeader, role)
	r.s.router.ServeHTTP(w, req)
	return w
}

// TestTemplateWritesByOwner checks that a default-role caller manages its own
// private templates, and that public templates and other users' templates
// need system-admin.
func TestTemplateWritesByOwner(t *testing.T) {
	rig := newWMRig(t, wmAdmitter(t, true), true)
	body := `{"name":"mine","namespace":"admitted","public":true,` + templateSpec + `}`
	if w := rig.serveAs("user-1", RoleDefault, http.MethodPost, "/v1/templates", body); w.Code != http.StatusCreated {
		t.Fatalf("owner create = %d, want 201: %s", w.Code, w.Body.String())
	}
	var ci runtimev1alpha1.CodeInterpreter
	if err := rig.k8s.Get(context.Background(), ctrlclient.ObjectKey{Namespace: "admitted", Name: "mine"}, &ci); err != nil {
		t.Fatal(err)
	}
	if ci.Labels[templatePublicLabelKey] == "true" {
		t.Fatal("default-role create made a public template")
	}

	path := "/v1/templates/admitted/mine"
	if w := rig.serveAs("user-1", RoleDefault, http.MethodPut, path, `{"public":true,`+templateSpec+`}`); w.Code != http.StatusForbidden {
		t.Fatalf("owner publish = %d, want 403: %s", w.Code, w.Body.String())
	}
	if w := rig.serveAs("user-2", RoleDefault, http.MethodPut, path, `{`+templateSpec+`}`); w.Code != http.StatusForbidden {
		t.Fatalf("other user update = %d, want 403: %s", w.Code, w.Body.String())
	}
	if w := rig.serveAs("user-2", RoleDefault, http.MethodDelete, path, ""); w.Code != http.StatusForbidden {
		t.Fatalf("other user delete = %d, want 403: %s", w.Code, w.Body.String())
	}
	if w := rig.serveAs("user-1", RoleDefault, http.MethodPut, path, `{`+templateSpec+`}`); w.Code != http.StatusOK {
		t.Fatalf("owner update = %d, want 200: %s", w.Code, w.Body.String())
	}
	if w := rig.serveAs("user-1", RoleDefault, http.MethodDelete, path, ""); w.Code >= 300 {
		t.Fatalf("owner delete = %d, want success: %s", w.Code, w.Body.String())
	}
	if rig.templateExists(t, "admitted", "mine") {
		t.Fatal("template still exists after owner delete")
	}
}

// workspaceMembership admits each user to the listed workspaces.
type workspaceMembership map[string][]string

// Check rejects any workspace not listed for userID.
func (m workspaceMembership) Check(_ context.Context, userID string, workspaces []string) error {
	for _, ws := range workspaces {
		if !slices.Contains(m[userID], ws) {
			return &grant.OpError{Status: http.StatusForbidden, Reason: "user_not_in_workspace", Detail: ws}
		}
	}
	return nil
}

// ReadUser reports the workspaces listed for userID; an unlisted user is not found.
func (m workspaceMembership) ReadUser(_ context.Context, userID string) (grant.OwnerUser, error) {
	ws, ok := m[userID]
	return grant.OwnerUser{Found: ok, Workspaces: ws}, nil
}

// workspaceRig serves templates with caller auth from control-plane namespace
// "admitted"; user-1 belongs to lab, multi to lab and prod, none to nothing.
func workspaceRig(t *testing.T) *wmRig {
	t.Helper()
	rig := newWMRig(t, wmAdmitter(t, true), true)
	rig.s.cfg.EnableAuth = true
	rig.s.cfg.Namespace = "admitted"
	rig.s.WithTemplateMembership(workspaceMembership{
		"user-1": {"lab"},
		"multi":  {"lab", "prod"},
		"none":   {},
	})
	return rig
}

// templateWorkspace returns the workspace label of a template in "admitted", or "" when absent.
func (r *wmRig) templateWorkspace(t *testing.T, name string) string {
	t.Helper()
	var ci runtimev1alpha1.CodeInterpreter
	if err := r.k8s.Get(context.Background(), ctrlclient.ObjectKey{Namespace: "admitted", Name: name}, &ci); err != nil {
		t.Fatalf("template %s: %v", name, err)
	}
	return ci.Labels[grant.TemplateWorkspaceLabel]
}

// TestWorkspaceTemplateCreate checks that with caller auth a non-admin template
// is stored in the control-plane namespace for one of the caller's workspaces.
func TestWorkspaceTemplateCreate(t *testing.T) {
	rig := workspaceRig(t)
	create := func(user, role, path, body string) *httptest.ResponseRecorder {
		return rig.serveAs(user, role, http.MethodPost, path, body)
	}
	tpl := func(name, extra string) string { return `{"name":"` + name + `",` + extra + templateSpec + `}` }

	if w := create("user-1", RoleDefault, "/v1/templates", tpl("t1", `"workspace":"lab",`)); w.Code != http.StatusCreated {
		t.Fatalf("create in own workspace = %d: %s", w.Code, w.Body.String())
	}
	if got := rig.templateWorkspace(t, "t1"); got != "lab" {
		t.Fatalf("workspace label = %q, want lab", got)
	}
	if w := create("user-1", RoleDefault, "/v1/templates", tpl("t2", "")); w.Code != http.StatusCreated || rig.templateWorkspace(t, "t2") != "lab" {
		t.Fatalf("create without workspace = %d, want 201 in the only workspace: %s", w.Code, w.Body.String())
	}
	for _, path := range []string{"/v1/templates", "/v1/templates/stream"} {
		if w := create("user-1", RoleDefault, path, tpl("t3", `"workspace":"prod",`)); w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "user_not_in_workspace") {
			t.Fatalf("POST %s outside own workspaces = %d: %s", path, w.Code, w.Body.String())
		}
	}
	if w := create("multi", RoleDefault, "/v1/templates", tpl("t4", "")); w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "workspace_required") {
		t.Fatalf("several workspaces without workspace = %d: %s", w.Code, w.Body.String())
	}
	for _, user := range []string{"none", "unknown"} {
		if w := create(user, RoleDefault, "/v1/templates", tpl("t5", "")); w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "user_not_in_workspace") {
			t.Fatalf("create by %s = %d: %s", user, w.Code, w.Body.String())
		}
	}
	if w := create("user-1", RoleDefault, "/v1/templates", tpl("t6", `"namespace":"other",`)); w.Code != http.StatusBadRequest {
		t.Fatalf("non-admin namespace = %d, want 400: %s", w.Code, w.Body.String())
	}
	if w := create("user-1", RoleDefault, "/v1/templates", tpl("e2b-mine", `"workspace":"lab",`)); w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "template_name_reserved") {
		t.Fatalf("reserved prefix = %d: %s", w.Code, w.Body.String())
	}
	if w := create("admin", RoleSystemAdmin, "/v1/templates", tpl("a1", `"workspace":"any-ws",`)); w.Code != http.StatusCreated || rig.templateWorkspace(t, "a1") != "any-ws" {
		t.Fatalf("admin workspace template = %d: %s", w.Code, w.Body.String())
	}
	if w := create("admin", RoleSystemAdmin, "/v1/templates", tpl("a2", `"namespace":"admitted",`)); w.Code != http.StatusCreated || rig.templateWorkspace(t, "a2") != "" {
		t.Fatalf("admin namespace template = %d: %s", w.Code, w.Body.String())
	}

	w := rig.serveAs("user-1", RoleDefault, http.MethodGet, "/v1/templates?workspace=lab", "")
	var list TemplateListResponse
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if list.TotalCount != 2 {
		t.Fatalf("workspace filter listed %d templates, want t1 and t2", list.TotalCount)
	}
}

// TestWorkspaceTemplateUpdate checks that a caller who left the template
// workspace can no longer update the template but can still delete it.
func TestWorkspaceTemplateUpdate(t *testing.T) {
	rig := workspaceRig(t)
	if w := rig.serveAs("user-1", RoleDefault, http.MethodPost, "/v1/templates", `{"name":"t1",`+templateSpec+`}`); w.Code != http.StatusCreated {
		t.Fatalf("create = %d: %s", w.Code, w.Body.String())
	}
	path := "/v1/templates/admitted/t1"
	if w := rig.serveAs("user-1", RoleDefault, http.MethodPut, path, `{`+templateSpec+`}`); w.Code != http.StatusOK {
		t.Fatalf("member update = %d: %s", w.Code, w.Body.String())
	}
	rig.s.WithTemplateMembership(workspaceMembership{"user-1": {}})
	if w := rig.serveAs("user-1", RoleDefault, http.MethodPut, path, `{`+templateSpec+`}`); w.Code != http.StatusForbidden {
		t.Fatalf("update after leaving the workspace = %d, want 403: %s", w.Code, w.Body.String())
	}
	if w := rig.serveAs("user-1", RoleDefault, http.MethodDelete, path, ""); w.Code >= 300 {
		t.Fatalf("delete after leaving the workspace = %d: %s", w.Code, w.Body.String())
	}
	rig.s.WithTemplateMembership(nil)
	if w := rig.serveAs("user-1", RoleDefault, http.MethodPost, "/v1/templates", `{"name":"t2","workspace":"lab",`+templateSpec+`}`); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("create without a membership checker = %d, want 503: %s", w.Code, w.Body.String())
	}
}

// TestWorkspaceTemplateWithoutAuth checks that without caller auth a workspace
// template is stored unchecked and a template without one keeps its namespace.
func TestWorkspaceTemplateWithoutAuth(t *testing.T) {
	rig := workspaceRig(t)
	rig.s.cfg.EnableAuth = false
	rig.s.WithTemplateMembership(workspaceMembership{})
	if w := rig.serveAs("user-1", RoleDefault, http.MethodPost, "/v1/templates", `{"name":"ws","workspace":"lab",`+templateSpec+`}`); w.Code != http.StatusCreated || rig.templateWorkspace(t, "ws") != "lab" {
		t.Fatalf("workspace template without auth = %d: %s", w.Code, w.Body.String())
	}
	if w := rig.serveAs("user-1", RoleDefault, http.MethodPost, "/v1/templates", `{"name":"brain","namespace":"admitted",`+templateSpec+`}`); w.Code != http.StatusCreated || rig.templateWorkspace(t, "brain") != "" {
		t.Fatalf("namespace template without auth = %d: %s", w.Code, w.Body.String())
	}
}

// fieldSpec returns a template spec body with extra spec and template fields.
func fieldSpec(specExtra, tmplExtra string) string {
	return `"spec":{` + specExtra + `"template":{"fromImage":"example.invalid/sandbox:1"` + tmplExtra + `}}`
}

// TestNonAdminTemplateFields checks that with caller auth a non-admin cannot
// create or update a template with host-level fields, while system-admin and
// unauthenticated callers can.
func TestNonAdminTemplateFields(t *testing.T) {
	denied := map[string]string{
		"hostPath volume":      fieldSpec("", `,"volumes":[{"name":"h","hostPath":{"path":"/"}}]`),
		"secret volume":        fieldSpec("", `,"volumes":[{"name":"s","secret":{"secretName":"x"}}]`),
		"env valueFrom":        fieldSpec("", `,"environment":[{"name":"K","valueFrom":{"secretKeyRef":{"name":"x","key":"k"}}}]`),
		"sidecars":             fieldSpec("", `,"sidecars":[{"name":"p","image":"x"}]`),
		"imagePullSecrets":     fieldSpec("", `,"imagePullSecrets":[{"name":"x"}]`),
		"runtimeClassName":     fieldSpec("", `,"runtimeClassName":"runc"`),
		"labels":               fieldSpec("", `,"labels":{"a":"b"}`),
		"annotations":          fieldSpec("", `,"annotations":{"a":"b"}`),
		"authMode":             fieldSpec(`"authMode":"none",`, ""),
		"runtimePolicy":        fieldSpec(`"runtimePolicy":"open",`, ""),
		"allowedInternalHosts": fieldSpec(`"allowedInternalHosts":["10.0.0.0/8"],`, ""),
		"warmPoolSize":         fieldSpec(`"warmPoolSize":1,`, ""),
	}
	allowed := fieldSpec(`"authMode":"envd","runtimePolicy":"agent-default",`,
		`,"volumes":[{"name":"w","emptyDir":{}}],"environment":[{"name":"K","value":"v"}]`)

	rig := workspaceRig(t)
	if w := rig.serveAs("user-1", RoleDefault, http.MethodPost, "/v1/templates", `{"name":"ok",`+allowed+`}`); w.Code != http.StatusCreated {
		t.Fatalf("allowed fields = %d: %s", w.Code, w.Body.String())
	}
	for name, spec := range denied {
		for _, path := range []string{"/v1/templates", "/v1/templates/stream"} {
			w := rig.serveAs("user-1", RoleDefault, http.MethodPost, path, `{"name":"bad",`+spec+`}`)
			if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "template_field_not_allowed") {
				t.Fatalf("POST %s with %s = %d: %s", path, name, w.Code, w.Body.String())
			}
		}
		w := rig.serveAs("user-1", RoleDefault, http.MethodPut, "/v1/templates/admitted/ok", `{`+spec+`}`)
		if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "template_field_not_allowed") {
			t.Fatalf("PUT with %s = %d: %s", name, w.Code, w.Body.String())
		}
	}
	if rig.templateExists(t, "admitted", "bad") {
		t.Fatal("a denied template was stored")
	}

	host := denied["hostPath volume"]
	if w := rig.serveAs("admin", RoleSystemAdmin, http.MethodPost, "/v1/templates", `{"name":"adm","workspace":"lab",`+host+`}`); w.Code != http.StatusCreated {
		t.Fatalf("admin hostPath = %d: %s", w.Code, w.Body.String())
	}
	rig.s.cfg.EnableAuth = false
	if w := rig.serveAs("user-1", RoleDefault, http.MethodPost, "/v1/templates", `{"name":"brain","namespace":"admitted",`+host+`}`); w.Code != http.StatusCreated {
		t.Fatalf("hostPath without auth = %d: %s", w.Code, w.Body.String())
	}
}

// TestControlPlaneSandboxNeedsSystemAdmin checks that with caller auth only
// system-admin creates a code interpreter in the control-plane namespace.
func TestControlPlaneSandboxNeedsSystemAdmin(t *testing.T) {
	rig := workspaceRig(t)
	if w := rig.serveAs("admin", RoleSystemAdmin, http.MethodPost, "/v1/templates", `{"name":"pub","namespace":"admitted","public":true,`+templateSpec+`}`); w.Code != http.StatusCreated {
		t.Fatalf("admin public template = %d: %s", w.Code, w.Body.String())
	}
	denied := func(w *httptest.ResponseRecorder) bool {
		return w.Code == http.StatusForbidden && strings.Contains(w.Body.String(), "control_plane_namespace")
	}
	for _, path := range []string{"/v1/code-interpreter", "/v1/code-interpreter/stream"} {
		for _, body := range []string{`{"name":"pub","namespace":"admitted"}`, `{"name":"pub"}`} {
			if w := rig.serveAs("user-1", RoleDefault, http.MethodPost, path, body); !denied(w) {
				t.Fatalf("non-admin POST %s %s = %d: %s", path, body, w.Code, w.Body.String())
			}
			if w := rig.serveAs("admin", RoleSystemAdmin, http.MethodPost, path, body); denied(w) {
				t.Fatalf("admin POST %s %s denied: %s", path, body, w.Body.String())
			}
		}
	}
	rig.s.cfg.EnableAuth = false
	if w := rig.serveAs("user-1", RoleDefault, http.MethodPost, "/v1/code-interpreter", `{"name":"pub","namespace":"admitted"}`); denied(w) {
		t.Fatalf("POST without auth denied: %s", w.Body.String())
	}
}

// TestPublicTemplateWritesNeedSystemAdmin checks that once a template is public
// its owner can no longer update or delete it, and system-admin still can.
func TestPublicTemplateWritesNeedSystemAdmin(t *testing.T) {
	rig := newWMRig(t, wmAdmitter(t, true), true)
	body := `{"name":"shared","namespace":"admitted",` + templateSpec + `}`
	if w := rig.serveAs("user-1", RoleDefault, http.MethodPost, "/v1/templates", body); w.Code != http.StatusCreated {
		t.Fatalf("owner create = %d, want 201: %s", w.Code, w.Body.String())
	}
	path := "/v1/templates/admitted/shared"
	if w := rig.serveAs("admin", RoleSystemAdmin, http.MethodPut, path, `{"public":true,`+templateSpec+`}`); w.Code != http.StatusOK {
		t.Fatalf("admin publish = %d, want 200: %s", w.Code, w.Body.String())
	}

	if w := rig.serveAs("user-1", RoleDefault, http.MethodPut, path, `{`+templateSpec+`}`); w.Code != http.StatusForbidden {
		t.Fatalf("owner update of a public template = %d, want 403: %s", w.Code, w.Body.String())
	}
	if w := rig.serveAs("user-1", RoleDefault, http.MethodDelete, path, ""); w.Code != http.StatusForbidden {
		t.Fatalf("owner delete of a public template = %d, want 403: %s", w.Code, w.Body.String())
	}
	if w := rig.serveAs("admin", RoleSystemAdmin, http.MethodPut, path, `{`+templateSpec+`}`); w.Code != http.StatusOK {
		t.Fatalf("admin update of a public template = %d, want 200: %s", w.Code, w.Body.String())
	}
	if w := rig.serveAs("admin", RoleSystemAdmin, http.MethodDelete, path, ""); w.Code >= 300 {
		t.Fatalf("admin delete of a public template = %d, want success: %s", w.Code, w.Body.String())
	}
}
