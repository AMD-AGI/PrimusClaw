// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"errors"
	"testing"
	"time"

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
	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
)

func policyRollbackScheme(t *testing.T) *k8sruntime.Scheme {
	t.Helper()
	s := teardownScheme(t)
	utilruntime.Must(runtimev1alpha1.AddToScheme(s))
	return s
}

// policyCreateFails rejects SandboxPolicy creates and cancels the request,
// which is how a caller gives up. Deletes are recorded so the test can see
// whether the rollback ran on that cancelled context.
func policyCreateFails(cancel context.CancelFunc, seen *[]deletion) interceptor.Funcs {
	return interceptor.Funcs{
		Create: func(ctx context.Context, cl ctrlclient.WithWatch, obj ctrlclient.Object, opts ...ctrlclient.CreateOption) error {
			if _, ok := obj.(*runtimev1alpha1.SandboxPolicy); ok {
				cancel()
				return errors.New("policy create rejected")
			}
			return cl.Create(ctx, obj, opts...)
		},
		Delete: func(ctx context.Context, cl ctrlclient.WithWatch, obj ctrlclient.Object, opts ...ctrlclient.DeleteOption) error {
			d := deletion{kind: deletionKindOf(obj), ctxErr: ctx.Err()}
			if dl, ok := ctx.Deadline(); ok {
				d.hasDeadline, d.deadline = true, time.Until(dl)
			}
			*seen = append(*seen, d)
			return cl.Delete(ctx, obj, opts...)
		},
	}
}

func TestCreateDirectDeletesSandboxWhenPolicyCreateFails(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	seen := &[]deletion{}
	c := fake.NewClientBuilder().
		WithScheme(policyRollbackScheme(t)).
		WithInterceptorFuncs(policyCreateFails(cancel, seen)).
		Build()
	creator := &K8sSandboxCreator{client: c}
	ci := &runtimev1alpha1.CodeInterpreter{
		ObjectMeta: metav1.ObjectMeta{Name: "tmpl", Namespace: "sandboxes"},
		Spec: runtimev1alpha1.CodeInterpreterSpec{
			AuthMode: runtimev1alpha1.AuthModeNone,
			Template: &runtimev1alpha1.CodeInterpreterSandboxTemplate{FromImage: "python:3.11"},
		},
	}

	res, err := creator.createDirect(ctx, ci, "sbx-direct", "sandboxes", "sandboxes/sbx-direct", nil, nil)
	if err == nil {
		t.Fatalf("a sandbox whose policy never landed must not look created, got %+v", res)
	}
	assertDeletedDetached(t, *seen)
	if getErr := c.Get(context.Background(), types.NamespacedName{
		Namespace: "sandboxes", Name: "sbx-direct",
	}, &sandboxv1alpha1.Sandbox{}); !k8serrors.IsNotFound(getErr) {
		t.Fatalf("sandbox survived the policy failure, got: %v", getErr)
	}
}

func TestCreateViaClaimRollsBackWhenPolicyCreateFails(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	seen := &[]deletion{}
	c := fake.NewClientBuilder().
		WithScheme(policyRollbackScheme(t)).
		WithObjects(
			adoptedSandbox(),
			&corev1.Pod{ObjectMeta: metav1.ObjectMeta{
				Name: "pool-pod-7", Namespace: "sandboxes",
			}},
		).
		WithInterceptorFuncs(policyCreateFails(cancel, seen)).
		Build()
	reconciler := &SandboxReconciler{}
	creator := &K8sSandboxCreator{client: c, reconciler: reconciler}
	handedOver := deliverAdoptedSandbox(t, reconciler, types.NamespacedName{
		Namespace: "sandboxes", Name: "sbx-claimed",
	})
	ci := &runtimev1alpha1.CodeInterpreter{
		ObjectMeta: metav1.ObjectMeta{Name: "tmpl", Namespace: "sandboxes"},
		Spec:       runtimev1alpha1.CodeInterpreterSpec{AuthMode: runtimev1alpha1.AuthModeNone},
	}

	res, err := creator.createViaClaim(ctx, ci, "sbx-claimed", "sandboxes/sbx-claimed", nil, nil)
	handedOver()
	if err == nil {
		t.Fatalf("a claim whose policy never landed must not look created, got %+v", res)
	}
	assertDeletedDetached(t, *seen)
	assertNothingAdoptedSurvives(t, c)
}
