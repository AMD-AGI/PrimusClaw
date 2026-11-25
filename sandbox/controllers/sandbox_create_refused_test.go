// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package controllers

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	k8serrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
	asmetrics "sigs.k8s.io/agent-sandbox/internal/metrics"
)

const policyRefusal = `PolicyRefused: spec.initContainers[0].volumeMounts[3].mountPath: mount "hostpath-2" is beneath the workspace share`

// webhookDenial is the error the API server returns when a validating
// admission webhook denies a Pod without naming a status code.
func webhookDenial(code int32) error {
	return &k8serrors.StatusError{ErrStatus: metav1.Status{
		Status:  metav1.StatusFailure,
		Code:    code,
		Message: `admission webhook "pod-policy.example.com" denied the request: ` + policyRefusal,
	}}
}

func TestIsTerminalCreateRefusal(t *testing.T) {
	pods := schema.GroupResource{Resource: "pods"}
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{name: "webhook denial", err: webhookDenial(http.StatusBadRequest), want: true},
		{name: "webhook denial with 403", err: webhookDenial(http.StatusForbidden), want: true},
		{name: "webhook denial with 422", err: webhookDenial(http.StatusUnprocessableEntity), want: true},
		{name: "webhook asks to retry", err: webhookDenial(http.StatusTooManyRequests), want: false},
		{name: "webhook unavailable", err: webhookDenial(http.StatusInternalServerError), want: false},
		{name: "invalid pod", err: k8serrors.NewInvalid(schema.GroupKind{Kind: "Pod"}, "sbx", field.ErrorList{field.Required(field.NewPath("spec", "containers"), "")}), want: true},
		{name: "pod security", err: k8serrors.NewForbidden(pods, "sbx", errors.New(`violates PodSecurity "restricted:latest"`)), want: true},
		{name: "quota full", err: k8serrors.NewForbidden(pods, "sbx", errors.New("exceeded quota: compute, requested: cpu=4")), want: false},
		{name: "namespace terminating", err: k8serrors.NewForbidden(pods, "sbx", errors.New("unable to create new content in namespace ns because it is being terminated")), want: false},
		{name: "plain bad request", err: k8serrors.NewBadRequest("bad"), want: false},
		{name: "conflict", err: k8serrors.NewAlreadyExists(pods, "sbx"), want: false},
		{name: "timeout", err: k8serrors.NewServerTimeout(pods, "create", 1), want: false},
		{name: "not an API error", err: errors.New("connection refused"), want: false},
		{name: "nil", err: nil, want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, isTerminalCreateRefusal(tc.err))
		})
	}
}

// A Pod an admission webhook denies is published as Failed with the webhook's
// text on the first refusal, and not created again: before this change the
// controller retried the create for as long as the caller waited, and the
// caller saw a timeout in place of the reason.
func TestWebhookDeniedPodFailsTheSandboxAtOnce(t *testing.T) {
	sandbox := &sandboxv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{Name: "sbx-refused", Namespace: "ws", Generation: 1},
		Spec: sandboxv1alpha1.SandboxSpec{
			Replicas: ptr.To(int32(1)),
			PodTemplate: sandboxv1alpha1.PodTemplate{
				Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "sandbox"}}},
			},
		},
	}
	podCreates := 0
	transient := false
	getFails := false
	c := fake.NewClientBuilder().
		WithScheme(Scheme).
		WithStatusSubresource(&sandboxv1alpha1.Sandbox{}).
		WithObjects(sandbox).
		WithInterceptorFuncs(interceptor.Funcs{
			Get: func(ctx context.Context, cl client.WithWatch, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
				if _, ok := obj.(*corev1.Pod); ok && getFails {
					return k8serrors.NewServiceUnavailable("apiserver restarting")
				}
				return cl.Get(ctx, key, obj, opts...)
			},
			Create: func(ctx context.Context, cl client.WithWatch, obj client.Object, opts ...client.CreateOption) error {
				if _, ok := obj.(*corev1.Pod); ok {
					podCreates++
					if transient {
						return k8serrors.NewServerTimeout(schema.GroupResource{Resource: "pods"}, "create", 1)
					}
					return webhookDenial(http.StatusBadRequest)
				}
				return cl.Create(ctx, obj, opts...)
			},
		}).
		Build()
	r := SandboxReconciler{Client: c, Scheme: Scheme, Tracer: asmetrics.NewNoOp()}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Name: sandbox.Name, Namespace: sandbox.Namespace}}

	result, err := r.Reconcile(t.Context(), req)
	require.NoError(t, err, "a refused Pod must not be retried with backoff")
	require.Zero(t, result.RequeueAfter)
	require.Equal(t, 1, podCreates)

	got := &sandboxv1alpha1.Sandbox{}
	require.NoError(t, c.Get(t.Context(), req.NamespacedName, got))
	failed := meta.FindStatusCondition(got.Status.Conditions, string(sandboxv1alpha1.SandboxConditionFailed))
	require.NotNil(t, failed)
	require.Equal(t, metav1.ConditionTrue, failed.Status)
	require.Equal(t, sandboxv1alpha1.SandboxReasonPodCreateRefused, failed.Reason)
	require.Equal(t, int64(1), failed.ObservedGeneration)
	require.True(t, strings.HasPrefix(failed.Message, sandboxv1alpha1.SandboxPodCreateRefusedPrefix), failed.Message)
	require.Contains(t, failed.Message, policyRefusal)
	ready := meta.FindStatusCondition(got.Status.Conditions, string(sandboxv1alpha1.SandboxConditionReady))
	require.NotNil(t, ready)
	require.Equal(t, metav1.ConditionFalse, ready.Status)
	require.Equal(t, sandboxv1alpha1.SandboxReasonPodCreateRefused, ready.Reason)

	// The status update wakes the controller again; the same spec is not
	// sent to the webhook again and the published refusal stays.
	_, err = r.Reconcile(t.Context(), req)
	require.NoError(t, err)
	require.Equal(t, 1, podCreates)
	require.NoError(t, c.Get(t.Context(), req.NamespacedName, got))
	failed = meta.FindStatusCondition(got.Status.Conditions, string(sandboxv1alpha1.SandboxConditionFailed))
	require.NotNil(t, failed)
	require.Equal(t, sandboxv1alpha1.SandboxReasonPodCreateRefused, failed.Reason)

	// A Pod that cannot be read this time is no reason to forget the refusal
	// of this spec and send it to the webhook again.
	getFails = true
	_, err = r.Reconcile(t.Context(), req)
	require.Error(t, err)
	getFails = false
	require.NoError(t, c.Get(t.Context(), req.NamespacedName, got))
	failed = meta.FindStatusCondition(got.Status.Conditions, string(sandboxv1alpha1.SandboxConditionFailed))
	require.NotNil(t, failed)
	require.Equal(t, sandboxv1alpha1.SandboxReasonPodCreateRefused, failed.Reason)
	_, err = r.Reconcile(t.Context(), req)
	require.NoError(t, err)
	require.Equal(t, 1, podCreates)

	// A new spec may be admitted, so it is tried.
	require.NoError(t, c.Get(t.Context(), req.NamespacedName, got))
	got.Generation = 2
	require.NoError(t, c.Update(t.Context(), got))
	_, err = r.Reconcile(t.Context(), req)
	require.NoError(t, err)
	require.Equal(t, 2, podCreates)

	// A later spec whose create fails for a passing reason does not keep the
	// earlier spec's refusal as its outcome.
	transient = true
	require.NoError(t, c.Get(t.Context(), req.NamespacedName, got))
	got.Generation = 3
	require.NoError(t, c.Update(t.Context(), got))
	_, err = r.Reconcile(t.Context(), req)
	require.Error(t, err)
	require.Equal(t, 3, podCreates)
	require.NoError(t, c.Get(t.Context(), req.NamespacedName, got))
	require.Nil(t, meta.FindStatusCondition(got.Status.Conditions, string(sandboxv1alpha1.SandboxConditionFailed)))
}

// A failure the API server may get past is still retried and leaves no Failed
// condition behind.
func TestTransientPodCreateErrorIsRetried(t *testing.T) {
	sandbox := &sandboxv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{Name: "sbx-quota", Namespace: "ws", Generation: 1},
		Spec: sandboxv1alpha1.SandboxSpec{
			Replicas: ptr.To(int32(1)),
			PodTemplate: sandboxv1alpha1.PodTemplate{
				Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "sandbox"}}},
			},
		},
	}
	c := fake.NewClientBuilder().
		WithScheme(Scheme).
		WithStatusSubresource(&sandboxv1alpha1.Sandbox{}).
		WithObjects(sandbox).
		WithInterceptorFuncs(interceptor.Funcs{
			Create: func(ctx context.Context, cl client.WithWatch, obj client.Object, opts ...client.CreateOption) error {
				if _, ok := obj.(*corev1.Pod); ok {
					return k8serrors.NewForbidden(schema.GroupResource{Resource: "pods"}, obj.GetName(), errors.New("exceeded quota: compute"))
				}
				return cl.Create(ctx, obj, opts...)
			},
		}).
		Build()
	r := SandboxReconciler{Client: c, Scheme: Scheme, Tracer: asmetrics.NewNoOp()}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Name: sandbox.Name, Namespace: sandbox.Namespace}}
	_, err := r.Reconcile(t.Context(), req)
	require.Error(t, err)
	got := &sandboxv1alpha1.Sandbox{}
	require.NoError(t, c.Get(t.Context(), req.NamespacedName, got))
	require.Nil(t, meta.FindStatusCondition(got.Status.Conditions, string(sandboxv1alpha1.SandboxConditionFailed)))
}

func TestPodCreateRefusedMessageIsBounded(t *testing.T) {
	long := errors.New(strings.Repeat("é", podCreateRefusedMessageLimit))
	refused := newPodCreateRefused(long)
	require.LessOrEqual(t, len(refused.message), podCreateRefusedMessageLimit)
	require.True(t, strings.HasPrefix(refused.message, sandboxv1alpha1.SandboxPodCreateRefusedPrefix))
	require.True(t, utf8.ValidString(refused.message))
}
