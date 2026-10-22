// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"testing"

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
