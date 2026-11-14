// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
)

// TestBeginSandboxUserTemplateSkipsTemplateList checks that a user template is
// accepted without a grant template entry and still counts against the quota.
func TestBeginSandboxUserTemplateSkipsTemplateList(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	svc, priv, _, _ := testService(t, now)
	req := sampleRequest(now.Add(time.Hour))
	req.Templates[0].Spec = json.RawMessage(`{"fromImage":"example:latest"}`)
	req.Attestation = signGrant(t, priv, req)
	if _, _, err := svc.Issue(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	begin := BeginRequest{GrantID: req.GrantID, Role: "measurement", SandboxID: "sbx-1", TemplateID: "my-tpl", GPUs: 1, TimeoutSec: 60}
	if _, err := svc.BeginSandbox(context.Background(), begin); !IsReason(err, "template_not_allowed") {
		t.Fatalf("template outside the list = %v, want template_not_allowed", err)
	}
	begin.UserTemplate = true
	if _, err := svc.BeginSandbox(context.Background(), begin); err != nil {
		t.Fatalf("user template: %v", err)
	}
	g, err := svc.get(context.Background(), req.GrantID)
	if err != nil {
		t.Fatal(err)
	}
	if u := g.Status.Usage["measurement"]; u.Sandboxes != 1 || u.GPUs != 1 {
		t.Fatalf("usage = %+v, want one sandbox and one GPU", u)
	}
	begin.SandboxID, begin.GPUs = "sbx-2", 1000
	if _, err := svc.BeginSandbox(context.Background(), begin); err == nil {
		t.Fatal("user template bypassed the GPU quota")
	}
}

// TestUserTemplateLookup checks that only a workspace-labelled template that no
// grant owns is returned, and anything else is 404 template_not_found.
func TestUserTemplateLookup(t *testing.T) {
	svc, _, _, _ := testService(t, time.Now())
	ctx := context.Background()
	put := func(name string, labels map[string]string, gpus int) {
		ci := &runtimev1alpha1.CodeInterpreter{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: svc.namespace, Labels: labels}}
		if gpus > 0 {
			ci.Spec.GPU = &runtimev1alpha1.GPUConfig{Count: gpus}
		}
		if err := svc.client.Create(ctx, ci); err != nil {
			t.Fatal(err)
		}
	}
	put("mine", map[string]string{TemplateWorkspaceLabel: "lab", TemplateUserLabel: "u-1", TemplatePublicLabel: "true"}, 2)
	put("plain", nil, 0)
	put("granted", map[string]string{TemplateWorkspaceLabel: "lab", grantIDKey: "gr-1"}, 0)

	got, err := svc.UserTemplate(ctx, "mine")
	if err != nil {
		t.Fatal(err)
	}
	if want := (UserTemplate{Name: "mine", Workspace: "lab", UserID: "u-1", Public: true, GPUs: 2}); got != want {
		t.Fatalf("UserTemplate = %+v, want %+v", got, want)
	}
	for _, name := range []string{"plain", "granted", "absent"} {
		_, err := svc.UserTemplate(ctx, name)
		oe, ok := err.(*OpError)
		if !ok || oe.Status != http.StatusNotFound || oe.Reason != "template_not_found" {
			t.Fatalf("UserTemplate(%s) = %v, want 404 template_not_found", name, err)
		}
	}
}
