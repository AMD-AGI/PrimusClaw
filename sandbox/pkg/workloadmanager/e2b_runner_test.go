// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynfake "k8s.io/client-go/dynamic/fake"
	k8stesting "k8s.io/client-go/testing"

	"sigs.k8s.io/agent-sandbox/pkg/e2b"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

type cancelDeleteStore struct {
	store.Store
}

func (s cancelDeleteStore) DeleteSandboxBySessionID(ctx context.Context, sessionID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return s.Store.DeleteSandboxBySessionID(ctx, sessionID)
}

type expiredLimitStore struct {
	store.Store
	limit int64
}

func (s *expiredLimitStore) ListExpiredSandboxes(ctx context.Context, before time.Time, limit int64) ([]*store.SandboxInfo, error) {
	s.limit = limit
	return s.Store.ListExpiredSandboxes(ctx, before, limit)
}

func TestCreateE2BSkipsInferenceKey(t *testing.T) {
	st := store.NewMemoryStore()
	srv := New(Config{Namespace: "ns", DefaultTTL: time.Hour}, st)
	res, err := srv.Create(context.Background(), e2b.CreateRequest{
		SandboxID: "sbx-1", TemplateID: "runner", Namespace: "ns",
		Timeout: time.Minute, UserID: "u-1", Env: map[string]string{"FOO": "1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.PodIP != "127.0.0.1" || res.SandboxName != "runner" {
		t.Fatalf("res=%+v", res)
	}
	info, err := st.GetSandboxBySessionID(context.Background(), "sbx-1")
	if err != nil {
		t.Fatal(err)
	}
	if info.InferenceApiKey != "" || info.Status != "running" || info.UserID != "u-1" {
		t.Fatalf("info=%+v", info)
	}
	if err := srv.SetTimeout(context.Background(), "sbx-1", 2*time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := srv.Delete(context.Background(), "sbx-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetSandboxBySessionID(context.Background(), "sbx-1"); err == nil {
		t.Fatal("session still present")
	}
}

func TestSetTimeoutUpdatesWorkloadWithinCap(t *testing.T) {
	st := store.NewMemoryStore()
	now := time.Now().UTC().Truncate(time.Second)
	started := now.Add(-90 * time.Second)
	if err := st.StoreSandbox(context.Background(), &store.SandboxInfo{
		Kind: store.WorkloadKind, SessionID: "sbx-1", SandboxName: "measurement-1",
		Namespace: "project1-dev", CreatedAt: started, ExpiresAt: now.Add(30 * time.Second),
		Status: "running",
	}); err != nil {
		t.Fatal(err)
	}
	dc := dynfake.NewSimpleDynamicClientWithCustomListKinds(k8sruntime.NewScheme(), map[schema.GroupVersionResource]string{
		workloadGVR: "WorkloadList",
	})
	obj := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "amd.com/v1",
		"kind":       "Workload",
		"metadata":   map[string]any{"name": "measurement-1"},
		"spec":       map[string]any{"timeout": int64(120)},
		"status":     map[string]any{"startTime": started.Format(time.RFC3339)},
	}}
	if _, err := dc.Resource(workloadGVR).Create(context.Background(), obj, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	srv := New(Config{Namespace: "ns"}, st).WithSafeWorkloads(NewSafeWorkloadCreator(dc, nil))
	before := time.Now()
	if err := srv.SetTimeout(context.Background(), "sbx-1", 300*time.Second); err != nil {
		t.Fatal(err)
	}
	got, err := dc.Resource(workloadGVR).Get(context.Background(), "measurement-1", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	timeout, _, _ := unstructured.NestedInt64(got.Object, "spec", "timeout")
	low := workloadTimeoutSeconds(started, before, 300*time.Second)
	high := workloadTimeoutSeconds(started, time.Now(), 300*time.Second)
	if timeout < low || timeout > high {
		t.Fatalf("timeout=%d want %d..%d", timeout, low, high)
	}
}

func TestCreateDropsPlaceholderWhenContextIsCanceled(t *testing.T) {
	base := store.NewMemoryStore()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	srv := New(Config{Namespace: "ns", DefaultTTL: time.Minute}, cancelDeleteStore{Store: base})
	srv.workloads = NewSafeWorkloadCreator(nil, nil)
	_, err := srv.Create(ctx, e2b.CreateRequest{SandboxID: "sbx-1", TemplateID: "runner", Namespace: "ns"})
	if err == nil {
		t.Fatal("expected create error")
	}
	if _, err := base.GetSandboxBySessionID(context.Background(), "sbx-1"); err == nil {
		t.Fatal("placeholder remains")
	}
}

func TestDeleteKeepsSessionWhenWorkloadDeleteFails(t *testing.T) {
	st := store.NewMemoryStore()
	if err := st.StoreSandbox(context.Background(), &store.SandboxInfo{
		Kind: store.WorkloadKind, SessionID: "sbx-1", SandboxName: "sbx-1", Namespace: "ns", Status: "running",
	}); err != nil {
		t.Fatal(err)
	}
	dc := dynfake.NewSimpleDynamicClientWithCustomListKinds(k8sruntime.NewScheme(), map[schema.GroupVersionResource]string{
		workloadGVR: "WorkloadList",
	})
	dc.PrependReactor("delete", "workloads", func(k8stesting.Action) (bool, k8sruntime.Object, error) {
		return true, nil, fmt.Errorf("denied")
	})
	srv := New(Config{Namespace: "ns"}, st).WithSafeWorkloads(NewSafeWorkloadCreator(dc, nil))
	if err := srv.Delete(context.Background(), "sbx-1"); err == nil {
		t.Fatal("expected delete error")
	}
	if _, err := st.GetSandboxBySessionID(context.Background(), "sbx-1"); err != nil {
		t.Fatalf("session removed: %v", err)
	}
}

func TestGCScansPastFailedFirstPage(t *testing.T) {
	base := store.NewMemoryStore()
	st := &expiredLimitStore{Store: base}
	now := time.Now()
	for i := 0; i < 101; i++ {
		id := fmt.Sprintf("sbx-%03d", i)
		if err := base.StoreSandbox(context.Background(), &store.SandboxInfo{
			Kind: store.WorkloadKind, SessionID: id, SandboxName: id,
			Namespace: "ns", ExpiresAt: now.Add(-time.Minute), Status: "running",
		}); err != nil {
			t.Fatal(err)
		}
	}
	dc := dynfake.NewSimpleDynamicClientWithCustomListKinds(k8sruntime.NewScheme(), map[schema.GroupVersionResource]string{
		workloadGVR: "WorkloadList",
	})
	srv := New(Config{Namespace: "ns"}, st).WithSafeWorkloads(NewSafeWorkloadCreator(dc, nil))
	srv.gcOnce(context.Background())
	if st.limit != 0 {
		t.Fatalf("limit=%d", st.limit)
	}
	if _, err := base.GetSandboxBySessionID(context.Background(), "sbx-100"); err == nil {
		t.Fatal("record after the old first page was not collected")
	}
}

func TestNativeDeleteRemovesSafeWorkload(t *testing.T) {
	st := store.NewMemoryStore()
	if err := st.StoreSandbox(context.Background(), &store.SandboxInfo{
		Kind: store.WorkloadKind, SessionID: "sbx-1", SandboxName: "sbx-1",
		Namespace: "project1-dev", Status: "running",
	}); err != nil {
		t.Fatal(err)
	}
	obj := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "amd.com/v1",
		"kind":       "Workload",
		"metadata":   map[string]any{"name": "sbx-1"},
	}}
	dc := dynfake.NewSimpleDynamicClientWithCustomListKinds(k8sruntime.NewScheme(), map[schema.GroupVersionResource]string{
		workloadGVR: "WorkloadList",
	}, obj)
	srv := New(DefaultConfig(), st).WithSafeWorkloads(NewSafeWorkloadCreator(dc, nil))
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodDelete, "/v1/code-interpreter/sessions/sbx-1", nil)
	srv.router.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	_, err := dc.Resource(workloadGVR).Get(context.Background(), "sbx-1", metav1.GetOptions{})
	if !apierrors.IsNotFound(err) {
		t.Fatalf("workload still present: %v", err)
	}
	if _, err := st.GetSandboxBySessionID(context.Background(), "sbx-1"); err == nil {
		t.Fatal("session still present")
	}
}
