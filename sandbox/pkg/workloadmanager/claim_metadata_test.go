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

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
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
