// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynfake "k8s.io/client-go/dynamic/fake"
	k8stesting "k8s.io/client-go/testing"

	"sigs.k8s.io/agent-sandbox/pkg/store"
)

const e2bWorkloadID = "sbx-7a9b9b693452f613877992145c818d29"

// noWriteStore drops writes, like CRStore does for E2B sandboxes.
type noWriteStore struct{ store.Store }

func (noWriteStore) StoreSandbox(context.Context, *store.SandboxInfo) error  { return nil }
func (noWriteStore) UpdateSandbox(context.Context, *store.SandboxInfo) error { return nil }

func e2bWorkload(name, phase string, labels map[string]any) *unstructured.Unstructured {
	obj := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "amd.com/v1",
		"kind":       "Workload",
		"metadata": map[string]any{
			"name":        name,
			"labels":      labels,
			"annotations": map[string]any{safeUserNameAnnotation: "alice"},
		},
		"spec": map[string]any{"workspace": "project1-dev", "timeout": int64(300)},
	}}
	if phase != "" {
		obj.Object["status"] = map[string]any{
			"phase":     phase,
			"startTime": "2026-10-27T08:00:00Z",
			"pods":      []any{map[string]any{"podIP": "10.2.0.4", "adminNodeName": "node-1"}},
		}
	}
	return obj
}

func e2bLabels() map[string]any {
	return map[string]any{ownerSessionIDLabel: "claw-session", safeUserIDLabel: "u-1"}
}

func workloadStoreClient(objs ...k8sruntime.Object) *dynfake.FakeDynamicClient {
	return dynfake.NewSimpleDynamicClientWithCustomListKinds(k8sruntime.NewScheme(), map[schema.GroupVersionResource]string{
		workloadGVR: "WorkloadList",
	}, objs...)
}

func TestWorkloadSessionStoreResolvesE2BWorkload(t *testing.T) {
	dc := workloadStoreClient(e2bWorkload(e2bWorkloadID, "Running", e2bLabels()))
	st := NewWorkloadSessionStore(noWriteStore{store.NewMemoryStore()}, NewSafeWorkloadCreator(dc, nil))
	info, err := st.GetSandboxBySessionID(context.Background(), e2bWorkloadID)
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 10, 27, 8, 5, 0, 0, time.UTC)
	if info.Kind != store.WorkloadKind || info.SandboxName != e2bWorkloadID || info.Namespace != "project1-dev" ||
		info.PodIP != "10.2.0.4" || info.PodPort != envdPort || info.Status != "running" ||
		info.UserID != "u-1" || info.UserName != "alice" || !info.ExpiresAt.Equal(want) {
		t.Fatalf("info=%+v", info)
	}
}

func TestWorkloadSessionStorePendingWorkloadHasNoAddress(t *testing.T) {
	dc := workloadStoreClient(e2bWorkload(e2bWorkloadID, "", e2bLabels()))
	st := NewWorkloadSessionStore(noWriteStore{store.NewMemoryStore()}, NewSafeWorkloadCreator(dc, nil))
	info, err := st.GetSandboxBySessionID(context.Background(), e2bWorkloadID)
	if err != nil {
		t.Fatal(err)
	}
	if info.PodIP != "" || info.Status != "creating" {
		t.Fatalf("info=%+v", info)
	}
}

func TestWorkloadSessionStoreIgnoresOtherWorkloads(t *testing.T) {
	cases := map[string]*unstructured.Unstructured{
		"failed":     e2bWorkload(e2bWorkloadID, "Failed", e2bLabels()),
		"stopped":    e2bWorkload(e2bWorkloadID, "Stopped", e2bLabels()),
		"succeeded":  e2bWorkload(e2bWorkloadID, "Succeeded", e2bLabels()),
		"no session": e2bWorkload(e2bWorkloadID, "Running", map[string]any{safeUserIDLabel: "u-1"}),
		"not e2b":    e2bWorkload("train-job-abcde", "Running", e2bLabels()),
	}
	for name, obj := range cases {
		st := NewWorkloadSessionStore(store.NewMemoryStore(), NewSafeWorkloadCreator(workloadStoreClient(obj), nil))
		if _, err := st.GetSandboxBySessionID(context.Background(), obj.GetName()); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("%s: err=%v", name, err)
		}
	}
	st := NewWorkloadSessionStore(store.NewMemoryStore(), NewSafeWorkloadCreator(workloadStoreClient(), nil))
	if _, err := st.GetSandboxBySessionID(context.Background(), e2bWorkloadID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing: err=%v", err)
	}
}

func TestWorkloadSessionStoreReturnsAPIError(t *testing.T) {
	dc := workloadStoreClient()
	dc.PrependReactor("get", "workloads", func(k8stesting.Action) (bool, k8sruntime.Object, error) {
		return true, nil, fmt.Errorf("apiserver unavailable")
	})
	st := NewWorkloadSessionStore(store.NewMemoryStore(), NewSafeWorkloadCreator(dc, nil))
	_, err := st.GetSandboxBySessionID(context.Background(), e2bWorkloadID)
	if err == nil || errors.Is(err, store.ErrNotFound) {
		t.Fatalf("err=%v", err)
	}
}

func TestWorkloadSessionStoreKeepsNativeRecord(t *testing.T) {
	base := store.NewMemoryStore()
	if err := base.StoreSandbox(context.Background(), &store.SandboxInfo{
		Kind: store.SandboxKind, SessionID: e2bWorkloadID, SandboxName: "native", Namespace: "ns",
	}); err != nil {
		t.Fatal(err)
	}
	dc := workloadStoreClient(e2bWorkload(e2bWorkloadID, "Running", e2bLabels()))
	st := NewWorkloadSessionStore(base, NewSafeWorkloadCreator(dc, nil))
	info, err := st.GetSandboxBySessionID(context.Background(), e2bWorkloadID)
	if err != nil || info.Kind != store.SandboxKind || info.SandboxName != "native" {
		t.Fatalf("info=%+v err=%v", info, err)
	}
}

func TestE2BDeleteRemovesWorkloadMissingFromStore(t *testing.T) {
	dc := workloadStoreClient(e2bWorkload(e2bWorkloadID, "Running", e2bLabels()))
	workloads := NewSafeWorkloadCreator(dc, nil)
	st := NewWorkloadSessionStore(noWriteStore{store.NewMemoryStore()}, workloads)
	srv := New(Config{Namespace: "ns", DefaultTTL: time.Hour}, st).WithSafeWorkloads(workloads)
	if err := srv.Delete(context.Background(), e2bWorkloadID); err != nil {
		t.Fatal(err)
	}
	if _, err := dc.Resource(workloadGVR).Get(context.Background(), e2bWorkloadID, metav1.GetOptions{}); !apierrors.IsNotFound(err) {
		t.Fatalf("workload still present: %v", err)
	}
}

func TestE2BSetTimeoutUpdatesWorkloadMissingFromStore(t *testing.T) {
	dc := workloadStoreClient(e2bWorkload(e2bWorkloadID, "Running", e2bLabels()))
	workloads := NewSafeWorkloadCreator(dc, nil)
	st := NewWorkloadSessionStore(noWriteStore{store.NewMemoryStore()}, workloads)
	srv := New(Config{Namespace: "ns", DefaultTTL: time.Hour}, st).WithSafeWorkloads(workloads)
	if err := srv.SetTimeout(context.Background(), e2bWorkloadID, 10*time.Minute); err != nil {
		t.Fatal(err)
	}
	got, err := dc.Resource(workloadGVR).Get(context.Background(), e2bWorkloadID, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if timeout, _, _ := unstructured.NestedInt64(got.Object, "spec", "timeout"); timeout <= 300 {
		t.Fatalf("timeout=%d", timeout)
	}
}
