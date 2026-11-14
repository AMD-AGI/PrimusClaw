// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
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

// TestTemplateWritesNeedWorkspace checks that with caller auth a non-admin
// creates and updates templates only in its own workspaces.
func TestTemplateWritesNeedWorkspace(t *testing.T) {
	rig := newWMRig(t, wmAdmitter(t, true), true)
	rig.s.cfg.EnableAuth = true
	rig.s.WithTemplateMembership(workspaceMembership{"user-1": {"admitted"}})

	create := func(user, role, path string) int {
		body := `{"name":"t-` + user + `","namespace":"admitted",` + templateSpec + `}`
		return rig.serveAs(user, role, http.MethodPost, path, body).Code
	}
	for _, path := range []string{"/v1/templates", "/v1/templates/stream"} {
		if code := create("user-2", RoleDefault, path); code != http.StatusForbidden {
			t.Fatalf("POST %s outside the caller's workspaces = %d, want 403", path, code)
		}
	}
	if rig.templateExists(t, "admitted", "t-user-2") {
		t.Fatal("template created outside the caller's workspaces")
	}
	if code := create("user-1", RoleDefault, "/v1/templates"); code != http.StatusCreated {
		t.Fatalf("create in the caller's workspace = %d, want 201", code)
	}
	if code := create("admin", RoleSystemAdmin, "/v1/templates"); code != http.StatusCreated {
		t.Fatalf("system-admin create = %d, want 201", code)
	}

	path := "/v1/templates/admitted/t-user-1"
	rig.s.WithTemplateMembership(workspaceMembership{})
	if w := rig.serveAs("user-1", RoleDefault, http.MethodPut, path, `{`+templateSpec+`}`); w.Code != http.StatusForbidden {
		t.Fatalf("update after leaving the workspace = %d, want 403: %s", w.Code, w.Body.String())
	}
	if w := rig.serveAs("user-1", RoleDefault, http.MethodDelete, path, ""); w.Code >= 300 {
		t.Fatalf("delete after leaving the workspace = %d, want success: %s", w.Code, w.Body.String())
	}

	rig.s.WithTemplateMembership(nil)
	if code := create("user-1", RoleDefault, "/v1/templates"); code != http.StatusServiceUnavailable {
		t.Fatalf("create without a membership checker = %d, want 503", code)
	}
}

// TestTemplateWorkspaceUncheckedWithoutAuth checks that without caller auth
// template creation does not consult workspace membership.
func TestTemplateWorkspaceUncheckedWithoutAuth(t *testing.T) {
	rig := newWMRig(t, wmAdmitter(t, true), true)
	rig.s.WithTemplateMembership(workspaceMembership{})
	body := `{"name":"brain","namespace":"admitted",` + templateSpec + `}`
	if w := rig.serveAs("user-1", RoleDefault, http.MethodPost, "/v1/templates", body); w.Code != http.StatusCreated {
		t.Fatalf("create without caller auth = %d, want 201: %s", w.Code, w.Body.String())
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
