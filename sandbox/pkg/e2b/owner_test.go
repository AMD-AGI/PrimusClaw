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
	"time"

	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/grant"
	"sigs.k8s.io/agent-sandbox/pkg/identity"
	"sigs.k8s.io/agent-sandbox/pkg/usercr"
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

func ownerPlane(t *testing.T, ids *fakeIntrospector, policy grant.OwnerPolicy) (*Service, *fakeRunner, client.Client) {
	t.Helper()
	return ownerPlaneWith(t, ids, policy, defaultAuthz())
}

// ownerPlaneWith builds an identity-key plane on a fake cluster with the given permission reviews.
func ownerPlaneWith(t *testing.T, ids *fakeIntrospector, policy grant.OwnerPolicy, az *fakeAuthz) (*Service, *fakeRunner, client.Client) {
	t.Helper()
	return ownerPlaneOptions(t, ids, policy, grant.Options{Authz: az, ReviewOwner: az != nil})
}

// ownerPlaneOptions builds an identity-key plane on a fake cluster. opts supplies the
// permission sources; the client, namespace and workspace list are filled in.
func ownerPlaneOptions(t *testing.T, ids *fakeIntrospector, policy grant.OwnerPolicy, opts grant.Options) (*Service, *fakeRunner, client.Client) {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := runtimev1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	cl := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&runtimev1alpha1.SandboxGrant{}).Build()
	opts.Client, opts.Namespace = cl, "agent-sandbox-system"
	gs := grant.New(opts)
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
	if _, _, err := plane.Create(ctx, "ak-admin", CreateBody{TemplateID: "runner"}); opReason(err) != "workspace_required" {
		t.Fatalf("admin without a workspace err = %v", err)
	}
	if got := runner.created[len(runner.created)-1].Workspace; got != "any-ws" {
		t.Fatalf("named admin workspace = %q", got)
	}
}

func TestSAROffIdentityKeyUsesTheUserCR(t *testing.T) {
	ids := &fakeIntrospector{tokens: map[string]identity.Token{
		"ak-alice":    {Subject: "u-1"},
		"ak-bob":      {Subject: "u-2"},
		"ak-cr-admin": {Subject: "u-7", Roles: []string{"default"}},
		"ak-stranger": {Subject: "u-5"},
	}}
	users := staticUsers{
		"u-1": {Found: true, Workspaces: []string{"lab"}},
		"u-2": {Found: true, Workspaces: []string{"lab", "prod"}},
		"u-7": {Found: true, Admin: true, Workspaces: []string{"lab"}},
	}
	policy := samplePolicy()
	policy.Owners = map[string]grant.OwnerQuota{
		"u-1": {MaxSandboxes: 4, MaxGPUs: 8, MaxSandboxSeconds: 3600},
		"u-7": {MaxSandboxes: 4, MaxGPUs: 8, MaxSandboxSeconds: 3600},
	}
	plane, runner, _ := ownerPlaneOptions(t, ids, policy, grant.Options{Authz: usercr.NewFromReader(users)})
	ctx := context.Background()
	ws := func(name string) CreateBody {
		return CreateBody{TemplateID: "runner", Metadata: map[string]string{workspaceMetadata: name}}
	}

	if _, _, err := plane.Create(ctx, "ak-alice", CreateBody{TemplateID: "runner"}); err != nil {
		t.Fatalf("only listed workspace: %v", err)
	}
	if got := runner.created[len(runner.created)-1].Workspace; got != "lab" {
		t.Fatalf("picked workspace = %q", got)
	}
	if _, _, err := plane.Create(ctx, "ak-alice", ws("prod")); opReason(err) != "user_not_in_workspace" {
		t.Fatalf("unlisted workspace err = %v", err)
	}
	if _, _, err := plane.Create(ctx, "ak-bob", CreateBody{TemplateID: "runner"}); opReason(err) != "workspace_required" {
		t.Fatalf("multi-workspace without metadata err = %v", err)
	}
	if _, _, err := plane.Create(ctx, "ak-stranger", ws("lab")); opReason(err) != "user_not_in_workspace" {
		t.Fatalf("missing User err = %v", err)
	}
	if _, _, err := plane.Create(ctx, "ak-cr-admin", CreateBody{TemplateID: "runner"}); opReason(err) != "workspace_required" {
		t.Fatalf("User CR admin without a workspace err = %v", err)
	}
	if _, _, err := plane.Create(ctx, "ak-cr-admin", ws("prod")); err != nil {
		t.Fatalf("User CR admin in an unlisted workspace: %v", err)
	}
}

func TestSAROffGrantKeyCreateChecksOwnerOnlyForAssertion(t *testing.T) {
	for _, attest := range []bool{false, true} {
		users := staticUsers{"u-123": {Found: true, Workspaces: []string{"lab"}}}
		now := time.Now()
		plane, runner, keys := testPlaneSAROff(t, users, attest, usercr.WithClock(func() time.Time { return now }))
		delete(users, "u-123")
		// Past the 30s allow cache, the next create reads the User again.
		now = now.Add(31 * time.Second)
		_, _, err := plane.Create(context.Background(), keys["dev"], CreateBody{TemplateID: "runner"})
		if !attest && err != nil {
			t.Fatalf("switches off: create rechecked the owner: %v", err)
		}
		if attest && opReason(err) != "user_not_in_workspace" {
			t.Fatalf("assertion on: err = %v", err)
		}
		if want := map[bool]int{false: 1, true: 0}[attest]; len(runner.created) != want {
			t.Fatalf("attest=%v runner calls = %d", attest, len(runner.created))
		}
		if !attest && runner.created[0].SubjectKey != "" {
			t.Fatalf("grant key entered SubjectKey: %q", runner.created[0].SubjectKey)
		}
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
	plane, runner, keys := testPlane(t, 3600, []int32{1}, 2)
	ids := &fakeIntrospector{}
	plane.identity = ids
	if _, _, err := plane.Create(context.Background(), keys["dev"], CreateBody{TemplateID: "runner"}); err != nil {
		t.Fatalf("grant key create: %v", err)
	}
	if ids.calls != 0 {
		t.Fatalf("introspect calls = %d", ids.calls)
	}
	if got := runner.created[0]; got.OwnerKey || got.SubjectKey != "ak-test" {
		t.Fatalf("create request = %+v", got)
	}
}

func TestGrantKeyCreateReviewsOwnerWorkspace(t *testing.T) {
	az := defaultAuthz()
	plane, runner, keys := testPlaneInWorkspacesWith(t, az)
	az.workspaces["u-123"] = []string{"lab"}
	if _, _, err := plane.Create(context.Background(), keys["dev"], CreateBody{TemplateID: "runner"}); opReason(err) != "user_not_in_workspace" {
		t.Fatalf("err = %v", err)
	}
	if len(runner.created) != 0 {
		t.Fatalf("runner calls = %d", len(runner.created))
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

func TestIdentityKeyUsesReviewedAdminRole(t *testing.T) {
	ids := &fakeIntrospector{tokens: map[string]identity.Token{
		"ak-admin": {Subject: "u-9", Roles: []string{"default"}},
	}}
	policy := samplePolicy()
	policy.Default = nil
	policy.Owners = nil
	plane, _, _ := ownerPlaneWith(t, ids, policy, &fakeAuthz{admins: map[string]bool{"u-9": true}})
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

func ownerRecord(t *testing.T, cl client.Client, userID string) runtimev1alpha1.SandboxGrant {
	t.Helper()
	var g runtimev1alpha1.SandboxGrant
	if err := cl.Get(context.Background(), types.NamespacedName{Name: grant.OwnerGrantName(userID), Namespace: "agent-sandbox-system"}, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func TestReviewErrorKeepsAdminOwnerRecord(t *testing.T) {
	ids := &fakeIntrospector{tokens: map[string]identity.Token{"ak-admin": {Subject: "u-9", Roles: []string{"default"}}}}
	az := &fakeAuthz{admins: map[string]bool{"u-9": true}}
	policy := samplePolicy()
	policy.Default, policy.Owners = nil, nil
	plane, _, cl := ownerPlaneWith(t, ids, policy, az)
	ctx := context.Background()
	body := CreateBody{TemplateID: "runner", Metadata: map[string]string{workspaceMetadata: "any-ws"}}
	created, _, err := plane.Create(ctx, "ak-admin", body)
	if err != nil {
		t.Fatal(err)
	}

	az.err = errors.New("apiserver timeout")
	if _, _, err := plane.Create(ctx, "ak-admin", body); opReason(err) != "membership_unavailable" {
		t.Fatalf("create err = %v", err)
	}
	if err := plane.Timeout(ctx, "ak-admin", created.SandboxID, 600); opReason(err) != "membership_unavailable" {
		t.Fatalf("timeout err = %v", err)
	}
	if g := ownerRecord(t, cl, "u-9"); g.Spec.Roles["e2b"].MaxSandboxes != -1 {
		t.Fatalf("admin record downgraded: %+v", g.Spec.Roles)
	}
}

func TestOwnerPolicyNotAppliedIsUnavailable(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := runtimev1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	cl := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&runtimev1alpha1.SandboxGrant{}).Build()
	gs := grant.New(grant.Options{Client: cl, Namespace: "agent-sandbox-system", Authz: defaultAuthz()})
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
