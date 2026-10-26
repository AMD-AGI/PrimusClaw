// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	dynfake "k8s.io/client-go/dynamic/fake"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/grant"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

func TestGrantExistsTreatsLiveWorkloadAsPresent(t *testing.T) {
	const id = "sbx-7a9b9b693452f613877992145c818d29"
	for _, phase := range []string{"", "Pending", "Running", "NotReady", "Updating"} {
		exists := NewGrantExists(store.NewMemoryStore(), NewSafeWorkloadCreator(workloadClient(t, id, phase), nil))
		ok, err := exists.Exists(context.Background(), grant.SandboxRef{ID: id, SessionID: id})
		if err != nil || !ok {
			t.Fatalf("phase %q present=%v err=%v", phase, ok, err)
		}
	}
}

func TestGrantExistsDropsFinishedOrMissingWorkload(t *testing.T) {
	const id = "sbx-7a9b9b693452f613877992145c818d29"
	for _, phase := range []string{"Failed", "Succeeded", "Stopped"} {
		dc := workloadClient(t, id, phase)
		exists := NewGrantExists(store.NewMemoryStore(), NewSafeWorkloadCreator(dc, nil))
		ok, err := exists.Exists(context.Background(), grant.SandboxRef{ID: id, SessionID: id})
		if err != nil || ok {
			t.Fatalf("phase %s present=%v err=%v", phase, ok, err)
		}
	}
	exists := NewGrantExists(store.NewMemoryStore(), NewSafeWorkloadCreator(workloadClient(t, "", ""), nil))
	ok, err := exists.Exists(context.Background(), grant.SandboxRef{ID: id, SessionID: id})
	if err != nil || ok {
		t.Fatalf("missing present=%v err=%v", ok, err)
	}
}

func TestReapKeepsE2BWorkloadAbsentFromSessionStore(t *testing.T) {
	const (
		id        = "sbx-7a9b9b693452f613877992145c818d29"
		namespace = "agent-sandbox-system"
	)
	now := time.Now().UTC().Truncate(time.Second)
	scheme := k8sruntime.NewScheme()
	if err := runtimev1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	cl := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&runtimev1alpha1.SandboxGrant{}).Build()
	g := &runtimev1alpha1.SandboxGrant{
		ObjectMeta: metav1.ObjectMeta{Name: "gr-1", Namespace: namespace},
		Spec:       runtimev1alpha1.SandboxGrantSpec{ExpiresAt: metav1.NewTime(now.Add(time.Hour))},
	}
	if err := cl.Create(context.Background(), g); err != nil {
		t.Fatal(err)
	}
	g.Status = runtimev1alpha1.SandboxGrantStatus{
		State: runtimev1alpha1.GrantStateActive,
		Usage: map[string]runtimev1alpha1.GrantRoleUsage{
			"dev": {Sandboxes: 1, GPUs: 1},
		},
		Sandboxes: []runtimev1alpha1.GrantSandboxRef{{
			ID: id, Role: "dev", GPUs: 1, SessionID: id,
			State: runtimev1alpha1.SandboxRunning, StartedAt: metav1.NewTime(now),
		}},
	}
	if err := cl.Status().Update(context.Background(), g); err != nil {
		t.Fatal(err)
	}
	dc := workloadClient(t, id, "Running")
	svc := grant.New(grant.Options{
		Client:    cl,
		Namespace: namespace,
		Exists:    NewGrantExists(store.NewMemoryStore(), NewSafeWorkloadCreator(dc, nil)),
		Now:       func() time.Time { return now },
	})
	svc.ReapOnce(context.Background())
	got := grantStatus(t, cl, namespace, "gr-1")
	if got.Sandboxes[0].State != runtimev1alpha1.SandboxRunning || got.Usage["dev"].Sandboxes != 1 {
		t.Fatalf("live workload reaped: %+v", got)
	}
	if err := dc.Resource(workloadGVR).Delete(context.Background(), id, metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	svc.ReapOnce(context.Background())
	got = grantStatus(t, cl, namespace, "gr-1")
	if got.Sandboxes[0].State != runtimev1alpha1.SandboxEnded || got.Sandboxes[0].EndReason != "missing" ||
		got.Usage["dev"].Sandboxes != 0 || got.Usage["dev"].GPUs != 0 {
		t.Fatalf("deleted workload kept: %+v", got)
	}
}

func workloadClient(t *testing.T, name, phase string) dynamic.Interface {
	t.Helper()
	dc := dynfake.NewSimpleDynamicClientWithCustomListKinds(k8sruntime.NewScheme(), map[schema.GroupVersionResource]string{
		workloadGVR: "WorkloadList",
	})
	if name == "" {
		return dc
	}
	obj := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "amd.com/v1",
		"kind":       "Workload",
		"metadata":   map[string]any{"name": name},
	}}
	if phase != "" {
		obj.Object["status"] = map[string]any{"phase": phase}
	}
	if _, err := dc.Resource(workloadGVR).Create(context.Background(), obj, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	return dc
}

func grantStatus(t *testing.T, cl client.Client, namespace, name string) runtimev1alpha1.SandboxGrantStatus {
	t.Helper()
	got := &runtimev1alpha1.SandboxGrant{}
	if err := cl.Get(context.Background(), client.ObjectKey{Namespace: namespace, Name: name}, got); err != nil {
		t.Fatal(err)
	}
	return got.Status
}
