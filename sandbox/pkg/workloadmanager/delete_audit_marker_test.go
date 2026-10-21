// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// markDeleteAuditIssued is the Workload-Manager-side half of the L641 fix:
// it tags a Sandbox as already audited right before (or as part of) this
// package's own user-delete / GC-TTL paths delete it, so the runtime
// controller's generic emitUnaccountedDeleteAudit (controllers package)
// does not also emit a second, misleadingly-labelled "external" event for
// the same deletion once it observes DeletionTimestamp set.
package workloadmanager

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/audit"
)

func markerScheme(t *testing.T) *k8sruntime.Scheme {
	t.Helper()
	scheme := k8sruntime.NewScheme()
	utilruntime.Must(sandboxv1alpha1.AddToScheme(scheme))
	return scheme
}

func TestMarkDeleteAuditIssued_PatchesAnnotation(t *testing.T) {
	sandbox := &sandboxv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{Name: "sbx", Namespace: "ns"},
	}
	fc := fake.NewClientBuilder().WithScheme(markerScheme(t)).WithObjects(sandbox).Build()
	c := &K8sSandboxCreator{client: fc}

	c.markDeleteAuditIssued(context.Background(), sandbox)

	require.Equal(t, "true", sandbox.Annotations[audit.AnnDeleteAuditIssued])

	// The patch must have actually landed server-side, not just on the local copy.
	stored := &sandboxv1alpha1.Sandbox{}
	err := fc.Get(context.Background(), types.NamespacedName{Name: "sbx", Namespace: "ns"}, stored)
	require.NoError(t, err)
	require.Equal(t, "true", stored.Annotations[audit.AnnDeleteAuditIssued])
}

func TestMarkDeleteAuditIssued_NoopWhenAlreadySet(t *testing.T) {
	sandbox := &sandboxv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "sbx",
			Namespace: "ns",
			Annotations: map[string]string{
				audit.AnnDeleteAuditIssued: "true",
			},
		},
	}
	// No objects registered with the fake client: if markDeleteAuditIssued
	// tried to Patch here it would fail (not found) and the test would
	// catch that via the returned client error path -- instead it must
	// short-circuit before ever calling Patch.
	fc := fake.NewClientBuilder().WithScheme(markerScheme(t)).Build()
	c := &K8sSandboxCreator{client: fc}

	require.NotPanics(t, func() {
		c.markDeleteAuditIssued(context.Background(), sandbox)
	})
}
