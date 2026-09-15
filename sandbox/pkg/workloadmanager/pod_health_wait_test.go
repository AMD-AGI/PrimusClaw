// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Does a sandbox that died explain itself, or does it report a timeout?
//
// waitForPodHealthy learns why a Pod failed from isPodFailed, which reads the Pod
// while it is still there. The diagnostics helper then re-lists the Pod to enrich
// the error — and a Pod that failed is usually deleted by the controller moments
// later, so that second read frequently finds nothing. When the reason was dropped
// on the floor between those two reads, the caller got "timeout waiting for sandbox
// to be Running" for a container that had exited 1 within two seconds: the wrong
// diagnosis, and no lead for whoever has to fix the template.
//
// These tests pin both halves: the reason survives the Pod's deletion, and a Pod
// that simply never became ready is still reported as a timeout rather than as a
// failure we cannot name.

package workloadmanager

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
)

const (
	healthTestNS      = "sandboxes"
	healthTestSandbox = "sbx-health"
)

func healthTestPod(statuses []corev1.ContainerStatus) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      healthTestSandbox + "-pod",
			Namespace: healthTestNS,
			Labels:    map[string]string{sandboxNameLabelKey: healthTestSandbox},
		},
		Status: corev1.PodStatus{
			Phase:             corev1.PodRunning,
			ContainerStatuses: statuses,
		},
	}
}

func healthTestScheme(t *testing.T) *k8sruntime.Scheme {
	t.Helper()
	scheme := k8sruntime.NewScheme()
	utilruntime.Must(corev1.AddToScheme(scheme))
	return scheme
}

// The Pod is visible to the failure check and gone by the time diagnostics run —
// exactly the race the reason is carried across.
func TestWaitForPodHealthyReportsReasonAfterPodIsDeleted(t *testing.T) {
	var lists atomic.Int32
	c := fake.NewClientBuilder().
		WithScheme(healthTestScheme(t)).
		WithObjects(healthTestPod([]corev1.ContainerStatus{{
			Name:  "codeinterpreter",
			State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: 1}},
		}})).
		WithInterceptorFuncs(interceptor.Funcs{
			List: func(ctx context.Context, cl ctrlclient.WithWatch, list ctrlclient.ObjectList, opts ...ctrlclient.ListOption) error {
				// Only the first read sees the Pod; afterwards the controller has
				// cleaned it up and the list comes back empty.
				if lists.Add(1) == 1 {
					return cl.List(ctx, list, opts...)
				}
				return nil
			},
		}).
		Build()

	creator := &K8sSandboxCreator{client: c}
	err := creator.waitForPodHealthy(context.Background(), healthTestSandbox, healthTestNS, 50*time.Millisecond)
	if err == nil {
		t.Fatal("expected an error for a Pod whose container exited 1")
	}
	if !strings.Contains(err.Error(), `container "codeinterpreter" exited with code 1`) {
		t.Fatalf("failure reason was lost, error was: %v", err)
	}
	if strings.Contains(err.Error(), "timeout waiting") {
		t.Fatalf("a failed container should not be reported as a timeout, error was: %v", err)
	}
}

// A Pod that is merely slow must keep reporting a timeout: the failure wording is
// reserved for a reason isPodFailed actually produced.
func TestWaitForPodHealthyStillReportsTimeoutWhenNothingFailed(t *testing.T) {
	c := fake.NewClientBuilder().
		WithScheme(healthTestScheme(t)).
		WithObjects(healthTestPod([]corev1.ContainerStatus{{
			Name:  "codeinterpreter",
			Ready: false,
			State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}},
		}})).
		Build()

	creator := &K8sSandboxCreator{client: c}
	err := creator.waitForPodHealthy(context.Background(), healthTestSandbox, healthTestNS, 50*time.Millisecond)
	if err == nil {
		t.Fatal("expected an error for a Pod that never became ready")
	}
	if !strings.Contains(err.Error(), "timeout waiting for sandbox") {
		t.Fatalf("expected a timeout error, got: %v", err)
	}
}
