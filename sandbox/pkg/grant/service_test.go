// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"errors"

	"github.com/golang-jwt/jwt/v5"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/audit"
)

type staticAuth struct{}

func (staticAuth) Authenticate(context.Context, string) error { return nil }

type staticIdentity struct{}

func (staticIdentity) Check(context.Context, string, string) (string, error) {
	return "alice", nil
}

type staticMembership struct {
	allow []string
}

func (m staticMembership) Check(_ context.Context, _ string, workspaces []string) error {
	for _, ws := range workspaces {
		if !contains(m.allow, ws) {
			return opErr(403, "user_not_in_workspace", ws)
		}
	}
	return nil
}

type memRecord struct {
	mu     sync.Mutex
	events []string
}

func (m *memRecord) Record(_ context.Context, event *audit.AuditEvent) {
	m.mu.Lock()
	m.events = append(m.events, event.EventType)
	m.mu.Unlock()
}

type memExists struct {
	gone map[string]bool
}

func (m memExists) Exists(_ context.Context, ref SandboxRef) (bool, error) {
	return !m.gone[ref.ID], nil
}

type memReclaimer struct {
	mu  sync.Mutex
	ids []string
}

func (m *memReclaimer) Reclaim(_ context.Context, ref SandboxRef) error {
	m.mu.Lock()
	m.ids = append(m.ids, ref.ID)
	m.mu.Unlock()
	return nil
}

func testService(t *testing.T, now time.Time) (*Service, *ecdsa.PrivateKey, *memRecord, *memReclaimer) {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := runtimev1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	cl := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&runtimev1alpha1.SandboxGrant{}).Build()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	checker, err := NewJWKSChecker(jwksFor(t, &priv.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	rec := &memRecord{}
	reclaimer := &memReclaimer{}
	svc := New(Options{
		Client:     cl,
		Namespace:  "agent-sandbox-system",
		DataKey:    bytes32('k'),
		Authn:      staticAuth{},
		Attest:     checker,
		Identity:   staticIdentity{},
		Membership: staticMembership{allow: []string{"top-models", "lab"}},
		Reclaimer:  reclaimer,
		Record:     rec,
		Now:        func() time.Time { return now },
	})
	return svc, priv, rec, reclaimer
}

func bytes32(b byte) []byte {
	key := make([]byte, 32)
	for i := range key {
		key[i] = b
	}
	return key
}

func jwksFor(t *testing.T, pub *ecdsa.PublicKey) []byte {
	t.Helper()
	x := base64.RawURLEncoding.EncodeToString(pub.X.FillBytes(make([]byte, 32)))
	y := base64.RawURLEncoding.EncodeToString(pub.Y.FillBytes(make([]byte, 32)))
	doc := map[string]any{
		"keys": []map[string]string{{
			"kty": "EC", "crv": "P-256", "kid": "test", "alg": "ES256", "x": x, "y": y,
		}},
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func signGrant(t *testing.T, priv *ecdsa.PrivateKey, req IssueRequest) string {
	t.Helper()
	claims := grantClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    attestationIssuer,
			Audience:  jwt.ClaimStrings{attestationAudience},
			Subject:   req.Owner.UserID,
			ID:        req.GrantID,
			ExpiresAt: jwt.NewNumericDate(req.ExpiresAt),
			IssuedAt:  jwt.NewNumericDate(req.ExpiresAt.Add(-time.Hour)),
		},
		Workspaces:        req.Owner.Workspaces,
		Kinds:             []string{"PyTorchJob", "Sandbox"},
		MaxGPUsPerSandbox: 8,
	}
	token := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	token.Header["kid"] = "test"
	signed, err := token.SignedString(priv)
	if err != nil {
		t.Fatal(err)
	}
	return signed
}

func sampleRequest(expires time.Time) IssueRequest {
	return IssueRequest{
		GrantID:     "gr-01jb7m9k2x",
		Owner:       OwnerRequest{UserID: "u-123", Workspaces: []string{"top-models"}},
		PlatformKey: "ak-test",
		Issuer:      IssuerRequest{SessionID: "s-8f2a", AppRunID: "ar-01ja"},
		Roles: map[string]RoleRequest{
			"measurement": {Templates: []string{"runner"}, MaxSandboxes: 16, MaxGPUs: 128},
		},
		Templates:      []TemplateRequest{{Name: "runner", PerGPUCount: []int32{1, 8}}},
		GPUHoursBudget: 1,
		ExpiresAt:      expires,
		Attestation:    "placeholder",
	}
}

func TestIssueReturnsKeysOnce(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	svc, priv, rec, _ := testService(t, now)
	req := sampleRequest(now.Add(time.Hour))
	req.Attestation = signGrant(t, priv, req)
	ctx := context.Background()

	first, status, err := svc.Issue(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if status != 201 || first.Keys["measurement"] == "" {
		t.Fatalf("status=%d keys=%v", status, first.Keys)
	}
	if got := first.Templates["runner"]; len(got) != 2 || got[0] != "ar-01ja-runner-g1" || got[1] != "ar-01ja-runner-g8" {
		t.Fatalf("templates=%v", first.Templates)
	}

	again, status, err := svc.Issue(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if status != 200 || again.Keys != nil {
		t.Fatalf("replay status=%d keys=%v", status, again.Keys)
	}
	if len(rec.events) != 1 || rec.events[0] != audit.EventGrantCreated {
		t.Fatalf("events=%v", rec.events)
	}

	grantID, role, err := svc.LookupKey(ctx, first.Keys["measurement"])
	if err != nil || grantID != req.GrantID || role != "measurement" {
		t.Fatalf("lookup %s %s %v", grantID, role, err)
	}
}

func TestIssueReplayMatchesExecutionSpec(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	svc, priv, _, _ := testService(t, now)
	req := sampleRequest(now.Add(time.Hour))
	req.MaxSandboxSeconds = 600
	req.Templates[0].Spec = json.RawMessage(`{"fromImage":"image:v1"}`)
	req.Attestation = signGrant(t, priv, req)
	ctx := context.Background()
	if _, status, err := svc.Issue(ctx, req); err != nil || status != 201 {
		t.Fatalf("issue status=%d err=%v", status, err)
	}

	resigned := cloneIssue(req)
	resigned.Attestation = signGrant(t, priv, resigned)
	if resigned.Attestation == req.Attestation {
		t.Fatal("re-sign produced the same token")
	}
	again, status, err := svc.Issue(ctx, resigned)
	if err != nil || status != 200 || again.Keys != nil {
		t.Fatalf("resigned replay status=%d keys=%v err=%v", status, again.Keys, err)
	}

	cases := []struct {
		name string
		edit func(*IssueRequest)
	}{
		{"session", func(r *IssueRequest) { r.Issuer.SessionID = "s-other" }},
		{"app run", func(r *IssueRequest) { r.Issuer.AppRunID = "ar-other" }},
		{"workspace", func(r *IssueRequest) { r.Owner.Workspaces = []string{"lab"} }},
		{"budget", func(r *IssueRequest) { r.GPUHoursBudget = 2 }},
		{"lifetime", func(r *IssueRequest) { r.MaxSandboxSeconds = 60 }},
		{"cards", func(r *IssueRequest) { r.Templates[0].PerGPUCount = []int32{1} }},
		{"image", func(r *IssueRequest) { r.Templates[0].Spec = json.RawMessage(`{"fromImage":"image:v2"}`) }},
		{"caps", func(r *IssueRequest) {
			r.Roles["measurement"] = RoleRequest{Templates: []string{"runner"}, MaxSandboxes: 1, MaxGPUs: 1}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			next := cloneIssue(req)
			tc.edit(&next)
			next.Attestation = signGrant(t, priv, next)
			_, _, err := svc.Issue(ctx, next)
			if !IsReason(err, "grant_conflict") {
				t.Fatalf("err=%v", err)
			}
		})
	}
}

func cloneIssue(req IssueRequest) IssueRequest {
	out := req
	out.Owner.Workspaces = append([]string(nil), req.Owner.Workspaces...)
	out.Roles = make(map[string]RoleRequest, len(req.Roles))
	for role, cap := range req.Roles {
		cap.Templates = append([]string(nil), cap.Templates...)
		out.Roles[role] = cap
	}
	out.Templates = append([]TemplateRequest(nil), req.Templates...)
	for i := range out.Templates {
		out.Templates[i].PerGPUCount = append([]int32(nil), req.Templates[i].PerGPUCount...)
		out.Templates[i].Spec = append(json.RawMessage(nil), req.Templates[i].Spec...)
	}
	return out
}

func TestIssueRejectsBadWorkspace(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	svc, priv, _, _ := testService(t, now)
	req := sampleRequest(now.Add(time.Hour))
	req.Owner.Workspaces = []string{"other"}
	req.Attestation = signGrant(t, priv, req)
	_, _, err := svc.Issue(context.Background(), req)
	if !IsReason(err, "user_not_in_workspace") {
		t.Fatalf("err=%v", err)
	}
}

func TestReserveStopsAtCap(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	svc, priv, _, _ := testService(t, now)
	req := sampleRequest(now.Add(time.Hour))
	req.Roles["measurement"] = RoleRequest{Templates: []string{"runner"}, MaxSandboxes: 16, MaxGPUs: 128}
	req.Attestation = signGrant(t, priv, req)
	if _, _, err := svc.Issue(context.Background(), req); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	var mu sync.Mutex
	okN, denyN := 0, 0
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			err := svc.Reserve(context.Background(), req.GrantID, "measurement", idOf(i), "sess-"+idOf(i), 1)
			mu.Lock()
			if err == nil {
				okN++
			} else if IsReason(err, "grant_quota_exceeded") {
				denyN++
			} else {
				t.Errorf("reserve %d: %v", i, err)
			}
			mu.Unlock()
		}(i)
	}
	wg.Wait()
	if okN != 16 || denyN != 16 {
		t.Fatalf("ok=%d deny=%d", okN, denyN)
	}
}

func TestBudgetExhausted(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	svc, priv, _, _ := testService(t, now)
	req := sampleRequest(now.Add(time.Hour))
	req.Attestation = signGrant(t, priv, req)
	if _, _, err := svc.Issue(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if err := svc.Reserve(context.Background(), req.GrantID, "measurement", "sbx-1", "sess-1", 1); err != nil {
		t.Fatal(err)
	}
	if err := svc.Release(context.Background(), req.GrantID, "sbx-1", 3600); err != nil {
		t.Fatal(err)
	}
	err := svc.Reserve(context.Background(), req.GrantID, "measurement", "sbx-2", "sess-2", 1)
	oe, ok := err.(*OpError)
	if !ok || oe.Status != http.StatusTooManyRequests || oe.Reason != "grant_quota_exceeded" || !strings.Contains(oe.Error(), "grant_quota_exceeded") {
		t.Fatalf("err=%v", err)
	}
}

func TestRevokeDropsKey(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	svc, priv, _, reclaimer := testService(t, now)
	req := sampleRequest(now.Add(time.Hour))
	req.Attestation = signGrant(t, priv, req)
	issued, _, err := svc.Issue(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Reserve(context.Background(), req.GrantID, "measurement", "sbx-1", "sess-1", 1); err != nil {
		t.Fatal(err)
	}
	resp, err := svc.Revoke(context.Background(), req.GrantID)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Remaining != 0 || len(reclaimer.ids) != 1 {
		t.Fatalf("resp=%+v reclaimed=%v", resp, reclaimer.ids)
	}
	_, _, err = svc.LookupKey(context.Background(), issued.Keys["measurement"])
	if !IsReason(err, "grant_revoked") {
		t.Fatalf("err=%v", err)
	}
	again, err := svc.Revoke(context.Background(), req.GrantID)
	if err != nil || again.Remaining != 0 {
		t.Fatalf("again=%+v err=%v", again, err)
	}
}

func TestReapExpiresGrant(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	svc, priv, rec, _ := testService(t, now)
	req := sampleRequest(now.Add(time.Minute))
	req.Attestation = signGrant(t, priv, req)
	issued, _, err := svc.Issue(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	svc.now = func() time.Time { return now.Add(2 * time.Minute) }
	svc.ReapOnce(context.Background())
	_, _, err = svc.LookupKey(context.Background(), issued.Keys["measurement"])
	if !IsReason(err, "grant_expired") {
		t.Fatalf("err=%v", err)
	}
	found := false
	for _, ev := range rec.events {
		if ev == audit.EventGrantExpired {
			found = true
		}
	}
	if !found {
		t.Fatalf("events=%v", rec.events)
	}
}

func TestReconcileDropsMissingSandbox(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	svc, priv, _, _ := testService(t, now)
	svc.exists = memExists{gone: map[string]bool{"sbx-1": true}}
	req := sampleRequest(now.Add(time.Hour))
	req.Attestation = signGrant(t, priv, req)
	if _, _, err := svc.Issue(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if err := svc.Reserve(context.Background(), req.GrantID, "measurement", "sbx-1", "sess-1", 4); err != nil {
		t.Fatal(err)
	}
	svc.ReapOnce(context.Background())
	view, err := svc.Get(context.Background(), req.GrantID)
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Sandboxes) != 1 || view.Sandboxes[0].State != runtimev1alpha1.SandboxEnded {
		t.Fatalf("view=%+v", view)
	}
	if view.Usage["measurement"].GPUs != 0 || view.Usage["measurement"].Sandboxes != 0 {
		t.Fatalf("usage=%+v", view.Usage)
	}
}

func TestExtendRejectsEarlierExpiry(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	svc, priv, _, _ := testService(t, now)
	req := sampleRequest(now.Add(2 * time.Hour))
	req.Attestation = signGrant(t, priv, req)
	if _, _, err := svc.Issue(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	_, err := svc.Extend(context.Background(), req.GrantID, ExtendRequest{ExpiresAt: now.Add(time.Hour), Attestation: req.Attestation})
	if !IsReason(err, "invalid_grant") {
		t.Fatalf("err=%v", err)
	}
}

func idOf(i int) string {
	return "sbx-" + itoa(i)
}

func TestEndKeepsSandboxRef(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	svc, priv, _, _ := testService(t, now)
	req := sampleRequest(now.Add(time.Hour))
	req.Attestation = signGrant(t, priv, req)
	if _, _, err := svc.Issue(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	ref, err := svc.BeginSandbox(context.Background(), BeginRequest{
		GrantID: req.GrantID, Role: "measurement", SandboxID: "sbx-1",
		TemplateID: "ar-01ja-runner-g1", GPUs: 1, TimeoutSec: 60, IdempotencyKey: "once",
		AccessTokenHash: "abc",
	})
	if err != nil {
		t.Fatal(err)
	}
	if ref.State != runtimev1alpha1.SandboxPending || ref.SessionID != "sbx-1" {
		t.Fatalf("ref=%+v", ref)
	}
	if err := svc.EndSandbox(context.Background(), req.GrantID, "sbx-1", "killed"); err != nil {
		t.Fatal(err)
	}
	view, err := svc.Get(context.Background(), req.GrantID)
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Sandboxes) != 1 || view.Sandboxes[0].State != runtimev1alpha1.SandboxEnded {
		t.Fatalf("view=%+v", view.Sandboxes)
	}
	if view.Usage["measurement"].Sandboxes != 0 || view.Sandboxes[0].AccessTokenHash != "" {
		t.Fatalf("usage=%+v hash=%q", view.Usage, view.Sandboxes[0].AccessTokenHash)
	}
	_, err = svc.BeginSandbox(context.Background(), BeginRequest{
		GrantID: req.GrantID, Role: "measurement", SandboxID: "sbx-2",
		TemplateID: "ar-01ja-runner-g1", GPUs: 1, TimeoutSec: 60, IdempotencyKey: "once",
	})
	var replay *Replay
	if !errors.As(err, &replay) || replay.Ref.ID != "sbx-1" || replay.Ref.State != runtimev1alpha1.SandboxEnded {
		t.Fatalf("err=%v replay=%+v", err, replay)
	}
}

func assertQuantity(t *testing.T, list corev1.ResourceList, cpu, memory string) {
	t.Helper()
	gotCPU := list[corev1.ResourceCPU]
	gotMemory := list[corev1.ResourceMemory]
	if gotCPU.Cmp(resource.MustParse(cpu)) != 0 || gotMemory.Cmp(resource.MustParse(memory)) != 0 {
		t.Fatalf("resources=%v", list)
	}
}

func envValue(env []corev1.EnvVar, name string) string {
	for _, item := range env {
		if item.Name == name {
			return item.Value
		}
	}
	return ""
}

func TestIssueRegistersFromImage(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	svc, priv, _, _ := testService(t, now)
	req := sampleRequest(now.Add(time.Hour))
	req.Templates[0].Spec = json.RawMessage(`{"template":{"fromImage":"example@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","steps":[{"type":"run","args":["echo pth"]}]}}`)
	req.Attestation = signGrant(t, priv, req)
	if _, _, err := svc.Issue(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"ar-01ja-runner-g1", "ar-01ja-runner-g8"} {
		ci := &runtimev1alpha1.CodeInterpreter{}
		if err := svc.client.Get(context.Background(), types.NamespacedName{Name: name, Namespace: svc.namespace}, ci); err != nil {
			t.Fatal(name, err)
		}
		if ci.Spec.Template == nil || !strings.HasPrefix(ci.Spec.Template.FromImage, "example@sha256:") {
			t.Fatalf("%s image=%+v", name, ci.Spec.Template)
		}
		if len(ci.Spec.Template.Steps) != 1 || ci.Spec.Template.Steps[0].Args[0] != "echo pth" {
			t.Fatalf("%s steps=%+v", name, ci.Spec.Template.Steps)
		}
		if ci.Annotations["agent-sandbox.io/grant-id"] != req.GrantID || ci.Spec.GPU == nil || ci.Spec.GPU.ResourceName != "amd.com/gpu" {
			t.Fatalf("%s ci=%+v", name, ci)
		}
	}
	g1 := &runtimev1alpha1.CodeInterpreter{}
	if err := svc.client.Get(context.Background(), types.NamespacedName{Name: "ar-01ja-runner-g1", Namespace: svc.namespace}, g1); err != nil {
		t.Fatal(err)
	}
	if g1.Spec.GPU.Count != 1 || g1.Spec.GPU.SharedMemory != "125Gi" {
		t.Fatalf("gpu=%+v", g1.Spec.GPU)
	}
	assertQuantity(t, g1.Spec.Template.Resources.Requests, "27", "250Gi")
	if digest := envValue(g1.Spec.Template.Environment, "HYPERLOOM_ACTIVE_IMAGE_DIGEST"); digest != "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" {
		t.Fatalf("digest=%q", digest)
	}
	g8 := &runtimev1alpha1.CodeInterpreter{}
	if err := svc.client.Get(context.Background(), types.NamespacedName{Name: "ar-01ja-runner-g8", Namespace: svc.namespace}, g8); err != nil {
		t.Fatal(err)
	}
	if g8.Spec.GPU.Count != 8 || g8.Spec.GPU.SharedMemory != "1000Gi" {
		t.Fatalf("gpu=%+v", g8.Spec.GPU)
	}
	assertQuantity(t, g8.Spec.Template.Resources.Requests, "216", "2000Gi")
	if _, err := svc.Revoke(context.Background(), req.GrantID); err != nil {
		t.Fatal(err)
	}
	err := svc.client.Get(context.Background(), types.NamespacedName{Name: "ar-01ja-runner-g1", Namespace: svc.namespace}, &runtimev1alpha1.CodeInterpreter{})
	if !apierrors.IsNotFound(err) {
		t.Fatalf("err=%v", err)
	}
}

func TestIssueRejectsRoleName(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	for _, role := range []string{"Planner", "code_runner", strings.Repeat("a", 41)} {
		svc, priv, _, _ := testService(t, now)
		req := sampleRequest(now.Add(time.Hour))
		req.Roles = map[string]RoleRequest{role: {Templates: []string{"runner"}, MaxSandboxes: 1, MaxGPUs: 1}}
		req.Attestation = signGrant(t, priv, req)
		_, _, err := svc.Issue(context.Background(), req)
		if !IsReason(err, "invalid_grant") || !strings.Contains(err.Error(), "display name") {
			t.Fatalf("role %s err=%v", role, err)
		}
	}
}

func TestTimeoutCannotOutliveGrant(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	clock := now
	svc, priv, _, _ := testService(t, now)
	svc.now = func() time.Time { return clock }
	req := sampleRequest(now.Add(time.Hour))
	req.MaxSandboxSeconds = 600
	req.Attestation = signGrant(t, priv, req)
	if _, _, err := svc.Issue(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.BeginSandbox(context.Background(), BeginRequest{
		GrantID: req.GrantID, Role: "measurement", SandboxID: "sbx-1",
		TemplateID: "ar-01ja-runner-g1", GPUs: 1, TimeoutSec: 600,
	}); err != nil {
		t.Fatal(err)
	}
	clock = now.Add(500 * time.Second)
	err := svc.SetSandboxTimeout(context.Background(), req.GrantID, "measurement", "sbx-1", 101)
	if !IsReason(err, "timeout_not_allowed") {
		t.Fatalf("err=%v", err)
	}
	if err := svc.SetSandboxTimeout(context.Background(), req.GrantID, "measurement", "sbx-1", 100); err != nil {
		t.Fatal(err)
	}
}

func TestReclaimCountsLiveGPUSecondsOnce(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	clock := now
	svc, priv, _, reclaimer := testService(t, now)
	svc.now = func() time.Time { return clock }
	req := sampleRequest(now.Add(time.Hour))
	req.GPUHoursBudget = 10
	req.Roles["measurement"] = RoleRequest{Templates: []string{"runner"}, MaxSandboxes: 2, MaxGPUs: 8}
	req.Attestation = signGrant(t, priv, req)
	if _, _, err := svc.Issue(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.BeginSandbox(context.Background(), BeginRequest{
		GrantID: req.GrantID, Role: "measurement", SandboxID: "sbx-1",
		TemplateID: "ar-01ja-runner-g1", GPUs: 2, TimeoutSec: 60,
	}); err != nil {
		t.Fatal(err)
	}
	clock = now.Add(10 * time.Second)
	if err := svc.EndSandbox(context.Background(), req.GrantID, "sbx-1", "killed"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.BeginSandbox(context.Background(), BeginRequest{
		GrantID: req.GrantID, Role: "measurement", SandboxID: "sbx-2",
		TemplateID: "ar-01ja-runner-g1", GPUs: 4, TimeoutSec: 60,
	}); err != nil {
		t.Fatal(err)
	}
	clock = now.Add(15 * time.Second)
	resp, err := svc.Revoke(context.Background(), req.GrantID)
	if err != nil || resp.Remaining != 0 {
		t.Fatalf("resp=%+v err=%v", resp, err)
	}
	view, err := svc.Get(context.Background(), req.GrantID)
	if err != nil {
		t.Fatal(err)
	}
	if view.GPUSeconds != 40 || view.Usage["measurement"].Sandboxes != 0 || len(view.Sandboxes) != 2 {
		t.Fatalf("view gpu=%d usage=%+v sandboxes=%d", view.GPUSeconds, view.Usage["measurement"], len(view.Sandboxes))
	}
	if len(reclaimer.ids) != 1 || reclaimer.ids[0] != "sbx-2" {
		t.Fatalf("reclaimed=%v", reclaimer.ids)
	}
}

func TestLookupAccessRejectsRevokedGrant(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	svc, priv, _, _ := testService(t, now)
	req := sampleRequest(now.Add(time.Hour))
	req.Attestation = signGrant(t, priv, req)
	if _, _, err := svc.Issue(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	const token = "sat_test"
	if _, err := svc.BeginSandbox(context.Background(), BeginRequest{
		GrantID: req.GrantID, Role: "measurement", SandboxID: "sbx-1",
		TemplateID: "ar-01ja-runner-g1", GPUs: 1, TimeoutSec: 60,
		AccessTokenHash: HashKey(token),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.LookupAccess(context.Background(), "sbx-1", token); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Revoke(context.Background(), req.GrantID); err != nil {
		t.Fatal(err)
	}
	_, err := svc.LookupAccess(context.Background(), "sbx-1", token)
	if !IsReason(err, "grant_revoked") {
		t.Fatalf("err=%v", err)
	}
}
