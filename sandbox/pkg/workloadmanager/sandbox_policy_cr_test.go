// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
)

func TestSandboxPolicyCRIsAuthoritativeOverAnnotations(t *testing.T) {
	t.Parallel()
	scheme := runtime.NewScheme()
	utilruntime.Must(sandboxv1alpha1.AddToScheme(scheme))
	utilruntime.Must(runtimev1alpha1.AddToScheme(scheme))

	sb := &sandboxv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "sb-1",
			Namespace: "ns",
			Annotations: map[string]string{
				// Spoofed annotation must not win over the SandboxPolicy CR.
				"runtime.agent-sandbox.io/runtime-policy":       "agent-default",
				"runtime.agent-sandbox.io/allowed-egress-hosts": `["evil.example"]`,
			},
		},
	}
	polCR := &runtimev1alpha1.SandboxPolicy{
		ObjectMeta: metav1.ObjectMeta{Name: "sb-1", Namespace: "ns"},
		Spec: runtimev1alpha1.SandboxPolicySpec{
			RuntimePolicy:      "agent-restricted",
			PolicyMode:         "enforce",
			AllowedEgressHosts: []string{"api.internal.example"},
			PolicyVersion:      3,
		},
	}
	c := &K8sSandboxCreator{
		client: fake.NewClientBuilder().WithScheme(scheme).WithObjects(sb, polCR).Build(),
	}

	pol, found, err := c.GetSandboxPolicy(context.Background(), "ns", "sb-1")
	if err != nil {
		t.Fatalf("GetSandboxPolicy: %v", err)
	}
	if !found {
		t.Fatal("expected SandboxPolicy CR")
	}
	if pol.RuntimePolicy != "agent-restricted" {
		t.Fatalf("RuntimePolicy=%q, want agent-restricted from CR", pol.RuntimePolicy)
	}
	if len(pol.AllowedEgressHosts) != 1 || pol.AllowedEgressHosts[0] != "api.internal.example" {
		t.Fatalf("AllowedEgressHosts=%v, want CR whitelist", pol.AllowedEgressHosts)
	}
	if pol.PolicyVersion != 3 {
		t.Fatalf("PolicyVersion=%d, want 3", pol.PolicyVersion)
	}
}

func TestPatchSandboxPolicyMissingCRDoesNotCreateDefault(t *testing.T) {
	t.Parallel()
	scheme := runtime.NewScheme()
	utilruntime.Must(sandboxv1alpha1.AddToScheme(scheme))
	utilruntime.Must(runtimev1alpha1.AddToScheme(scheme))
	sb := &sandboxv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{Name: "sb-1", Namespace: "ns"},
	}
	c := &K8sSandboxCreator{
		client: fake.NewClientBuilder().WithScheme(scheme).WithObjects(sb).Build(),
	}

	_, err := c.PatchSandboxPolicy(context.Background(), "ns", "sb-1", func(p *sandboxPolicy) error {
		p.PolicyMode = "audit"
		return nil
	})
	if !apierrors.IsNotFound(err) {
		t.Fatalf("missing policy: got %v, want NotFound", err)
	}
	var list runtimev1alpha1.SandboxPolicyList
	if err := c.client.List(context.Background(), &list); err != nil {
		t.Fatalf("list policies: %v", err)
	}
	if len(list.Items) != 0 {
		t.Fatalf("missing policy was created: %+v", list.Items)
	}
}

func TestInternalPolicyMissingCRIsNotFound(t *testing.T) {
	t.Parallel()
	gin.SetMode(gin.TestMode)
	scheme := runtime.NewScheme()
	utilruntime.Must(sandboxv1alpha1.AddToScheme(scheme))
	utilruntime.Must(runtimev1alpha1.AddToScheme(scheme))
	sb := &sandboxv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{Name: "sb-1", Namespace: "ns"},
	}
	s := &Server{k8s: &K8sSandboxCreator{
		client: fake.NewClientBuilder().WithScheme(scheme).WithObjects(sb).Build(),
	}}
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodGet, "/v1/internal/policy/ns/sb-1", nil)
	c.Params = gin.Params{{Key: "namespace", Value: "ns"}, {Key: "name", Value: "sb-1"}}

	s.handleInternalPolicy(c)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing policy: got %d %s, want 404", rec.Code, rec.Body)
	}
}
