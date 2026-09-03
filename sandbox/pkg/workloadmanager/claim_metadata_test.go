// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// A warm-pool claim that half-succeeded used to look like one that worked.
//
// The pool hands over a Pod that already exists, so everything that makes it
// *this* session's sandbox arrives afterwards as a patch: the session-id
// annotation session recovery reads when the store is gone, the idle-timeout
// annotation that is the only place a configured lifetime lands on this path,
// and the user label the sandbox is attributed by. The patch error was
// discarded, so a transient failure returned a sandbox carrying none of them --
// running on the controller's default timeout instead of the configured one,
// with nothing on the outside to tell from.

package workloadmanager

import (
	"context"
	"errors"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	k8serrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
	extensionsv1alpha1 "sigs.k8s.io/agent-sandbox/extensions/api/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

func claimSandbox() *sandboxv1alpha1.Sandbox {
	return &sandboxv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{Name: "sbx-claimed", Namespace: "sandboxes"},
	}
}

func claimScheme(t *testing.T) *k8sruntime.Scheme {
	t.Helper()
	s := k8sruntime.NewScheme()
	utilruntime.Must(sandboxv1alpha1.AddToScheme(s))
	return s
}

func TestClaimMetadataFailureIsNotSwallowed(t *testing.T) {
	scheme := claimScheme(t)
	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(claimSandbox()).
		WithInterceptorFuncs(interceptor.Funcs{
			Patch: func(context.Context, ctrlclient.WithWatch, ctrlclient.Object,
				ctrlclient.Patch, ...ctrlclient.PatchOption) error {
				return errors.New("conflict")
			},
		}).Build()

	err := applyClaimMetadata(context.Background(), c, claimSandbox(),
		map[string]string{"user": "u1"},
		map[string]string{"runtime.agent-sandbox.io/idle-timeout": "48h"})

	if err == nil {
		t.Fatal("a claim missing its idle timeout and session id must not report success")
	}
	if !strings.Contains(err.Error(), "patch metadata") {
		t.Errorf("the error should say what failed; got %v", err)
	}
}

func TestClaimMetadataWritesWhatItWasGiven(t *testing.T) {
	scheme := claimScheme(t)
	sb := claimSandbox()
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(sb).Build()

	if err := applyClaimMetadata(context.Background(), c, sb,
		map[string]string{"runtime.agent-sandbox.io/user.id": "u1"},
		map[string]string{"runtime.agent-sandbox.io/idle-timeout": "48h"}); err != nil {
		t.Fatalf("applyClaimMetadata: %v", err)
	}

	got := &sandboxv1alpha1.Sandbox{}
	if err := c.Get(context.Background(),
		ctrlclient.ObjectKeyFromObject(sb), got); err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Annotations["runtime.agent-sandbox.io/idle-timeout"] != "48h" {
		t.Errorf("the lifetime did not land: %v", got.Annotations)
	}
	if got.Labels["runtime.agent-sandbox.io/user.id"] != "u1" {
		t.Errorf("the attribution did not land: %v", got.Labels)
	}
}

func TestNothingToWriteIsNotAnError(t *testing.T) {
	// A claim with no user and no session id has nothing to patch, and a
	// pointless API call per claim is worth avoiding.
	scheme := claimScheme(t)
	var patched bool
	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(claimSandbox()).
		WithInterceptorFuncs(interceptor.Funcs{
			Patch: func(context.Context, ctrlclient.WithWatch, ctrlclient.Object,
				ctrlclient.Patch, ...ctrlclient.PatchOption) error {
				patched = true
				return nil
			},
		}).Build()

	if err := applyClaimMetadata(context.Background(), c, claimSandbox(), nil, nil); err != nil {
		t.Fatalf("applyClaimMetadata: %v", err)
	}
	if patched {
		t.Error("patched with an empty body")
	}
}

func TestClaimMetadataRetriesBeforeGivingUp(t *testing.T) {
	// The failures worth surviving are the cheap ones -- a conflict with the
	// controller that just created the object -- and giving up on the first
	// throws away a Pod that came out of the warm pool.
	scheme := claimScheme(t)
	var calls int
	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(claimSandbox()).
		WithInterceptorFuncs(interceptor.Funcs{
			Patch: func(ctx context.Context, cl ctrlclient.WithWatch, o ctrlclient.Object,
				p ctrlclient.Patch, opts ...ctrlclient.PatchOption) error {
				calls++
				if calls == 1 {
					return errors.New("conflict")
				}
				return cl.Patch(ctx, o, p, opts...)
			},
		}).Build()

	if err := applyClaimMetadataWithRetry(context.Background(), c, claimSandbox(),
		nil, map[string]string{"runtime.agent-sandbox.io/idle-timeout": "48h"}); err != nil {
		t.Fatalf("a transient conflict should not fail the claim: %v", err)
	}
	if calls < 2 {
		t.Errorf("it gave up after %d attempt(s)", calls)
	}
}

func TestClaimMetadataStopsRetrying(t *testing.T) {
	// Bounded, because every attempt is holding a Pod out of the pool.
	scheme := claimScheme(t)
	var calls int
	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(claimSandbox()).
		WithInterceptorFuncs(interceptor.Funcs{
			Patch: func(context.Context, ctrlclient.WithWatch, ctrlclient.Object,
				ctrlclient.Patch, ...ctrlclient.PatchOption) error {
				calls++
				return errors.New("still broken")
			},
		}).Build()

	if err := applyClaimMetadataWithRetry(context.Background(), c, claimSandbox(),
		nil, map[string]string{"x": "y"}); err == nil {
		t.Fatal("a claim that never got its metadata must not report success")
	}
	if calls > 5 {
		t.Errorf("retried %d times while holding a pooled Pod", calls)
	}
}

// ── Teardown ────────────────────────────────────────────────────────────────
//
// Rolling back a claim is the other half of not swallowing the patch error.
// Returning the error without tearing down left the Claim, the Sandbox and a
// Pod already out of the pool behind, and the two ways that teardown can
// itself fail quietly are what these cover.

func teardownScheme(t *testing.T) *k8sruntime.Scheme {
	t.Helper()
	s := k8sruntime.NewScheme()
	utilruntime.Must(sandboxv1alpha1.AddToScheme(s))
	utilruntime.Must(extensionsv1alpha1.AddToScheme(s))
	utilruntime.Must(corev1.AddToScheme(s))
	return s
}

// adoptedSet builds the three objects a warm-pool claim leaves behind: the
// Sandbox pointing at its adopted Pod, that Pod, and the Claim.
func adoptedSet() []ctrlclient.Object {
	return []ctrlclient.Object{
		&sandboxv1alpha1.Sandbox{ObjectMeta: metav1.ObjectMeta{
			Name: "sbx-claimed", Namespace: "sandboxes",
			Annotations: map[string]string{"agents.x-k8s.io/pod-name": "pool-pod-7"},
		}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{
			Name: "pool-pod-7", Namespace: "sandboxes",
		}},
		&extensionsv1alpha1.SandboxClaim{ObjectMeta: metav1.ObjectMeta{
			Name: "sbx-claimed", Namespace: "sandboxes",
		}},
	}
}

// A Pod that will not delete must not be outlived by the record that finds it.
// The adopted Pod has no OwnerReference, so nothing cascades to it; deleting
// the Claim anyway is what turns a failed teardown into a permanent zombie.
func TestClaimTeardownKeepsTheClaimWhenThePodSurvives(t *testing.T) {
	c := fake.NewClientBuilder().
		WithScheme(teardownScheme(t)).
		WithObjects(adoptedSet()...).
		WithInterceptorFuncs(interceptor.Funcs{
			Delete: func(ctx context.Context, cl ctrlclient.WithWatch, obj ctrlclient.Object,
				opts ...ctrlclient.DeleteOption) error {
				if _, isPod := obj.(*corev1.Pod); isPod {
					return errors.New("admission webhook denied the request")
				}
				return cl.Delete(ctx, obj, opts...)
			},
		}).Build()

	creator := &K8sSandboxCreator{client: c}
	err := creator.DeleteSandboxClaim(context.Background(), &store.SandboxInfo{
		Namespace: "sandboxes", SandboxName: "sbx-claimed",
	})
	if err == nil {
		t.Fatal("a pod that would not delete must be reported, not dropped")
	}
	if !strings.Contains(err.Error(), "admission webhook") {
		t.Fatalf("the underlying cause must survive: %v", err)
	}

	// The Claim is the only handle a retry has on that Pod.
	claim := &extensionsv1alpha1.SandboxClaim{}
	if getErr := c.Get(context.Background(), types.NamespacedName{
		Namespace: "sandboxes", Name: "sbx-claimed",
	}, claim); getErr != nil {
		t.Fatalf("claim must outlive a failed teardown, got: %v", getErr)
	}
}

// The happy path still removes all three, in order.
func TestClaimTeardownRemovesEverythingItAdopted(t *testing.T) {
	c := fake.NewClientBuilder().
		WithScheme(teardownScheme(t)).
		WithObjects(adoptedSet()...).Build()

	creator := &K8sSandboxCreator{client: c}
	if err := creator.DeleteSandboxClaim(context.Background(), &store.SandboxInfo{
		Namespace: "sandboxes", SandboxName: "sbx-claimed",
	}); err != nil {
		t.Fatalf("teardown: %v", err)
	}
	for name, obj := range map[string]ctrlclient.Object{
		"pod":     &corev1.Pod{},
		"sandbox": &sandboxv1alpha1.Sandbox{},
		"claim":   &extensionsv1alpha1.SandboxClaim{},
	} {
		key := types.NamespacedName{Namespace: "sandboxes", Name: "sbx-claimed"}
		if name == "pod" {
			key.Name = "pool-pod-7"
		}
		if err := c.Get(context.Background(), key, obj); !k8serrors.IsNotFound(err) {
			t.Errorf("%s should be gone, got: %v", name, err)
		}
	}
}

// The rollback runs because the caller gave up, and giving up is what cancels
// the request context -- so a rollback riding it does nothing in exactly the
// case it exists for. It must be detached.
func TestClaimTeardownRunsOnACancelledRequestContext(t *testing.T) {
	c := fake.NewClientBuilder().
		WithScheme(teardownScheme(t)).
		WithObjects(adoptedSet()...).Build()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // the client hung up

	rbCtx, rbCancel := context.WithTimeout(context.WithoutCancel(ctx), claimRollbackTimeout)
	defer rbCancel()
	if err := rbCtx.Err(); err != nil {
		t.Fatalf("the rollback context must not inherit the cancellation: %v", err)
	}

	creator := &K8sSandboxCreator{client: c}
	if err := creator.DeleteSandboxClaim(rbCtx, &store.SandboxInfo{
		Namespace: "sandboxes", SandboxName: "sbx-claimed",
	}); err != nil {
		t.Fatalf("teardown on a detached context: %v", err)
	}
	pod := &corev1.Pod{}
	if err := c.Get(context.Background(), types.NamespacedName{
		Namespace: "sandboxes", Name: "pool-pod-7",
	}, pod); !k8serrors.IsNotFound(err) {
		t.Fatalf("the pod must actually be gone, got: %v", err)
	}
}
