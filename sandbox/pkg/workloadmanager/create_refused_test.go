// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynfake "k8s.io/client-go/dynamic/fake"
	k8stesting "k8s.io/client-go/testing"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/e2b"
)

const webhookRefusal = `admission webhook "pod-policy.example.com" denied the request: PolicyRefused: mount "hostpath-2" is beneath the workspace share`

// refusedWorkloadCreator serves a Workload whose status SaFE filled from a
// Sandbox the controller marked PodCreateRefused.
func refusedWorkloadCreator(t *testing.T, status map[string]any) (*SafeWorkloadCreator, *dynfake.FakeDynamicClient) {
	t.Helper()
	prev := workloadPollInterval
	workloadPollInterval = time.Millisecond
	t.Cleanup(func() { workloadPollInterval = prev })

	scheme := k8sruntime.NewScheme()
	if err := runtimev1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	cl := fake.NewClientBuilder().WithScheme(scheme).WithObjects(testCodeInterpreter()).Build()
	dc := dynfake.NewSimpleDynamicClientWithCustomListKinds(k8sruntime.NewScheme(), map[schema.GroupVersionResource]string{
		workloadGVR: "WorkloadList",
	})
	dc.PrependReactor("get", "workloads", func(action k8stesting.Action) (bool, k8sruntime.Object, error) {
		get := action.(k8stesting.GetAction)
		stored, err := dc.Tracker().Get(workloadGVR, get.GetNamespace(), get.GetName())
		if err != nil {
			return true, nil, err
		}
		obj := stored.(*unstructured.Unstructured).DeepCopy()
		obj.Object["status"] = status
		return true, obj, nil
	})
	creator := NewSafeWorkloadCreator(dc, cl)
	creator.SetIdentityAttester(staticAttester{token: "eyJ.identity"})
	return creator, dc
}

// A Workload whose Pod the cluster refused fails the create at once with the
// refusal, whether SaFE ended it or put it back to Pending for another
// dispatch. Before, the create waited out its whole pending deadline.
func TestCreateReturnsTheRefusalAtOnce(t *testing.T) {
	const sandboxID = "sbx-7a9b9b693452f613877992145c818d29"
	refused := sandboxv1alpha1.SandboxPodCreateRefusedPrefix + webhookRefusal
	cases := []struct {
		name   string
		status map[string]any
	}{
		{name: "failed", status: map[string]any{
			"phase":   "Failed",
			"message": refused + `, details: [{"pod":"","node":""}]`,
		}},
		{name: "pending again", status: map[string]any{
			"phase": "Pending",
			"conditions": []any{
				map[string]any{"type": "K8sFailed", "status": "True", "message": refused},
			},
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			creator, dc := refusedWorkloadCreator(t, tc.status)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			start := time.Now()
			_, err := creator.Create(ctx, e2b.CreateRequest{
				SandboxID:   sandboxID,
				TemplateID:  "ar-run-dev-g2",
				Namespace:   "agent-sandbox-system",
				Role:        "dev",
				SessionID:   "s-8f2a",
				Workspace:   "top-models",
				UserID:      "u-123",
				GrantID:     "gr-01jb7m9k2x",
				Attestation: "eyJ.test",
				SubjectKey:  "ak-platform-key",
				Timeout:     time.Minute,
			})
			if !errors.Is(err, e2b.ErrCreateRefused) {
				t.Fatalf("err=%v, want ErrCreateRefused", err)
			}
			if !strings.Contains(err.Error(), "PolicyRefused") || strings.Contains(err.Error(), "details:") {
				t.Fatalf("err=%v", err)
			}
			if elapsed := time.Since(start); elapsed > 2*time.Second {
				t.Fatalf("refusal took %s", elapsed)
			}
			if _, getErr := dc.Tracker().Get(workloadGVR, "", sandboxID); getErr == nil {
				t.Fatal("refused workload was not deleted")
			}
		})
	}
}

func TestWorkloadRefusalIgnoresOtherFailures(t *testing.T) {
	for _, status := range []map[string]any{
		{"phase": "Failed", "message": "Container codeinterpreter terminated: reason=Error exitCode=1"},
		{"phase": "Pending", "conditions": []any{
			map[string]any{"type": "K8sFailed", "status": "False", "message": sandboxv1alpha1.SandboxPodCreateRefusedPrefix + webhookRefusal},
		}},
		{"phase": "Pending"},
	} {
		if got := workloadRefusal(&unstructured.Unstructured{Object: map[string]any{"status": status}}); got != "" {
			t.Fatalf("status=%v refusal=%q", status, got)
		}
	}
}
