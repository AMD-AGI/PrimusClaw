// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build e2e

// Requires a live cluster; see basic_test.go. Run with: make test-e2e

package e2e

import (
	"testing"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/utils/ptr"
	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
	"sigs.k8s.io/agent-sandbox/test/e2e/framework"
	"sigs.k8s.io/agent-sandbox/test/e2e/framework/predicates"
)

func TestSandboxReplicas(t *testing.T) {
	tc := framework.NewTestContext(t)

	// Set up a namespace
	ns := &corev1.Namespace{}
	ns.Name = "my-sandbox-ns"
	require.NoError(t, tc.CreateWithCleanup(t.Context(), ns))
	// Create a Sandbox Object
	sandboxObj := simpleSandbox(ns.Name)
	sandboxObj.Spec.Replicas = ptr.To(int32(1))
	require.NoError(t, tc.CreateWithCleanup(t.Context(), sandboxObj))

	nameHash := NameHash(sandboxObj.Name)
	// Assert Sandbox object status reconciles as expected
	p := []predicates.ObjectPredicate{
		predicates.SandboxHasStatus(sandboxv1alpha1.SandboxStatus{
			Service:       "my-sandbox",
			ServiceFQDN:   "my-sandbox.my-sandbox-ns.svc.cluster.local",
			Replicas:      1,
			LabelSelector: "agents.x-k8s.io/sandbox-name-hash=" + nameHash,
			Conditions: []metav1.Condition{
				{
					Message:            "Pod is Ready; Service Exists",
					ObservedGeneration: 1,
					Reason:             "DependenciesReady",
					Status:             "True",
					Type:               "Ready",
				},
			},
		}),
	}
	require.NoError(t, tc.WaitForObject(t.Context(), sandboxObj, p...))
	// Assert Pod and Service objects exist
	pod := &corev1.Pod{}
	pod.Name = "my-sandbox"
	pod.Namespace = "my-sandbox-ns"
	tc.MustExist(pod)

	service := &corev1.Service{}
	service.Name = "my-sandbox"
	service.Namespace = "my-sandbox-ns"
	tc.MustExist(service)

	// Set replicas to zero
	framework.MustUpdateObject(tc.ClusterClient, sandboxObj, func(obj *sandboxv1alpha1.Sandbox) {
		obj.Spec.Replicas = ptr.To(int32(0))
	})

	// Wait for sandbox status to reflect new state
	p = []predicates.ObjectPredicate{
		predicates.SandboxHasStatus(sandboxv1alpha1.SandboxStatus{
			Service:       "my-sandbox",
			ServiceFQDN:   "my-sandbox.my-sandbox-ns.svc.cluster.local",
			Replicas:      0,
			LabelSelector: "",
			Conditions: []metav1.Condition{
				{
					Message:            "Pod does not exist, replicas is 0; Service Exists",
					ObservedGeneration: 2,
					Reason:             "DependenciesReady",
					Status:             "True",
					Type:               "Ready",
				},
			},
		}),
	}
	require.NoError(t, tc.WaitForObject(t.Context(), sandboxObj, p...))
	// Verify Pod is deleted but Service still exists
	require.NoError(t, tc.WaitForObjectNotFound(t.Context(), pod))
	tc.MustMatchPredicates(service, predicates.NotDeleted())
}
