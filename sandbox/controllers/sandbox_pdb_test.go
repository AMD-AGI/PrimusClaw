// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package controllers

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	k8serrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
	asmetrics "sigs.k8s.io/agent-sandbox/internal/metrics"
)

func reconcileSandbox(t *testing.T, r *SandboxReconciler, sb *sandboxv1alpha1.Sandbox) error {
	t.Helper()
	_, err := r.Reconcile(t.Context(), ctrl.Request{NamespacedName: types.NamespacedName{
		Name: sb.Name, Namespace: sb.Namespace}})
	return err
}

// A Pod adopted from a warm pool keeps its own name, so the budget must select
// it by the sandbox label the adoption adds, and must not select the pool's
// unclaimed Pods. Reconciling again keeps the one budget.
func TestThePDBSelectsTheAdoptedPodOnly(t *testing.T) {
	sb := &sandboxv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{Name: "claimed", Namespace: "sb-ns", Generation: 1,
			Annotations: map[string]string{SandboxPodNameAnnotation: "pool-abc12"}},
		Spec: sandboxv1alpha1.SandboxSpec{PodTemplate: sandboxv1alpha1.PodTemplate{
			Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "c"}}}}},
	}
	poolLabels := map[string]string{"agents.x-k8s.io/pool": "warm"}
	adopted := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "pool-abc12", Namespace: "sb-ns", Labels: poolLabels}}
	unclaimed := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "pool-def34", Namespace: "sb-ns", Labels: poolLabels}}
	r := &SandboxReconciler{Client: newFakeClient(sb, adopted, unclaimed), Scheme: Scheme, Tracer: asmetrics.NewNoOp()}
	require.NoError(t, reconcileSandbox(t, r, sb))
	require.NoError(t, reconcileSandbox(t, r, sb))

	pdbs := &policyv1.PodDisruptionBudgetList{}
	require.NoError(t, r.List(t.Context(), pdbs, client.InNamespace("sb-ns")))
	require.Len(t, pdbs.Items, 1)
	selector, err := metav1.LabelSelectorAsSelector(pdbs.Items[0].Spec.Selector)
	require.NoError(t, err)

	live := &corev1.Pod{}
	require.NoError(t, r.Get(t.Context(), types.NamespacedName{Name: "pool-abc12", Namespace: "sb-ns"}, live))
	require.True(t, selector.Matches(labels.Set(live.Labels)), "the budget does not select the adopted Pod %v", live.Labels)
	require.False(t, selector.Matches(labels.Set(unclaimed.Labels)), "the budget selects an unclaimed pool Pod")
}

// readySandbox is a Sandbox whose Pod already runs and is Ready.
func readySandbox() (*sandboxv1alpha1.Sandbox, *corev1.Pod) {
	sb := &sandboxv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{Name: "sb", Namespace: "sb-ns", Generation: 1, UID: "5d0c7a3e-sb"},
		Spec: sandboxv1alpha1.SandboxSpec{PodTemplate: sandboxv1alpha1.PodTemplate{
			Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "c"}}}}},
	}
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "sb", Namespace: "sb-ns"},
		Status: corev1.PodStatus{Phase: corev1.PodRunning,
			Conditions: []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}}},
	}
	return sb, pod
}

func requireReady(t *testing.T, c client.Client, sb *sandboxv1alpha1.Sandbox) {
	t.Helper()
	live := &sandboxv1alpha1.Sandbox{}
	require.NoError(t, c.Get(t.Context(), client.ObjectKeyFromObject(sb), live))
	ready := meta.FindStatusCondition(live.Status.Conditions, string(sandboxv1alpha1.SandboxConditionReady))
	require.NotNil(t, ready)
	require.Equal(t, metav1.ConditionTrue, ready.Status, "Ready is %s/%s: %s", ready.Status, ready.Reason, ready.Message)
}

// A budget this Sandbox controls is held to its spec: one edited down to
// minAvailable 0 would let the eviction through, so it is restored.
func TestADriftedPDBIsRestored(t *testing.T) {
	sb, pod := readySandbox()
	edited := sandboxPDBSpec(NameHash("sb"))
	edited.MinAvailable = ptr.To(intstr.FromInt32(0))
	drifted := &policyv1.PodDisruptionBudget{
		ObjectMeta: metav1.ObjectMeta{Name: "sb", Namespace: "sb-ns", OwnerReferences: []metav1.OwnerReference{{
			APIVersion: "agents.x-k8s.io/v1alpha1", Kind: "Sandbox", Name: "sb", UID: sb.UID, Controller: ptr.To(true)}}},
		Spec: edited,
	}
	r := &SandboxReconciler{Client: newFakeClient(sb, pod, drifted), Scheme: Scheme, Tracer: asmetrics.NewNoOp()}
	require.NoError(t, reconcileSandbox(t, r, sb))

	live := &policyv1.PodDisruptionBudget{}
	require.NoError(t, r.Get(t.Context(), client.ObjectKeyFromObject(drifted), live))
	require.Equal(t, sandboxPDBSpec(NameHash("sb")), live.Spec)
	requireReady(t, r.Client, sb)

	// Restored once: a budget that holds is not written again.
	require.NoError(t, reconcileSandbox(t, r, sb))
	again := &policyv1.PodDisruptionBudget{}
	require.NoError(t, r.Get(t.Context(), client.ObjectKeyFromObject(drifted), again))
	require.Equal(t, live.ResourceVersion, again.ResourceVersion)
}

// A budget of the Sandbox's name that the Sandbox does not control would not
// be collected with it: it is refused, left as it is, and the sandbox stays
// Ready.
func TestAPDBTheSandboxDoesNotControlIsRefused(t *testing.T) {
	sb, pod := readySandbox()
	foreign := &policyv1.PodDisruptionBudget{
		ObjectMeta: metav1.ObjectMeta{Name: "sb", Namespace: "sb-ns"},
		Spec:       policyv1.PodDisruptionBudgetSpec{MinAvailable: ptr.To(intstr.FromInt32(0))},
	}
	r := &SandboxReconciler{Client: newFakeClient(sb, pod, foreign), Scheme: Scheme, Tracer: asmetrics.NewNoOp()}
	err := reconcileSandbox(t, r, sb)
	require.ErrorContains(t, err, "is not controlled by this Sandbox")

	live := &policyv1.PodDisruptionBudget{}
	require.NoError(t, r.Get(t.Context(), client.ObjectKeyFromObject(foreign), live))
	require.Equal(t, foreign.Spec, live.Spec)
	require.Empty(t, live.OwnerReferences)
	requireReady(t, r.Client, sb)
}

// The budget guards the Pod and plays no part in serving it: a budget the
// controller cannot read or write is retried, and does not turn an otherwise
// healthy sandbox unready.
func TestAPDBFailureIsRetriedWithoutFailingReady(t *testing.T) {
	sb, pod := readySandbox()
	forbidden := errors.New("poddisruptionbudgets.policy is forbidden")
	c := fake.NewClientBuilder().WithScheme(Scheme).WithStatusSubresource(&sandboxv1alpha1.Sandbox{}).
		WithRuntimeObjects(sb, pod).
		WithInterceptorFuncs(interceptor.Funcs{Get: func(ctx context.Context, cl client.WithWatch, key client.ObjectKey,
			obj client.Object, opts ...client.GetOption) error {
			if _, ok := obj.(*policyv1.PodDisruptionBudget); ok {
				return forbidden
			}
			return cl.Get(ctx, key, obj, opts...)
		}}).Build()
	r := &SandboxReconciler{Client: c, Scheme: Scheme, Tracer: asmetrics.NewNoOp()}

	require.ErrorIs(t, reconcileSandbox(t, r, sb), forbidden)
	requireReady(t, c, sb)
}

// Expiry deletes the budget this Sandbox controls and no other: a Sandbox
// named like another workload's budget must not delete it on the
// controller's authority. The Sandbox still expires.
func TestExpiryLeavesABudgetTheSandboxDoesNotControl(t *testing.T) {
	for _, policy := range []sandboxv1alpha1.ShutdownPolicy{sandboxv1alpha1.ShutdownPolicyRetain,
		sandboxv1alpha1.ShutdownPolicyDelete} {
		for name, owners := range map[string][]metav1.OwnerReference{
			"no owner": nil,
			"another workload's": {{APIVersion: "apps/v1", Kind: "StatefulSet", Name: "db", UID: "7a1e-db",
				Controller: ptr.To(true)}},
		} {
			t.Run(string(policy)+"/"+name, func(t *testing.T) {
				sb, _ := readySandbox()
				sb.Spec.ShutdownTime = ptr.To(metav1.NewTime(time.Now().Add(-time.Minute)))
				sb.Spec.ShutdownPolicy = ptr.To(policy)
				other := &policyv1.PodDisruptionBudget{
					ObjectMeta: metav1.ObjectMeta{Name: "sb", Namespace: "sb-ns", OwnerReferences: owners},
					Spec:       policyv1.PodDisruptionBudgetSpec{MinAvailable: ptr.To(intstr.FromInt32(1))},
				}
				r := &SandboxReconciler{Client: newFakeClient(sb, other), Scheme: Scheme, Tracer: asmetrics.NewNoOp()}
				require.NoError(t, reconcileSandbox(t, r, sb))

				live := &policyv1.PodDisruptionBudget{}
				require.NoError(t, r.Get(t.Context(), client.ObjectKeyFromObject(other), live))
				require.Equal(t, other.Spec, live.Spec)
				gone := r.Get(t.Context(), client.ObjectKeyFromObject(sb), &sandboxv1alpha1.Sandbox{})
				require.Equal(t, policy == sandboxv1alpha1.ShutdownPolicyDelete, k8serrors.IsNotFound(gone), "%v", gone)
			})
		}
	}
}

// A budget created just before its Sandbox expired, which the cache did not
// show yet when the expiry ran, is deleted once it does: its create event
// reconciles the expired Sandbox, which deletes the budget it controls.
func TestExpiryDeletesABudgetTheCacheShowedLate(t *testing.T) {
	sb, pod := readySandbox()
	lagging := true
	c := fake.NewClientBuilder().WithScheme(Scheme).WithStatusSubresource(&sandboxv1alpha1.Sandbox{}).
		WithRuntimeObjects(sb, pod).
		WithInterceptorFuncs(interceptor.Funcs{Get: func(ctx context.Context, cl client.WithWatch, key client.ObjectKey,
			obj client.Object, opts ...client.GetOption) error {
			if _, ok := obj.(*policyv1.PodDisruptionBudget); ok && lagging {
				return k8serrors.NewNotFound(policyv1.Resource("poddisruptionbudgets"), key.Name)
			}
			return cl.Get(ctx, key, obj, opts...)
		}}).Build()
	r := &SandboxReconciler{Client: c, Scheme: Scheme, Tracer: asmetrics.NewNoOp()}
	require.NoError(t, reconcileSandbox(t, r, sb))
	budgets := &policyv1.PodDisruptionBudgetList{}
	require.NoError(t, r.List(t.Context(), budgets, client.InNamespace(sb.Namespace)))
	require.Len(t, budgets.Items, 1)

	live := &sandboxv1alpha1.Sandbox{}
	require.NoError(t, c.Get(t.Context(), client.ObjectKeyFromObject(sb), live))
	live.Spec.ShutdownTime = ptr.To(metav1.NewTime(time.Now().Add(-time.Minute)))
	live.Spec.ShutdownPolicy = ptr.To(sandboxv1alpha1.ShutdownPolicyRetain)
	require.NoError(t, c.Update(t.Context(), live))
	require.NoError(t, reconcileSandbox(t, r, sb))
	require.NoError(t, c.Get(t.Context(), client.ObjectKeyFromObject(sb), live))
	require.True(t, sandboxMarkedExpired(live))

	lagging = false
	require.NoError(t, reconcileSandbox(t, r, sb))
	err := c.Get(t.Context(), client.ObjectKeyFromObject(sb), &policyv1.PodDisruptionBudget{})
	require.True(t, k8serrors.IsNotFound(err), "the budget outlived its expired Sandbox: %v", err)
}
