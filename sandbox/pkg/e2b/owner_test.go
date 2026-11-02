// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package e2b

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
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

func (m listMembership) ReadUser(_ context.Context, userID string) (grant.OwnerUser, error) {
	ws, ok := m[userID]
	return grant.OwnerUser{Found: ok, Workspaces: ws}, nil
}

func ownerPlane(t *testing.T, ids *fakeIntrospector, policy grant.OwnerPolicy) (*Service, *fakeRunner, client.Client) {
	t.Helper()
	return ownerPlaneWith(t, ids, policy, listMembership{"u-1": {"lab"}, "u-2": {"lab", "prod"}})
}

// ownerPlaneWith builds an identity-key plane on a fake cluster with the given membership.
func ownerPlaneWith(t *testing.T, ids *fakeIntrospector, policy grant.OwnerPolicy, membership grant.MembershipChecker) (*Service, *fakeRunner, client.Client) {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := runtimev1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	cl := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&runtimev1alpha1.SandboxGrant{}).Build()
	gs := grant.New(grant.Options{
		Client: cl, Namespace: "agent-sandbox-system",
		Membership: membership,
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
	if req.Workspace != "lab" || req.GrantID != owner || req.SessionID != owner || !req.OwnerKey || req.Role != "e2b" || req.UserID != "u-1" || req.TemplateID != "e2b-runner-g1" || req.SubjectKey != "ak-alice" {
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
	if _, _, err := plane.Create(ctx, "ak-bob", CreateBody{TemplateID: "runner", Timeout: 900, Metadata: body.Metadata}); opReason(err) != "timeout_not_allowed" {
		t.Fatalf("timeout err = %v", err)
	}
	var g runtimev1alpha1.SandboxGrant
	if err := cl.Get(ctx, types.NamespacedName{Name: grant.OwnerGrantName("u-2"), Namespace: "agent-sandbox-system"}, &g); err != nil {
		t.Fatal(err)
	}
	if g.Spec.Roles["e2b"].MaxSandboxes != 5 || g.Spec.MaxSandboxSeconds != 600 || g.Status.Usage["e2b"].Sandboxes != 1 {
		t.Fatalf("owner record = %+v %+v", g.Spec, g.Status.Usage)
	}
}

func TestSystemAdminReachesEverySandbox(t *testing.T) {
	plane, _, keys := testPlane(t, 3600, []int32{1}, 2)
	policy := samplePolicy()
	policy.Default = nil
	policy.Owners = nil
	if err := plane.grants.SetOwnerPolicy(context.Background(), policy); err != nil {
		t.Fatal(err)
	}
	plane.identity = &fakeIntrospector{tokens: map[string]identity.Token{
		"ak-alice": {Subject: "u-1"},
		"ak-bob":   {Subject: "u-2"},
		"ak-admin": {Subject: "u-9", Roles: []string{"system-admin"}},
	}}
	ctx := context.Background()
	lab := map[string]string{workspaceMetadata: "lab"}

	claw, _, err := plane.Create(ctx, keys["dev"], CreateBody{TemplateID: "runner"})
	if err != nil {
		t.Fatal(err)
	}
	alice, _, err := plane.Create(ctx, "ak-alice", CreateBody{TemplateID: "runner", Timeout: 3600, Metadata: lab})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := plane.Get(ctx, "ak-bob", alice.SandboxID); opReason(err) != "sandbox_not_found" {
		t.Fatalf("other user get err = %v", err)
	}
	if got, err := plane.List(ctx, "ak-bob", "", "", "", 0); err != nil || len(got.Sandboxes) != 0 {
		t.Fatalf("other user list = %+v %v", got, err)
	}

	if got, err := plane.List(ctx, "ak-admin", "", "", "", 0); err != nil || len(got.Sandboxes) != 0 {
		t.Fatalf("admin default list = %+v %v", got, err)
	}
	list, err := plane.List(ctx, "ak-admin", url.Values{scopeMetadata: {scopeAll}}.Encode(), "", "", 0)
	if err != nil || len(list.Sandboxes) != 2 {
		t.Fatalf("admin list = %+v %v", list, err)
	}
	owners := map[string]string{}
	for _, sb := range list.Sandboxes {
		owners[sb.SandboxID] = sb.Metadata[ownerUserMetadata]
	}
	if owners[claw.SandboxID] != "u-123" || owners[alice.SandboxID] != "u-1" {
		t.Fatalf("admin list owners = %v", owners)
	}
	for _, id := range []string{claw.SandboxID, alice.SandboxID} {
		if _, err := plane.Get(ctx, "ak-admin", id); err != nil {
			t.Fatalf("admin get %s: %v", id, err)
		}
		conn, err := plane.Connect(ctx, "ak-admin", id)
		if err != nil || conn.EnvdAccessToken == "" {
			t.Fatalf("admin connect %s: %v", id, err)
		}
		if _, err := plane.grants.LookupAccess(ctx, id, conn.EnvdAccessToken); err != nil {
			t.Fatalf("admin token %s: %v", id, err)
		}
	}

	if err := plane.Timeout(ctx, "ak-alice", alice.SandboxID, 13*3600); opReason(err) != "timeout_not_allowed" {
		t.Fatalf("user 13h timeout err = %v", err)
	}
	if err := plane.Timeout(ctx, "ak-admin", alice.SandboxID, 6*3600); err != nil {
		t.Fatalf("admin 6h timeout: %v", err)
	}
	if err := plane.Timeout(ctx, "ak-admin", alice.SandboxID, 13*3600); opReason(err) != "timeout_not_allowed" {
		t.Fatalf("admin over the owner cap timeout err = %v", err)
	}

	if err := plane.Kill(ctx, "ak-admin", claw.SandboxID); err != nil {
		t.Fatalf("admin kill claw: %v", err)
	}
	if err := plane.Kill(ctx, "ak-admin", alice.SandboxID); err != nil {
		t.Fatalf("admin kill alice: %v", err)
	}
	if _, err := plane.Get(ctx, "ak-alice", alice.SandboxID); opReason(err) != "sandbox_not_found" {
		t.Fatalf("killed sandbox get err = %v", err)
	}
}

func TestCallerCannotSetOwnerMetadata(t *testing.T) {
	if err := checkMetadata(map[string]string{ownerUserMetadata: "u-1"}); opReason(err) != "metadata_reserved" {
		t.Fatalf("err = %v", err)
	}
}

// adminMembership marks listed users as SaFE system admins.
type adminMembership struct {
	listMembership
	admins map[string]bool
}

func (m adminMembership) ReadUser(ctx context.Context, userID string) (grant.OwnerUser, error) {
	u, _ := m.listMembership.ReadUser(ctx, userID)
	u.Admin = m.admins[userID]
	u.Found = u.Found || u.Admin
	return u, nil
}

func TestIdentityKeyUsesSaFEAdminRole(t *testing.T) {
	ids := &fakeIntrospector{tokens: map[string]identity.Token{
		"ak-admin": {Subject: "u-9", Roles: []string{"default"}},
	}}
	scheme := runtime.NewScheme()
	if err := runtimev1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	cl := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&runtimev1alpha1.SandboxGrant{}).Build()
	gs := grant.New(grant.Options{
		Client: cl, Namespace: "agent-sandbox-system",
		Membership: adminMembership{listMembership: listMembership{}, admins: map[string]bool{"u-9": true}},
	})
	policy := samplePolicy()
	policy.Default = nil
	policy.Owners = nil
	if err := gs.SetOwnerPolicy(context.Background(), policy); err != nil {
		t.Fatal(err)
	}
	plane := New(Options{Grants: gs, Runner: &fakeRunner{}, Namespace: "agent-sandbox-system", Identity: ids})
	body := CreateBody{TemplateID: "runner", Timeout: 3 * 24 * 3600, Metadata: map[string]string{workspaceMetadata: "any-ws"}}
	for i := 0; i < 10; i++ {
		if _, _, err := plane.Create(context.Background(), "ak-admin", body); err != nil {
			t.Fatalf("admin create %d: %v", i, err)
		}
	}
}

func TestIdentityKeyReadsDoNotCreateOwnerRecord(t *testing.T) {
	ids := &fakeIntrospector{tokens: map[string]identity.Token{"ak-alice": {Subject: "u-1"}}}
	plane, _, cl := ownerPlane(t, ids, samplePolicy())
	ctx := context.Background()

	list, err := plane.List(ctx, "ak-alice", "", "", "", 0)
	if err != nil || len(list.Sandboxes) != 0 {
		t.Fatalf("list = %+v %v", list, err)
	}
	if _, err := plane.Get(ctx, "ak-alice", "sbx-x"); opReason(err) != "sandbox_not_found" {
		t.Fatalf("get err = %v", err)
	}
	if err := plane.Kill(ctx, "ak-alice", "sbx-x"); opReason(err) != "sandbox_not_found" {
		t.Fatalf("kill err = %v", err)
	}
	if _, err := plane.Connect(ctx, "ak-alice", "sbx-x"); opReason(err) != "sandbox_not_found" {
		t.Fatalf("connect err = %v", err)
	}
	var grants runtimev1alpha1.SandboxGrantList
	if err := cl.List(ctx, &grants); err != nil {
		t.Fatal(err)
	}
	if len(grants.Items) != 0 {
		t.Fatalf("owner records = %d", len(grants.Items))
	}
}

func TestOwnerPolicyRoleIsFixedOnceRecordsExist(t *testing.T) {
	ids := &fakeIntrospector{tokens: map[string]identity.Token{"ak-alice": {Subject: "u-1"}}}
	plane, _, _ := ownerPlane(t, ids, samplePolicy())
	ctx := context.Background()
	if _, _, err := plane.Create(ctx, "ak-alice", CreateBody{TemplateID: "runner"}); err != nil {
		t.Fatal(err)
	}
	policy := samplePolicy()
	policy.Role = "dev"
	if err := plane.grants.SetOwnerPolicy(ctx, policy); opReason(err) != "invalid_owner_policy" {
		t.Fatalf("role change err = %v", err)
	}
	if err := plane.grants.SetOwnerPolicy(ctx, samplePolicy()); err != nil {
		t.Fatalf("same role: %v", err)
	}
}

// countingMembership counts User reads and can fail them.
type countingMembership struct {
	adminMembership
	reads *int
	err   *error
}

func (m countingMembership) ReadUser(ctx context.Context, userID string) (grant.OwnerUser, error) {
	*m.reads++
	if *m.err != nil {
		return grant.OwnerUser{}, *m.err
	}
	return m.adminMembership.ReadUser(ctx, userID)
}

func newCountingMembership(workspaces listMembership, admins map[string]bool) countingMembership {
	var reads int
	var err error
	return countingMembership{adminMembership: adminMembership{listMembership: workspaces, admins: admins}, reads: &reads, err: &err}
}

func ownerRecord(t *testing.T, cl client.Client, userID string) runtimev1alpha1.SandboxGrant {
	t.Helper()
	var g runtimev1alpha1.SandboxGrant
	if err := cl.Get(context.Background(), types.NamespacedName{Name: grant.OwnerGrantName(userID), Namespace: "agent-sandbox-system"}, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func TestUserReadErrorKeepsAdminOwnerRecord(t *testing.T) {
	ids := &fakeIntrospector{tokens: map[string]identity.Token{"ak-admin": {Subject: "u-9", Roles: []string{"default"}}}}
	m := newCountingMembership(listMembership{}, map[string]bool{"u-9": true})
	policy := samplePolicy()
	policy.Default, policy.Owners = nil, nil
	plane, _, cl := ownerPlaneWith(t, ids, policy, m)
	ctx := context.Background()
	body := CreateBody{TemplateID: "runner", Metadata: map[string]string{workspaceMetadata: "any-ws"}}
	created, _, err := plane.Create(ctx, "ak-admin", body)
	if err != nil {
		t.Fatal(err)
	}

	*m.err = errors.New("apiserver timeout")
	if _, _, err := plane.Create(ctx, "ak-admin", body); opReason(err) != "identity_unavailable" {
		t.Fatalf("create err = %v", err)
	}
	if err := plane.Timeout(ctx, "ak-admin", created.SandboxID, 600); opReason(err) != "identity_unavailable" {
		t.Fatalf("timeout err = %v", err)
	}
	if g := ownerRecord(t, cl, "u-9"); g.Spec.Roles["e2b"].MaxSandboxes != -1 {
		t.Fatalf("admin record downgraded: %+v", g.Spec.Roles)
	}
}

func TestIdentityCreateReadsUserOnce(t *testing.T) {
	ids := &fakeIntrospector{tokens: map[string]identity.Token{"ak-alice": {Subject: "u-1"}}}
	m := newCountingMembership(listMembership{"u-1": {"lab"}}, nil)
	plane, _, _ := ownerPlaneWith(t, ids, samplePolicy(), m)
	ctx := context.Background()
	for name, body := range map[string]CreateBody{
		"implied":   {TemplateID: "runner"},
		"requested": {TemplateID: "runner", Metadata: map[string]string{workspaceMetadata: "lab"}},
	} {
		*m.reads = 0
		resp, _, err := plane.Create(ctx, "ak-alice", body)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if *m.reads != 1 {
			t.Fatalf("%s: user reads = %d", name, *m.reads)
		}
		if err := plane.Kill(ctx, "ak-alice", resp.SandboxID); err != nil {
			t.Fatal(err)
		}
	}
}

func TestOwnerPolicyNotAppliedIsUnavailable(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := runtimev1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	cl := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&runtimev1alpha1.SandboxGrant{}).Build()
	gs := grant.New(grant.Options{Client: cl, Namespace: "agent-sandbox-system", Membership: listMembership{"u-1": {"lab"}}})
	ids := &fakeIntrospector{tokens: map[string]identity.Token{"ak-alice": {Subject: "u-1"}}}
	plane := New(Options{Grants: gs, Runner: &fakeRunner{}, Namespace: "agent-sandbox-system", Identity: ids})
	_, _, err := plane.Create(context.Background(), "ak-alice", CreateBody{TemplateID: "runner"})
	if oe, ok := err.(*grant.OpError); !ok || oe.Status != http.StatusServiceUnavailable {
		t.Fatalf("err = %v", err)
	}
}

func TestPartialQuotasInheritByRole(t *testing.T) {
	tpl, err := json.Marshal(samplePolicy().Templates)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("E2B_OWNER_POLICY", `{"templates":`+string(tpl)+`,
		"default":{"maxSandboxes":4},
		"admin":{"maxSandboxSeconds":86400},
		"owners":{"u-2":{"maxGpus":16},"u-8":{"maxGpus":16}}}`)
	policy, err := grant.OwnerPolicyFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	ids := &fakeIntrospector{tokens: map[string]identity.Token{
		"ak-alice": {Subject: "u-1"},
		"ak-bob":   {Subject: "u-2"},
		"ak-admin": {Subject: "u-9", Roles: []string{"system-admin"}},
		"ak-root":  {Subject: "u-8", Roles: []string{"system-admin"}},
	}}
	plane, _, cl := ownerPlane(t, ids, *policy)
	ctx := context.Background()
	lab := map[string]string{workspaceMetadata: "lab"}
	for _, key := range []string{"ak-alice", "ak-bob", "ak-admin", "ak-root"} {
		if _, _, err := plane.Create(ctx, key, CreateBody{TemplateID: "runner", Timeout: 60, Metadata: lab}); err != nil {
			t.Fatalf("%s: %v", key, err)
		}
	}
	for user, want := range map[string][3]int64{
		"u-1": {4, 8, 12 * 3600},
		"u-2": {4, 16, 12 * 3600},
		"u-9": {-1, -1, 86400},
		"u-8": {-1, 16, 86400},
	} {
		g := ownerRecord(t, cl, user)
		role := g.Spec.Roles["e2b"]
		if got := [3]int64{int64(role.MaxSandboxes), int64(role.MaxGPUs), g.Spec.MaxSandboxSeconds}; got != want {
			t.Fatalf("%s quota = %v, want %v", user, got, want)
		}
	}
}

func TestAdminTimeoutCappedByTargetGrant(t *testing.T) {
	plane, _, keys := testPlane(t, 3600, []int32{1}, 2)
	policy := samplePolicy()
	policy.Default, policy.Owners = nil, nil
	if err := plane.grants.SetOwnerPolicy(context.Background(), policy); err != nil {
		t.Fatal(err)
	}
	plane.identity = &fakeIntrospector{tokens: map[string]identity.Token{"ak-admin": {Subject: "u-9", Roles: []string{"system-admin"}}}}
	ctx := context.Background()
	claw, _, err := plane.Create(ctx, keys["dev"], CreateBody{TemplateID: "runner"})
	if err != nil {
		t.Fatal(err)
	}
	if err := plane.Timeout(ctx, "ak-admin", claw.SandboxID, 7200); opReason(err) != "timeout_not_allowed" {
		t.Fatalf("over grant cap err = %v", err)
	}
	if err := plane.Timeout(ctx, "ak-admin", claw.SandboxID, 1800); err != nil {
		t.Fatalf("within grant cap: %v", err)
	}
}

func TestAdminListFiltersByOwner(t *testing.T) {
	plane, _, keys := testPlane(t, 3600, []int32{1}, 2)
	policy := samplePolicy()
	policy.Default, policy.Owners = nil, nil
	if err := plane.grants.SetOwnerPolicy(context.Background(), policy); err != nil {
		t.Fatal(err)
	}
	plane.identity = &fakeIntrospector{tokens: map[string]identity.Token{
		"ak-alice": {Subject: "u-1"},
		"ak-admin": {Subject: "u-9", Roles: []string{"system-admin"}},
	}}
	ctx := context.Background()
	if _, _, err := plane.Create(ctx, keys["dev"], CreateBody{TemplateID: "runner"}); err != nil {
		t.Fatal(err)
	}
	alice, _, err := plane.Create(ctx, "ak-alice", CreateBody{TemplateID: "runner", Timeout: 60, Metadata: map[string]string{workspaceMetadata: "lab"}})
	if err != nil {
		t.Fatal(err)
	}
	list, err := plane.List(ctx, "ak-admin", url.Values{ownerUserMetadata: {"u-1"}, scopeMetadata: {scopeAll}}.Encode(), "", "", 0)
	if err != nil || len(list.Sandboxes) != 1 || list.Sandboxes[0].SandboxID != alice.SandboxID {
		t.Fatalf("filtered list = %+v %v", list, err)
	}
}

func TestOwnerPolicyRemovesDroppedTemplates(t *testing.T) {
	policy := samplePolicy()
	extra := policy.Templates[0]
	extra.Name = "extra"
	policy.Templates = append(policy.Templates, extra)
	plane, _, cl := ownerPlane(t, &fakeIntrospector{}, policy)
	ctx := context.Background()
	foreign := &runtimev1alpha1.CodeInterpreter{}
	foreign.Name, foreign.Namespace = "other-extra-g1", "agent-sandbox-system"
	if err := cl.Create(ctx, foreign); err != nil {
		t.Fatal(err)
	}

	if err := plane.grants.SetOwnerPolicy(ctx, samplePolicy()); err != nil {
		t.Fatal(err)
	}
	var ci runtimev1alpha1.CodeInterpreter
	if err := cl.Get(ctx, types.NamespacedName{Name: "e2b-extra-g1", Namespace: "agent-sandbox-system"}, &ci); err == nil {
		t.Fatal("dropped template e2b-extra-g1 still exists")
	}
	for _, name := range []string{"e2b-runner-g1", "other-extra-g1"} {
		if err := cl.Get(ctx, types.NamespacedName{Name: name, Namespace: "agent-sandbox-system"}, &ci); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
}
