// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"testing"

	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/grant"
)

func TestOwnerKeysFailureDoesNotStopStartup(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := runtimev1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	grants := grant.New(grant.Options{Client: fake.NewClientBuilder().WithScheme(scheme).Build(), Namespace: "agent-sandbox-system"})
	t.Setenv("IDENTITY_INTROSPECT_URL", "http://identity.test/oauth/introspect")
	t.Setenv("IDENTITY_CLIENT_ID", "id")
	t.Setenv("IDENTITY_CLIENT_SECRET", "secret")

	for name, policy := range map[string]string{
		"not json":     "{",
		"no templates": `{"templates":[]}`,
		"bad quota":    `{"templates":[{"name":"t"}],"default":{"maxSandboxes":-2}}`,
	} {
		t.Setenv("E2B_OWNER_POLICY", policy)
		if client := ownerKeys(context.Background(), grants); client != nil || grants.OwnerRole() != "" {
			t.Fatalf("%s: identity keys enabled", name)
		}
	}

	t.Setenv("IDENTITY_CLIENT_SECRET", "")
	t.Setenv("E2B_OWNER_POLICY", `{"templates":[{"name":"t"}]}`)
	if client := ownerKeys(context.Background(), grants); client != nil {
		t.Fatalf("missing secret: client=%v", client)
	}
}
