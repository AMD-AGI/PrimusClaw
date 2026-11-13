// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/grant"
)

func TestOwnerKeysFailureDoesNotStopStartup(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := runtimev1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	t.Setenv("IDENTITY_INTROSPECT_URL", "http://identity.test/oauth/introspect")
	t.Setenv("IDENTITY_CLIENT_ID", "id")
	t.Setenv("IDENTITY_CLIENT_SECRET", "secret")

	for name, policy := range map[string]string{
		"not json":     "{",
		"no templates": `{"templates":[]}`,
		"bad quota":    `{"templates":[{"name":"t"}],"default":{"maxSandboxes":-2}}`,
	} {
		t.Run(name, func(t *testing.T) {
			grants := grant.New(grant.Options{Client: fake.NewClientBuilder().WithScheme(scheme).Build(), Namespace: "agent-sandbox-system"})
			t.Setenv("E2B_OWNER_POLICY", policy)
			client, supplied := ownerKeys(context.Background(), grants)
			if client == nil || !supplied || grants.OwnerRole() != "" {
				t.Fatalf("client=%v supplied=%v role=%q, want a client, a supplied policy and no owner role", client, supplied, grants.OwnerRole())
			}
			oe, ok := grants.OwnerReady().(*grant.OpError)
			if !ok || oe.Status != http.StatusInternalServerError || oe.Reason != "owner_policy_invalid" || oe.Detail != "owner policy was rejected; see the control plane log" {
				t.Fatalf("OwnerReady = %v, want 500 owner_policy_invalid with a fixed detail", grants.OwnerReady())
			}
			if strings.Contains(oe.Error(), policy) {
				t.Fatalf("response %q contains the policy error", oe.Error())
			}
		})
	}

	grants := grant.New(grant.Options{Client: fake.NewClientBuilder().WithScheme(scheme).Build(), Namespace: "agent-sandbox-system"})
	t.Setenv("IDENTITY_CLIENT_SECRET", "")
	t.Setenv("E2B_OWNER_POLICY", `{"templates":[{"name":"t"}]}`)
	if client, _ := ownerKeys(context.Background(), grants); client != nil {
		t.Fatalf("missing secret: client=%v", client)
	}
}

func TestOwnerKeysRetryTransientPolicyFailure(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := runtimev1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	var failures atomic.Int32
	failures.Store(2)
	cl := fake.NewClientBuilder().WithScheme(scheme).WithInterceptorFuncs(interceptor.Funcs{
		List: func(ctx context.Context, c client.WithWatch, list client.ObjectList, opts ...client.ListOption) error {
			if failures.Add(-1) >= 0 {
				return apierrors.NewServiceUnavailable("apiserver restarting")
			}
			return c.List(ctx, list, opts...)
		},
	}).Build()
	grants := grant.New(grant.Options{Client: cl, Namespace: "agent-sandbox-system"})
	t.Setenv("IDENTITY_INTROSPECT_URL", "http://identity.test/oauth/introspect")
	t.Setenv("IDENTITY_CLIENT_ID", "id")
	t.Setenv("IDENTITY_CLIENT_SECRET", "secret")
	t.Setenv("E2B_OWNER_POLICY", `{"templates":[{"name":"t","perGpuCount":[1],"spec":{"fromImage":"harbor.example/runner@sha256:0123456789abcdef"}}]}`)
	prev := ownerPolicyRetry
	ownerPolicyRetry = time.Millisecond
	t.Cleanup(func() { ownerPolicyRetry = prev })

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if client, supplied := ownerKeys(ctx, grants); client == nil || !supplied {
		t.Fatal("identity keys disabled after a transient failure")
	}
	deadline := time.Now().Add(5 * time.Second)
	for grants.OwnerRole() == "" {
		if time.Now().After(deadline) {
			t.Fatal("owner policy was not applied after retries")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestOwnerKeysEnabledWithoutOwnerPolicy checks that the identity client is kept
// when the introspection client is configured and the owner policy is absent.
func TestOwnerKeysEnabledWithoutOwnerPolicy(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := runtimev1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	grants := grant.New(grant.Options{Client: fake.NewClientBuilder().WithScheme(scheme).Build(), Namespace: "agent-sandbox-system"})
	t.Setenv("IDENTITY_INTROSPECT_URL", "http://identity.test/oauth/introspect")
	t.Setenv("IDENTITY_CLIENT_ID", "id")
	t.Setenv("IDENTITY_CLIENT_SECRET", "secret")
	t.Setenv("E2B_OWNER_POLICY", "")
	t.Setenv("E2B_OWNER_POLICY_FILE", "")

	client, supplied := ownerKeys(context.Background(), grants)
	if client == nil {
		t.Fatal("identity client disabled without an owner policy: SaFE API keys are matched as grant keys")
	}
	if supplied {
		t.Fatal("empty owner policy env reported as supplied")
	}
	if oe, ok := grants.OwnerReady().(*grant.OpError); !ok || oe.Reason != "owner_policy_not_applied" {
		t.Fatalf("OwnerReady = %v, want owner_policy_not_applied", grants.OwnerReady())
	}
	if role := grants.OwnerRole(); role != "" {
		t.Fatalf("owner role = %q without an owner policy, want empty", role)
	}
}
