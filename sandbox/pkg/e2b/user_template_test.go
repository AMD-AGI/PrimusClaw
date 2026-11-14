// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package e2b

import (
	"context"
	"net/http"
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/grant"
	"sigs.k8s.io/agent-sandbox/pkg/identity"
)

// putUserTemplate stores a user template for workspace in the control-plane namespace.
func putUserTemplate(t *testing.T, cl client.Client, name, workspace, userID string, public bool, gpus int) {
	t.Helper()
	labels := map[string]string{grant.TemplateWorkspaceLabel: workspace, grant.TemplateUserLabel: userID}
	if public {
		labels[grant.TemplatePublicLabel] = "true"
	}
	ci := &runtimev1alpha1.CodeInterpreter{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "agent-sandbox-system", Labels: labels}}
	if gpus > 0 {
		ci.Spec.GPU = &runtimev1alpha1.GPUConfig{Count: gpus}
	}
	if err := cl.Create(context.Background(), ci); err != nil {
		t.Fatal(err)
	}
}

// wantNotFound fails unless err is 404 template_not_found naming id.
func wantNotFound(t *testing.T, err error, id string) {
	t.Helper()
	oe, ok := err.(*grant.OpError)
	if !ok || oe.Status != http.StatusNotFound || oe.Reason != "template_not_found" || !strings.Contains(oe.Detail, id) {
		t.Fatalf("err = %v, want 404 template_not_found for %q", err, id)
	}
}

// TestIdentityKeyUserTemplates checks that an identity key runs its own and
// public user templates in the template workspace, and that any other id is 404.
// A system-admin identity key may use any user template and pass env vars.
func TestIdentityKeyUserTemplates(t *testing.T) {
	ids := &fakeIntrospector{tokens: map[string]identity.Token{
		"ak-alice": {Subject: "u-1"},
		"ak-bob":   {Subject: "u-2"},
		"ak-admin": {Subject: "u-9", Roles: []string{"system-admin"}},
	}}
	plane, runner, cl := ownerPlane(t, ids, samplePolicy())
	ctx := context.Background()
	putUserTemplate(t, cl, "alice-tpl", "lab", "u-1", false, 2)
	putUserTemplate(t, cl, "bob-tpl", "lab", "u-2", false, 0)
	putUserTemplate(t, cl, "shared", "prod", "u-9", true, 0)

	_, _, err := plane.Create(ctx, "ak-alice", CreateBody{TemplateID: "bob-tpl"})
	wantNotFound(t, err, "bob-tpl")
	_, _, err = plane.Create(ctx, "ak-alice", CreateBody{TemplateID: "missing"})
	wantNotFound(t, err, "missing")
	if _, _, err := plane.Create(ctx, "ak-alice", CreateBody{TemplateID: "shared"}); opReason(err) != "user_not_in_workspace" {
		t.Fatalf("public template outside the caller's workspaces err = %v", err)
	}
	mismatch := CreateBody{TemplateID: "alice-tpl", Metadata: map[string]string{workspaceMetadata: "prod"}}
	if _, _, err := plane.Create(ctx, "ak-alice", mismatch); opReason(err) != "workspace_mismatch" {
		t.Fatalf("workspace other than the template's err = %v", err)
	}
	if _, _, err := plane.Create(ctx, "ak-alice", CreateBody{TemplateID: "alice-tpl", EnvVars: map[string]string{"FOO": "1"}}); opReason(err) != "env_not_allowed" {
		t.Fatalf("env on a user template err = %v", err)
	}

	if _, status, err := plane.Create(ctx, "ak-alice", CreateBody{TemplateID: "alice-tpl"}); err != nil || status != http.StatusCreated {
		t.Fatalf("own template: %d %v", status, err)
	}
	if req := runner.created[len(runner.created)-1]; req.TemplateID != "alice-tpl" || req.Workspace != "lab" || req.Namespace != "agent-sandbox-system" {
		t.Fatalf("own template request = %+v", req)
	}
	if _, _, err := plane.Create(ctx, "ak-alice", CreateBody{TemplateID: "alice-tpl"}); opReason(err) != "grant_quota_exceeded" {
		t.Fatalf("user template bypassed the owner quota: %v", err)
	}

	if _, _, err := plane.Create(ctx, "ak-bob", CreateBody{TemplateID: "shared"}); err != nil {
		t.Fatalf("public template: %v", err)
	}
	if got := runner.created[len(runner.created)-1].Workspace; got != "prod" {
		t.Fatalf("public template workspace = %q, want prod", got)
	}
	if _, _, err := plane.Create(ctx, "ak-admin", CreateBody{TemplateID: "bob-tpl", EnvVars: map[string]string{"FOO": "1"}}); err != nil {
		t.Fatalf("admin on a private template with env: %v", err)
	}
	if got := runner.created[len(runner.created)-1].Env["FOO"]; got != "1" {
		t.Fatalf("admin env FOO = %q, want 1", got)
	}
}

// TestGrantKeyUserTemplates checks that a grant key runs user templates of its
// user in a workspace the grant lists, and that any other id is 404.
func TestGrantKeyUserTemplates(t *testing.T) {
	svc, runner, keys, cl := testPlaneWithClient(t, 600, []int32{1}, 4, `{}`, []string{"top-models"})
	key := keys["measurement"]
	ctx := context.Background()
	putUserTemplate(t, cl, "g-own", "top-models", "u-123", false, 1)
	putUserTemplate(t, cl, "g-lab", "lab", "u-123", false, 0)
	putUserTemplate(t, cl, "g-foreign", "top-models", "u-999", false, 0)

	_, _, err := svc.Create(ctx, key, CreateBody{TemplateID: "g-foreign"})
	wantNotFound(t, err, "g-foreign")
	_, _, err = svc.Create(ctx, key, CreateBody{TemplateID: "missing"})
	wantNotFound(t, err, "missing")
	if _, _, err := svc.Create(ctx, key, CreateBody{TemplateID: "g-lab"}); opReason(err) != "workspace_not_allowed" {
		t.Fatalf("workspace the grant does not list err = %v", err)
	}
	if _, _, err := svc.Create(ctx, key, CreateBody{TemplateID: "g-own"}); err != nil {
		t.Fatalf("own template: %v", err)
	}
	if req := runner.created[len(runner.created)-1]; req.TemplateID != "g-own" || req.Workspace != "top-models" {
		t.Fatalf("own template request = %+v", req)
	}
}
