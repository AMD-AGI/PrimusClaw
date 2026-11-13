// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"context"
	"errors"
	"testing"
	"time"

	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynfake "k8s.io/client-go/dynamic/fake"

	"sigs.k8s.io/agent-sandbox/pkg/authz"
	"sigs.k8s.io/agent-sandbox/pkg/identity"
	"sigs.k8s.io/agent-sandbox/pkg/usercr"
)

// userObject builds a SaFE User listing one workspace and an optional role.
func userObject(name, role, workspace string) *unstructured.Unstructured {
	spec := map[string]any{
		"resources": map[string]any{"workspaces": []any{workspace}},
	}
	if role != "" {
		spec["roles"] = []any{role}
	}
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "amd.com/v1",
		"kind":       "User",
		"metadata":   map[string]any{"name": name},
		"spec":       spec,
	}}
}

// userCRService returns a service whose authorizer reads the given Users.
func userCRService(users ...runtime.Object) *Service {
	dc := dynfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{
		usercr.UserGVR: "UserList",
	}, users...)
	return New(Options{Authz: usercr.New(dc)})
}

func TestUserCRChecksTheListedWorkspace(t *testing.T) {
	svc := userCRService(userObject("user-1", "", "lab"), userObject("admin-1", identity.RoleSystemAdmin, "lab"))
	ctx := context.Background()
	if err := svc.checkWorkspaces(ctx, identity.Token{Subject: "user-1"}, []string{"lab"}); err != nil {
		t.Fatalf("listed workspace: %v", err)
	}
	if err := svc.checkWorkspaces(ctx, identity.Token{Subject: "user-1"}, []string{"prod"}); !IsReason(err, "user_not_in_workspace") {
		t.Fatalf("unlisted workspace err=%v", err)
	}
	if err := svc.checkWorkspaces(ctx, identity.Token{Subject: "nobody"}, []string{"lab"}); !IsReason(err, "user_not_in_workspace") {
		t.Fatalf("missing user err=%v", err)
	}
	if err := svc.checkWorkspaces(ctx, identity.Token{Subject: "admin-1"}, []string{"prod"}); err != nil {
		t.Fatalf("system admin: %v", err)
	}
}

func TestNoAuthorizerIsUnavailable(t *testing.T) {
	err := New(Options{}).checkWorkspaces(context.Background(), identity.Token{Subject: "user-1"}, []string{"lab"})
	if !IsReason(err, "membership_unavailable") {
		t.Fatalf("err=%v", err)
	}
}

func TestUserCROwnerWorkspaceUsesTheUser(t *testing.T) {
	svc := userCRService(userObject("user-1", "", "lab"))
	ctx := context.Background()
	if ws, err := svc.OwnerWorkspace(ctx, identity.Token{Subject: "user-1"}, ""); err != nil || ws != "lab" {
		t.Fatalf("only workspace = %q, %v", ws, err)
	}
	if _, err := svc.OwnerWorkspace(ctx, identity.Token{Subject: "user-1"}, "prod"); !IsReason(err, "user_not_in_workspace") {
		t.Fatalf("unlisted workspace err=%v", err)
	}
	if _, err := svc.OwnerWorkspace(ctx, identity.Token{Subject: "nobody"}, ""); !IsReason(err, "user_not_in_workspace") {
		t.Fatalf("missing user err=%v", err)
	}
	admin := identity.Token{Subject: "admin-1", Roles: []string{identity.RoleSystemAdmin}}
	if _, err := svc.OwnerWorkspace(ctx, admin, ""); !IsReason(err, "workspace_required") {
		t.Fatalf("admin without a workspace err=%v", err)
	}
	if ws, err := svc.OwnerWorkspace(ctx, admin, "prod"); err != nil || ws != "prod" {
		t.Fatalf("admin workspace = %q, %v", ws, err)
	}
}

func TestSARWithoutARequestedWorkspaceIsRequired(t *testing.T) {
	svc := New(Options{Authz: authz.NewClient(workspaceReviewer{allow: []string{"lab", ""}}, "primus:")})
	if _, err := svc.OwnerWorkspace(context.Background(), identity.Token{Subject: "user-1"}, ""); !IsReason(err, "workspace_required") {
		t.Fatalf("err=%v", err)
	}
}

// failingReviewer answers every review with an API error.
type failingReviewer struct{}

func (failingReviewer) Create(context.Context, *authorizationv1.SubjectAccessReview, metav1.CreateOptions) (*authorizationv1.SubjectAccessReview, error) {
	return nil, errors.New("apiserver down")
}

func TestMemberStillNeedsTheWorkspace(t *testing.T) {
	svc := New(Options{Authz: authz.NewClient(workspaceReviewer{allow: []string{"lab"}}, "primus:")})
	err := svc.checkWorkspaces(context.Background(), identity.Token{Subject: "user-1"}, []string{"prod"})
	if !IsReason(err, "user_not_in_workspace") {
		t.Fatalf("err=%v", err)
	}
}

func TestWorkspaceReviewErrorIsUnavailable(t *testing.T) {
	svc := New(Options{Authz: authz.NewClient(failingReviewer{}, "primus:")})
	err := svc.checkWorkspaces(context.Background(), identity.Token{Subject: "user-1"}, []string{"lab"})
	if !IsReason(err, "membership_unavailable") {
		t.Fatalf("err=%v", err)
	}
}

func TestValidateIssueRejectsAnEmptyWorkspaceName(t *testing.T) {
	now := time.Now()
	req := IssueRequest{
		GrantID:     "gr-ok",
		Owner:       OwnerRequest{UserID: "u-1", Workspaces: []string{"lab", ""}},
		Issuer:      IssuerRequest{AppRunID: "ar-1"},
		Roles:       map[string]RoleRequest{"dev": {}},
		ExpiresAt:   now.Add(time.Hour),
		Attestation: "a",
		PlatformKey: "ak",
	}
	if err := validateIssue(req, now); !IsReason(err, "invalid_grant") {
		t.Fatalf("err=%v", err)
	}
}
