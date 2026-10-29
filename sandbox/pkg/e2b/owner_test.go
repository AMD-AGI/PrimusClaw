// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package e2b

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/grant"
	"sigs.k8s.io/agent-sandbox/pkg/identity"
)

// fakeIntrospector maps keys to tokens. A missing key is inactive.
type fakeIntrospector struct {
	tokens map[string]identity.Token
	err    error
	calls  int
}

func (f *fakeIntrospector) Introspect(_ context.Context, key string) (identity.Token, error) {
	f.calls++
	if f.err != nil {
		return identity.Token{}, f.err
	}
	tok, ok := f.tokens[key]
	if !ok {
		return identity.Token{}, identity.ErrInactive
	}
	return tok, nil
}

// listMembership allows the workspaces listed per user.
type listMembership map[string][]string

func (m listMembership) Check(_ context.Context, userID string, workspaces []string) error {
	for _, ws := range workspaces {
		if !contains(m[userID], ws) {
			return grant.Op(http.StatusForbidden, "user_not_in_workspace", ws)
		}
	}
	return nil
}

func (m listMembership) Workspaces(_ context.Context, userID string) ([]string, error) {
	return m[userID], nil
}

func ownerPlane(t *testing.T, ids *fakeIntrospector, policy grant.OwnerPolicy) (*Service, *fakeRunner, client.Client) {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := runtimev1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	cl := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&runtimev1alpha1.SandboxGrant{}).Build()
	gs := grant.New(grant.Options{
		Client: cl, Namespace: "agent-sandbox-system",
		Membership: listMembership{"u-1": {"lab"}, "u-2": {"lab", "prod"}},
	})
	if err := gs.SetOwnerPolicy(context.Background(), policy); err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{}
	return New(Options{Grants: gs, Runner: runner, Namespace: "agent-sandbox-system", Identity: ids}), runner, cl
}

func samplePolicy() grant.OwnerPolicy {
	return grant.OwnerPolicy{
		Templates: []grant.TemplateRequest{{
			Name: "runner", PerGPUCount: []int32{1},
			Spec: json.RawMessage(`{"fromImage":"harbor.example/runner@sha256:0123456789abcdef","resources":{"requests":{"cpu":"1","memory":"1Gi"}}}`),
		}},
		Default: &grant.OwnerQuota{MaxSandboxes: 1, MaxGPUs: 8, MaxSandboxSeconds: 3600},
		Owners:  map[string]grant.OwnerQuota{"u-2": {MaxSandboxes: 2, MaxGPUs: 8, MaxSandboxSeconds: 3600}},
	}
}

func opReason(err error) string {
	if oe, ok := err.(*grant.OpError); ok {
		return oe.Reason
	}
	return ""
}

func TestIdentityKeyCreatesUnderOwnerQuota(t *testing.T) {
	ids := &fakeIntrospector{tokens: map[string]identity.Token{"ak-alice": {Subject: "u-1", Email: "alice@example.com"}}}
	plane, runner, cl := ownerPlane(t, ids, samplePolicy())
	ctx := context.Background()

	resp, status, err := plane.Create(ctx, "ak-alice", CreateBody{TemplateID: "runner"})
	if err != nil || status != http.StatusCreated {
		t.Fatalf("create: %d %v", status, err)
	}
	if len(runner.created) != 1 {
		t.Fatalf("runner calls = %d", len(runner.created))
	}
	req := runner.created[0]
	owner := grant.OwnerGrantName("u-1")
	if req.Workspace != "lab" || req.GrantID != owner || req.SessionID != owner || !req.OwnerKey || req.Role != "e2b" || req.UserID != "u-1" || req.TemplateID != "e2b-runner-g1" {
		t.Fatalf("create request = %+v", req)
	}
	var g runtimev1alpha1.SandboxGrant
	if err := cl.Get(ctx, types.NamespacedName{Name: owner, Namespace: "agent-sandbox-system"}, &g); err != nil {
		t.Fatal(err)
	}
	if g.Labels[grant.OwnerKeyLabel] != "true" || g.Spec.Owner.UserName != "alice@example.com" || g.Status.Usage["e2b"].Sandboxes != 1 {
		t.Fatalf("owner record = %+v %+v", g.Labels, g.Status.Usage)
	}
	var ci runtimev1alpha1.CodeInterpreter
	if err := cl.Get(ctx, types.NamespacedName{Name: "e2b-runner-g1", Namespace: "agent-sandbox-system"}, &ci); err != nil {
		t.Fatalf("template not registered: %v", err)
	}

	if _, _, err := plane.Create(ctx, "ak-alice", CreateBody{TemplateID: "runner"}); opReason(err) != "grant_quota_exceeded" {
		t.Fatalf("second create err = %v", err)
	}
	if _, err := plane.Get(ctx, "ak-alice", resp.SandboxID); err != nil {
		t.Fatalf("get: %v", err)
	}
	if err := plane.Kill(ctx, "ak-alice", resp.SandboxID); err != nil {
		t.Fatalf("kill: %v", err)
	}
	if _, _, err := plane.Create(ctx, "ak-alice", CreateBody{TemplateID: "runner"}); err != nil {
		t.Fatalf("create after kill: %v", err)
	}
}

func TestIdentityKeyWorkspaceSelection(t *testing.T) {
	ids := &fakeIntrospector{tokens: map[string]identity.Token{
		"ak-bob":   {Subject: "u-2"},
		"ak-alice": {Subject: "u-1"},
		"ak-admin": {Subject: "u-9", Roles: []string{"system-admin"}},
	}}
	plane, runner, _ := ownerPlane(t, ids, samplePolicy())
	ctx := context.Background()
	ws := func(name string) CreateBody {
		return CreateBody{TemplateID: "runner", Metadata: map[string]string{workspaceMetadata: name}}
	}

	if _, _, err := plane.Create(ctx, "ak-bob", CreateBody{TemplateID: "runner"}); opReason(err) != "workspace_required" {
		t.Fatalf("multi-workspace without metadata err = %v", err)
	}
	if _, _, err := plane.Create(ctx, "ak-alice", ws("prod")); opReason(err) != "user_not_in_workspace" {
		t.Fatalf("non-member err = %v", err)
	}
	if _, _, err := plane.Create(ctx, "ak-bob", ws("prod")); err != nil {
		t.Fatalf("member create: %v", err)
	}
	if _, _, err := plane.Create(ctx, "ak-admin", ws("any-ws")); err != nil {
		t.Fatalf("admin create: %v", err)
	}
	if got := runner.created[len(runner.created)-1].Workspace; got != "any-ws" {
		t.Fatalf("admin workspace = %q", got)
	}
}

func TestBuiltInQuotas(t *testing.T) {
	ids := &fakeIntrospector{tokens: map[string]identity.Token{
		"ak-alice": {Subject: "u-1"},
		"ak-admin": {Subject: "u-9", Roles: []string{"system-admin"}},
	}}
	policy := samplePolicy()
	policy.Default = nil
	policy.Owners = nil
	plane, _, _ := ownerPlane(t, ids, policy)
	ctx := context.Background()
	admin := CreateBody{TemplateID: "runner", Metadata: map[string]string{workspaceMetadata: "any-ws"}}

	if _, _, err := plane.Create(ctx, "ak-alice", CreateBody{TemplateID: "runner", Timeout: 13 * 3600}); opReason(err) != "timeout_not_allowed" {
		t.Fatalf("user 13h err = %v", err)
	}
	for i := 0; i < 8; i++ {
		if _, _, err := plane.Create(ctx, "ak-alice", CreateBody{TemplateID: "runner", Timeout: 12 * 3600}); err != nil {
			t.Fatalf("user create %d: %v", i, err)
		}
	}
	if _, _, err := plane.Create(ctx, "ak-alice", CreateBody{TemplateID: "runner"}); opReason(err) != "grant_quota_exceeded" {
		t.Fatalf("user ninth create err = %v", err)
	}

	admin.Timeout = 3*24*3600 + 1
	if _, _, err := plane.Create(ctx, "ak-admin", admin); opReason(err) != "timeout_not_allowed" {
		t.Fatalf("admin over 3d err = %v", err)
	}
	admin.Timeout = 3 * 24 * 3600
	for i := 0; i < 10; i++ {
		if _, _, err := plane.Create(ctx, "ak-admin", admin); err != nil {
			t.Fatalf("admin create %d: %v", i, err)
		}
	}
}

func TestIdentityKeyInactiveAndUnavailable(t *testing.T) {
	ids := &fakeIntrospector{tokens: map[string]identity.Token{}}
	plane, _, _ := ownerPlane(t, ids, samplePolicy())
	ctx := context.Background()
	_, _, err := plane.Create(ctx, "ak-revoked", CreateBody{TemplateID: "runner"})
	if oe, ok := err.(*grant.OpError); !ok || oe.Status != http.StatusUnauthorized {
		t.Fatalf("inactive err = %v", err)
	}
	ids.err = identity.ErrUnavailable
	_, err = plane.List(ctx, "ak-any", "", "", "", 0)
	if oe, ok := err.(*grant.OpError); !ok || oe.Status != http.StatusServiceUnavailable || oe.Reason != "identity_unavailable" {
		t.Fatalf("unavailable err = %v", err)
	}
}

func TestGrantKeySkipsIntrospection(t *testing.T) {
	plane, _, keys := testPlane(t, 3600, []int32{1}, 2)
	ids := &fakeIntrospector{}
	plane.identity = ids
	if _, _, err := plane.Create(context.Background(), keys["dev"], CreateBody{TemplateID: "runner"}); err != nil {
		t.Fatalf("grant key create: %v", err)
	}
	if ids.calls != 0 {
		t.Fatalf("introspect calls = %d", ids.calls)
	}
}

func TestOwnerRecordFollowsPolicy(t *testing.T) {
	ids := &fakeIntrospector{tokens: map[string]identity.Token{"ak-bob": {Subject: "u-2"}}}
	plane, _, cl := ownerPlane(t, ids, samplePolicy())
	ctx := context.Background()
	body := CreateBody{TemplateID: "runner", Metadata: map[string]string{workspaceMetadata: "lab"}}
	if _, _, err := plane.Create(ctx, "ak-bob", body); err != nil {
		t.Fatal(err)
	}
	policy := samplePolicy()
	policy.Owners["u-2"] = grant.OwnerQuota{MaxSandboxes: 5, MaxGPUs: 16, MaxSandboxSeconds: 600}
	if err := plane.grants.SetOwnerPolicy(ctx, policy); err != nil {
		t.Fatal(err)
	}
	if _, err := plane.List(ctx, "ak-bob", "", "", "", 0); err != nil {
		t.Fatal(err)
	}
	var g runtimev1alpha1.SandboxGrant
	if err := cl.Get(ctx, types.NamespacedName{Name: grant.OwnerGrantName("u-2"), Namespace: "agent-sandbox-system"}, &g); err != nil {
		t.Fatal(err)
	}
	if g.Spec.Roles["e2b"].MaxSandboxes != 5 || g.Spec.MaxSandboxSeconds != 600 || g.Status.Usage["e2b"].Sandboxes != 1 {
		t.Fatalf("owner record = %+v %+v", g.Spec, g.Status.Usage)
	}
	if _, _, err := plane.Create(ctx, "ak-bob", CreateBody{TemplateID: "runner", Timeout: 900, Metadata: body.Metadata}); opReason(err) != "timeout_not_allowed" {
		t.Fatalf("timeout err = %v", err)
	}
}
