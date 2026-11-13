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
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
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

// keyIdentity answers introspection of any key with tok and err.
type keyIdentity struct {
	tok identity.Token
	err error
}

func (k keyIdentity) Introspect(context.Context, string) (identity.Token, error) { return k.tok, k.err }

// ownerGrant is a grant owned by u-123 whose sealed platform key is ciphertext.
func ownerGrant(name, ciphertext string) *runtimev1alpha1.SandboxGrant {
	return &runtimev1alpha1.SandboxGrant{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "agent-sandbox-system"},
		Spec: runtimev1alpha1.SandboxGrantSpec{
			Owner:                 runtimev1alpha1.GrantOwner{UserID: "u-123", Workspaces: []string{"lab"}},
			PlatformKeyCiphertext: ciphertext,
		},
	}
}

// ownerService returns a service holding grants, with the given data key, identity and authorizer.
func ownerService(t *testing.T, dataKey []byte, idp Introspector, az Authorizer, grants ...ctrlclient.Object) *Service {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := runtimev1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	cl := fake.NewClientBuilder().WithScheme(scheme).WithObjects(grants...).Build()
	return New(Options{Client: cl, Namespace: "agent-sandbox-system", DataKey: dataKey, Identity: idp, Authz: az})
}

func TestCheckGrantOwner(t *testing.T) {
	key := bytes32('k')
	sealed, err := Seal(key, []byte("ak-owner"))
	if err != nil {
		t.Fatal(err)
	}
	owner := keyIdentity{tok: identity.Token{Subject: "u-123"}}
	member := authz.NewClient(workspaceReviewer{allow: []string{"lab"}}, "primus:")
	grants := []ctrlclient.Object{ownerGrant("gr-ok", sealed), ownerGrant("gr-nokey", ""), ownerGrant("gr-garbled", "not-a-ciphertext")}

	for _, tc := range []struct {
		name    string
		grant   string
		ws      string
		dataKey []byte
		idp     Introspector
		az      Authorizer
		reason  string
	}{
		{"missing grant", "gr-absent", "lab", key, owner, member, "grant_not_found"},
		{"no sealed key", "gr-nokey", "lab", key, owner, member, "platform_key_rejected"},
		{"no data key", "gr-ok", "lab", nil, owner, member, "grant_data_key_missing"},
		{"key that cannot be opened", "gr-garbled", "lab", key, owner, member, "grant_unseal_failed"},
		{"inactive platform key", "gr-ok", "lab", key, keyIdentity{err: identity.ErrInactive}, member, "platform_key_rejected"},
		{"identity unreachable", "gr-ok", "lab", key, keyIdentity{err: errors.New("dial tcp: refused")}, member, "identity_unavailable"},
		{"no identity client", "gr-ok", "lab", key, nil, member, "identity_unavailable"},
		{"key of another user", "gr-ok", "lab", key, keyIdentity{tok: identity.Token{Subject: "u-other"}}, member, "user_mismatch"},
		{"workspace not allowed", "gr-ok", "prod", key, owner, member, "user_not_in_workspace"},
		{"review unavailable", "gr-ok", "lab", key, owner, authz.NewClient(failingReviewer{}, "primus:"), "membership_unavailable"},
		{"no authorizer", "gr-ok", "lab", key, owner, nil, "membership_unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc := ownerService(t, tc.dataKey, tc.idp, tc.az, grants...)
			got, err := svc.CheckGrantOwner(context.Background(), tc.grant, tc.ws)
			if got != "" || !IsReason(err, tc.reason) {
				t.Fatalf("key=%q err=%v, want %s", got, err, tc.reason)
			}
		})
	}

	svc := ownerService(t, key, owner, member, grants...)
	if got, err := svc.CheckGrantOwner(context.Background(), "gr-ok", "lab"); err != nil || got != "ak-owner" {
		t.Fatalf("key=%q err=%v", got, err)
	}
}
