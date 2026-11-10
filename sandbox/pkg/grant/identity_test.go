// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"context"
	"errors"
	"testing"

	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynfake "k8s.io/client-go/dynamic/fake"

	"sigs.k8s.io/agent-sandbox/pkg/authz"
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

// userCRService returns a service with workspace SAR off that reads the given Users.
func userCRService(users ...runtime.Object) *Service {
	dc := dynfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{
		userGVR: "UserList",
	}, users...)
	return New(Options{Users: NewUserCRMembership(dc)})
}

func TestSAROffChecksTheUserCR(t *testing.T) {
	svc := userCRService(userObject("user-1", "", "lab"), userObject("admin-1", SystemAdminRole, "lab"))
	ctx := context.Background()
	if err := svc.checkWorkspaces(ctx, "user-1", nil, []string{"lab"}); err != nil {
		t.Fatalf("listed workspace: %v", err)
	}
	if err := svc.checkWorkspaces(ctx, "user-1", nil, []string{"prod"}); !IsReason(err, "user_not_in_workspace") {
		t.Fatalf("unlisted workspace err=%v", err)
	}
	if err := svc.checkWorkspaces(ctx, "nobody", nil, []string{"lab"}); !IsReason(err, "user_not_in_workspace") {
		t.Fatalf("missing user err=%v", err)
	}
	if err := svc.checkWorkspaces(ctx, "admin-1", nil, []string{"prod"}); err != nil {
		t.Fatalf("system admin: %v", err)
	}
}

func TestSAROffWithoutUserReaderIsUnavailable(t *testing.T) {
	err := New(Options{}).checkWorkspaces(context.Background(), "user-1", nil, []string{"lab"})
	if !IsReason(err, "membership_unavailable") {
		t.Fatalf("err=%v", err)
	}
}

func TestSAROffOwnerWorkspaceUsesTheUserCR(t *testing.T) {
	svc := userCRService(userObject("user-1", "", "lab"))
	ctx := context.Background()
	if ws, err := svc.OwnerWorkspace(ctx, "user-1", nil, "", false); err != nil || ws != "lab" {
		t.Fatalf("only workspace = %q, %v", ws, err)
	}
	if _, err := svc.OwnerWorkspace(ctx, "user-1", nil, "prod", false); !IsReason(err, "user_not_in_workspace") {
		t.Fatalf("unlisted workspace err=%v", err)
	}
	if _, err := svc.OwnerWorkspace(ctx, "nobody", nil, "", false); !IsReason(err, "user_not_in_workspace") {
		t.Fatalf("missing user err=%v", err)
	}
	if _, err := svc.OwnerWorkspace(ctx, "admin-1", nil, "", true); !IsReason(err, "workspace_required") {
		t.Fatalf("admin without a workspace err=%v", err)
	}
	if ws, err := svc.OwnerWorkspace(ctx, "admin-1", nil, "prod", true); err != nil || ws != "prod" {
		t.Fatalf("admin workspace = %q, %v", ws, err)
	}
}

func TestSAROnAllWorkspacesStillNeedsAWorkspace(t *testing.T) {
	svc := New(Options{Authz: authz.NewClient(workspaceReviewer{allow: []string{""}}, "primus:")})
	if _, err := svc.OwnerWorkspace(context.Background(), "admin-1", nil, "", true); !IsReason(err, "workspace_required") {
		t.Fatalf("err=%v", err)
	}
}

func TestReadOwnerUserReportsSystemAdmin(t *testing.T) {
	svc := userCRService(userObject("admin-1", SystemAdminRole, "lab"))
	u, err := svc.ReadOwnerUser(context.Background(), "admin-1")
	if err != nil || u == nil || !u.Admin {
		t.Fatalf("user = %+v, %v", u, err)
	}
	if u, err := New(Options{}).ReadOwnerUser(context.Background(), "admin-1"); err != nil || u != nil {
		t.Fatalf("no reader = %+v, %v", u, err)
	}
}

// failingReviewer answers every review with an API error.
type failingReviewer struct{}

func (failingReviewer) Create(context.Context, *authorizationv1.SubjectAccessReview, metav1.CreateOptions) (*authorizationv1.SubjectAccessReview, error) {
	return nil, errors.New("apiserver down")
}

func TestMemberStillNeedsTheWorkspace(t *testing.T) {
	svc := New(Options{Authz: authz.NewClient(workspaceReviewer{allow: []string{"global-control-plane"}}, "primus:")})
	err := svc.checkWorkspaces(context.Background(), "user-1", nil, []string{"top-models"})
	if !IsReason(err, "user_not_in_workspace") {
		t.Fatalf("err=%v", err)
	}
}

func TestWorkspaceReviewErrorIsUnavailable(t *testing.T) {
	svc := New(Options{Authz: authz.NewClient(failingReviewer{}, "primus:")})
	err := svc.checkWorkspaces(context.Background(), "user-1", nil, []string{"top-models"})
	if !IsReason(err, "membership_unavailable") {
		t.Fatalf("err=%v", err)
	}
}
