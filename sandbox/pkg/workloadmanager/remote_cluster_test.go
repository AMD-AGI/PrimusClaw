// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"errors"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynfake "k8s.io/client-go/dynamic/fake"

	corev1 "k8s.io/api/core/v1"
	"sigs.k8s.io/agent-sandbox/pkg/store"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

func TestWaitRunningRemoteClusterSkipsPodIP(t *testing.T) {
	const name = "sbx-remote"
	dc := dynfake.NewSimpleDynamicClientWithCustomListKinds(k8sruntime.NewScheme(), map[schema.GroupVersionResource]string{
		workloadGVR: "WorkloadList",
	})
	obj := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "amd.com/v1",
		"kind":       "Workload",
		"metadata": map[string]any{
			"name":   name,
			"labels": map[string]any{safeClusterIDLabel: "crusoe"},
		},
		"status": map[string]any{
			"phase":     "Running",
			"nodeUsage": []any{map[string]any{"node": "node-a"}},
		},
	}}
	if _, err := dc.Resource(workloadGVR).Create(context.Background(), obj, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	creator := NewSafeWorkloadCreator(dc, nil)
	creator.SetRemoteClusters([]string{"crusoe"})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	ip, node, cluster, err := creator.waitRunning(ctx, name, "crusoe-spur-vk")
	if err != nil || ip != "" || node != "node-a" || cluster != "crusoe" {
		t.Fatalf("ip=%q node=%q cluster=%q err=%v", ip, node, cluster, err)
	}
}

func TestSessionSkipsRemoteWorkload(t *testing.T) {
	const name = "sbx-remote"
	dc := dynfake.NewSimpleDynamicClientWithCustomListKinds(k8sruntime.NewScheme(), map[schema.GroupVersionResource]string{
		workloadGVR: "WorkloadList",
	})
	obj := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "amd.com/v1",
		"kind":       "Workload",
		"metadata": map[string]any{
			"name":   name,
			"labels": map[string]any{safeClusterIDLabel: "crusoe", ownerSessionIDLabel: name},
		},
		"spec":   map[string]any{"workspace": "crusoe-spur-vk"},
		"status": map[string]any{"phase": "Running"},
	}}
	if _, err := dc.Resource(workloadGVR).Create(context.Background(), obj, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	creator := NewSafeWorkloadCreator(dc, nil)
	if _, err := creator.Session(context.Background(), name); err != nil {
		t.Fatalf("local session: %v", err)
	}
	creator.SetRemoteClusters([]string{"crusoe"})
	if info, err := creator.Session(context.Background(), name); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("remote session info=%+v err=%v", info, err)
	}
}

func TestPodAddressPrefersMaster(t *testing.T) {
	scheme := k8sruntime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	worker := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{
		Name: "job-worker-0", Namespace: "ws", Labels: map[string]string{safeWorkloadIDLabel: "sbx-1"},
	}, Status: corev1.PodStatus{PodIP: "10.0.0.2"}}
	master := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{
		Name: "job-master-0", Namespace: "ws", Labels: map[string]string{safeWorkloadIDLabel: "sbx-1"},
	}, Status: corev1.PodStatus{PodIP: "10.0.0.1"}}
	cl := fake.NewClientBuilder().WithScheme(scheme).WithObjects(worker, master).Build()
	ip, port, err := NewPodAddressFinder(cl).PodAddress(context.Background(), "ws", "sbx-1")
	if err != nil || ip != "10.0.0.1" || port != envdPort {
		t.Fatalf("ip=%s port=%d err=%v", ip, port, err)
	}
}

func TestPodAddressStaysInNamespace(t *testing.T) {
	scheme := k8sruntime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	decoy := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{
		Name: "x-master-0", Namespace: "other", Labels: map[string]string{safeWorkloadIDLabel: "sbx-1"},
	}, Status: corev1.PodStatus{PodIP: "10.9.9.9"}}
	real := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{
		Name: "job-worker-0", Namespace: "top-models", Labels: map[string]string{safeWorkloadIDLabel: "sbx-1"},
	}, Status: corev1.PodStatus{PodIP: "10.0.0.4"}}
	cl := fake.NewClientBuilder().WithScheme(scheme).WithObjects(decoy, real).Build()
	finder := NewPodAddressFinder(cl)
	ip, _, err := finder.PodAddress(context.Background(), "top-models", "sbx-1")
	if err != nil || ip != "10.0.0.4" {
		t.Fatalf("ip=%s err=%v", ip, err)
	}
	if _, _, err := finder.PodAddress(context.Background(), "", "sbx-1"); err == nil {
		t.Fatal("empty namespace searched the cluster")
	}
}
