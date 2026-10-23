// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
)

type missThenLiveReader struct {
	live ctrlclient.Client
}

func (m missThenLiveReader) Get(ctx context.Context, key ctrlclient.ObjectKey, obj ctrlclient.Object, opts ...ctrlclient.GetOption) error {
	return apierrors.NewNotFound(schema.GroupResource{Group: "agents.x-k8s.io", Resource: "sandboxes"}, key.Name)
}

func (m missThenLiveReader) List(context.Context, ctrlclient.ObjectList, ...ctrlclient.ListOption) error {
	return nil
}

func TestGetSandboxFallsBackToLiveOnCacheMiss(t *testing.T) {
	t.Parallel()
	scheme := runtime.NewScheme()
	utilruntime.Must(sandboxv1alpha1.AddToScheme(scheme))
	sb := &sandboxv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{Name: "alive", Namespace: "ns"},
	}
	live := fake.NewClientBuilder().WithScheme(scheme).WithObjects(sb).Build()
	c := &K8sSandboxCreator{
		client:       live,
		cachedReader: missThenLiveReader{live: live},
	}

	got, err := c.GetSandbox(context.Background(), "ns", "alive")
	if err != nil {
		t.Fatalf("GetSandbox: %v", err)
	}
	if got.Name != "alive" {
		t.Fatalf("got %q, want alive", got.Name)
	}
}
