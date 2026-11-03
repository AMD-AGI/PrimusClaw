// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"context"
	"errors"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/audit"
)

func int32p(v int32) *int32 { return &v }

// poolRequest issues measurement and dev with the whole run caps on each role and one pool of 8 sandboxes and 8 GPUs.
func poolRequest(expires time.Time) IssueRequest {
	req := sampleRequest(expires)
	req.Roles = map[string]RoleRequest{
		"measurement": {Templates: []string{"runner"}, MaxSandboxes: 8, MaxGPUs: 8},
		"dev":         {Templates: []string{"runner"}, MaxSandboxes: 8, MaxGPUs: 8},
	}
	req.MaxSandboxes = int32p(8)
	req.MaxGPUs = int32p(8)
	req.GPUHoursBudget = 0
	return req
}

func issuePool(t *testing.T, now time.Time) (*Service, IssueRequest, *memRecord) {
	t.Helper()
	svc, priv, rec, _ := testService(t, now)
	req := poolRequest(now.Add(time.Hour))
	req.Attestation = signGrant(t, priv, req)
	if _, _, err := svc.Issue(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	return svc, req, rec
}

func begin(svc *Service, grantID, role, id string, gpus int32) error {
	tpl := "ar-01ja-runner-g1"
	if gpus == 8 {
		tpl = "ar-01ja-runner-g8"
	}
	_, err := svc.BeginSandbox(context.Background(), BeginRequest{GrantID: grantID, Role: role, SandboxID: id, TemplateID: tpl, GPUs: gpus})
	return err
}

func detailOf(err error) string {
	var oe *OpError
	if errors.As(err, &oe) {
		return oe.Detail
	}
	return ""
}

func TestIssueEchoesStoredCaps(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	svc, priv, _, _ := testService(t, now)
	req := poolRequest(now.Add(time.Hour))
	req.Attestation = signGrant(t, priv, req)
	for _, want := range []int{201, 200} {
		resp, status, err := svc.Issue(context.Background(), req)
		if err != nil || status != want {
			t.Fatalf("status=%d err=%v", status, err)
		}
		if resp.MaxSandboxes == nil || *resp.MaxSandboxes != 8 || resp.MaxGPUs == nil || *resp.MaxGPUs != 8 {
			t.Fatalf("status=%d caps=%v %v", status, resp.MaxSandboxes, resp.MaxGPUs)
		}
	}
}

func TestIssueRejectsDroppedCaps(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	svc, priv, _, _ := testService(t, now)
	svc.client = interceptor.NewClient(svc.client.(client.WithWatch), interceptor.Funcs{
		Create: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.CreateOption) error {
			if g, ok := obj.(*runtimev1alpha1.SandboxGrant); ok {
				g.Spec.MaxSandboxes, g.Spec.MaxGPUs = nil, nil
			}
			return c.Create(ctx, obj, opts...)
		},
	})
	req := poolRequest(now.Add(time.Hour))
	req.Attestation = signGrant(t, priv, req)
	_, _, err := svc.Issue(context.Background(), req)
	var oe *OpError
	if !IsReason(err, "grant_caps_unsupported") || !errors.As(err, &oe) || oe.Status != 500 {
		t.Fatalf("err=%v", err)
	}
	var got runtimev1alpha1.SandboxGrant
	if err := svc.client.Get(context.Background(), client.ObjectKey{Namespace: "agent-sandbox-system", Name: req.GrantID}, &got); !apierrors.IsNotFound(err) {
		t.Fatalf("grant kept: %v", err)
	}
}

func TestPoolSharedAcrossRoles(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	svc, req, _ := issuePool(t, now)

	if err := begin(svc, req.GrantID, "dev", "sbx-dev-1", 1); err != nil {
		t.Fatalf("dev 1 gpu: %v", err)
	}
	err := begin(svc, req.GrantID, "measurement", "sbx-m-8", 8)
	if !IsReason(err, "grant_quota_exceeded") || detailOf(err) != "grant gpus: requested 8, in use 1, limit 8" {
		t.Fatalf("measurement 8 gpus: %v", err)
	}
	if err := svc.Reserve(context.Background(), req.GrantID, "measurement", "sbx-m-7", "sess-m-7", 7); err != nil {
		t.Fatalf("measurement 7 gpus: %v", err)
	}
	err = begin(svc, req.GrantID, "dev", "sbx-dev-2", 1)
	if !IsReason(err, "grant_quota_exceeded") || detailOf(err) != "grant gpus: requested 1, in use 8, limit 8" {
		t.Fatalf("dev over pool: %v", err)
	}
}

func TestPoolCapsSandboxes(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	svc, req, _ := issuePool(t, now)
	for i := 0; i < 8; i++ {
		role := "measurement"
		if i%2 == 0 {
			role = "dev"
		}
		if err := svc.Reserve(context.Background(), req.GrantID, role, idOf(i), "sess-"+idOf(i), 0); err != nil {
			t.Fatalf("reserve %d: %v", i, err)
		}
	}
	err := svc.Reserve(context.Background(), req.GrantID, "dev", "sbx-9", "sess-9", 0)
	if !IsReason(err, "grant_quota_exceeded") || detailOf(err) != "grant sandboxes: requested 1, in use 8, limit 8" {
		t.Fatalf("ninth: %v", err)
	}
}

func TestRoleCapDetailNamesUsage(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	svc, priv, _, _ := testService(t, now)
	req := sampleRequest(now.Add(time.Hour))
	req.Roles["dev"] = RoleRequest{Templates: []string{"runner"}, MaxSandboxes: 1, MaxGPUs: 0}
	req.Attestation = signGrant(t, priv, req)
	if _, _, err := svc.Issue(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	err := begin(svc, req.GrantID, "dev", "sbx-dev-1", 1)
	if !IsReason(err, "grant_quota_exceeded") || detailOf(err) != "dev gpus: requested 1, in use 0, limit 0" {
		t.Fatalf("dev: %v", err)
	}
}

func TestBudgetDetailNamesUsage(t *testing.T) {
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
	var oe *OpError
	if !IsReason(err, "grant_budget_exhausted") || !errors.As(err, &oe) || oe.Status != 403 || detailOf(err) != "grant gpu hours: used 1.00, limit 1.00" {
		t.Fatalf("err=%v", err)
	}
}

func TestAuditDeniedRecordsReason(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	svc, req, rec := issuePool(t, now)
	if err := svc.Reserve(context.Background(), req.GrantID, "measurement", "sbx-m-8", "sess-m-8", 8); err != nil {
		t.Fatal(err)
	}
	err := begin(svc, req.GrantID, "dev", "sbx-dev-1", 1)
	svc.AuditDenied(context.Background(), req.GrantID, "sbx-dev-1", err)
	var got *audit.AuditEvent
	for _, e := range rec.full {
		if e.EventType == audit.EventSandboxDenied {
			got = e
		}
	}
	if got == nil || got.Reason != "grant_quota_exceeded" || got.Metadata["detail"] != "grant gpus: requested 1, in use 8, limit 8" {
		t.Fatalf("event=%+v", got)
	}
}

func TestIssueRejectsNegativePool(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	svc, priv, _, _ := testService(t, now)
	req := poolRequest(now.Add(time.Hour))
	req.MaxGPUs = int32p(-1)
	req.Attestation = signGrant(t, priv, req)
	if _, _, err := svc.Issue(context.Background(), req); !IsReason(err, "invalid_grant") {
		t.Fatalf("err=%v", err)
	}
}

func TestIssueReplayComparesPool(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	svc, priv, _, _ := testService(t, now)
	req := poolRequest(now.Add(time.Hour))
	req.Attestation = signGrant(t, priv, req)
	if _, _, err := svc.Issue(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.Issue(context.Background(), req); err != nil {
		t.Fatalf("same replay: %v", err)
	}
	other := cloneIssue(req)
	other.MaxGPUs = int32p(4)
	other.Attestation = signGrant(t, priv, other)
	if _, _, err := svc.Issue(context.Background(), other); !IsReason(err, "grant_conflict") {
		t.Fatalf("other pool: %v", err)
	}
}
