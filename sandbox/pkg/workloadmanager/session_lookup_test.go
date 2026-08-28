// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Session recovery resolves a session id to its Sandbox. It runs on the keepalive
// path, which reaches it once per session per minute for as long as the store
// cannot answer, so how the lookup is served decides whether a store outage stays
// contained or becomes API server load. These tests pin that it prefers the index,
// that it still answers without one, and that an index reporting absence is taken
// at its word rather than re-asked the expensive way.
//
// Each builds its own client and shares no state, so they run in parallel.
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

	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
)

const lookupSession = "session-under-test"

func sandboxWithSession(name, sessionID string) *sandboxv1alpha1.Sandbox {
	return &sandboxv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{
			Name:        name,
			Namespace:   "default",
			Annotations: map[string]string{sessionIDAnnotationKey: sessionID},
		},
	}
}

func lookupScheme(t *testing.T) *k8sruntime.Scheme {
	t.Helper()
	scheme := k8sruntime.NewScheme()
	utilruntime.Must(sandboxv1alpha1.AddToScheme(scheme))
	return scheme
}

// indexedClient mirrors production: the same index the manager's cache carries.
func indexedClient(t *testing.T, objs ...ctrlclient.Object) ctrlclient.Client {
	t.Helper()
	return fake.NewClientBuilder().
		WithScheme(lookupScheme(t)).
		WithObjects(objs...).
		WithIndex(&sandboxv1alpha1.Sandbox{}, SessionIDIndexField, func(obj ctrlclient.Object) []string {
			if id := obj.(*sandboxv1alpha1.Sandbox).Annotations[sessionIDAnnotationKey]; id != "" {
				return []string{id}
			}
			return nil
		}).
		Build()
}

// countingLister records how often the fallback List ran, which is the cost the
// index exists to avoid.
type countingLister struct {
	ctrlclient.Client
	lists int
}

func (c *countingLister) List(ctx context.Context, list ctrlclient.ObjectList, opts ...ctrlclient.ListOption) error {
	c.lists++
	return c.Client.List(ctx, list, opts...)
}

func TestFindSandboxBySessionIDUsesTheIndex(t *testing.T) {
	t.Parallel()
	sb := sandboxWithSession("wanted", lookupSession)
	// The unindexed client would find it too, so this counts calls instead:
	// reaching it at all is the regression, not the answer it gives.
	fallback := &countingLister{Client: indexedClient(t, sb)}
	c := &K8sSandboxCreator{client: fallback, cachedReader: indexedClient(t, sb)}

	found, err := c.findSandboxBySessionID(context.Background(), lookupSession)
	if err != nil {
		t.Fatalf("findSandboxBySessionID: %v", err)
	}
	if found.Name != "wanted" {
		t.Errorf("found %q, want %q", found.Name, "wanted")
	}
	if fallback.lists != 0 {
		t.Errorf("listed %d times; an indexed lookup must resolve without listing", fallback.lists)
	}
}

// The cache lags deletion, and idle-gc deletes a Sandbox and drops its session
// mapping together. Recovering from a copy only the cache still holds would put
// that mapping back for the rest of its TTL, pointing at a Pod that is gone --
// which is what the deregistration exists to prevent. So a cache hit is a
// candidate, not an answer.
func TestFindSandboxBySessionIDRejectsACacheHitThatIsAlreadyGone(t *testing.T) {
	t.Parallel()
	deleted := sandboxWithSession("deleted", lookupSession)
	// Present in the cache, absent from the API server: the window after idle-gc
	// deletes and before the watch event lands.
	c := &K8sSandboxCreator{
		client:       indexedClient(t),
		cachedReader: indexedClient(t, deleted),
	}

	if _, err := c.findSandboxBySessionID(context.Background(), lookupSession); err == nil {
		t.Error("a sandbox the API server no longer has must not be recovered")
	}
}

// A Sandbox on its way out would answer with an address about to stop serving, and
// leave the mapping behind once it does.
func TestFindSandboxBySessionIDRejectsATerminatingSandbox(t *testing.T) {
	t.Parallel()
	now := metav1.Now()

	t.Run("via the index", func(t *testing.T) {
		t.Parallel()
		terminating := sandboxWithSession("terminating", lookupSession)
		terminating.DeletionTimestamp = &now
		terminating.Finalizers = []string{"test.agent-sandbox.io/hold"} // the API server requires one
		client := indexedClient(t, terminating)
		c := &K8sSandboxCreator{client: client, cachedReader: client}

		_, err := c.findSandboxBySessionID(context.Background(), lookupSession)
		if err == nil {
			t.Fatal("a terminating sandbox must not be recovered")
		}
		if !strings.Contains(err.Error(), "being deleted") {
			t.Errorf("error must say why, got %q", err)
		}
	})

	t.Run("via the fallback list", func(t *testing.T) {
		t.Parallel()
		terminating := sandboxWithSession("terminating", lookupSession)
		terminating.DeletionTimestamp = &now
		terminating.Finalizers = []string{"test.agent-sandbox.io/hold"}
		c := &K8sSandboxCreator{client: indexedClient(t, terminating)} // no cachedReader

		_, err := c.findSandboxBySessionID(context.Background(), lookupSession)
		if err == nil {
			t.Fatal("a terminating sandbox must not be recovered")
		}
		if !strings.Contains(err.Error(), "being deleted") {
			t.Errorf("error must say why, got %q", err)
		}
	})
}

// An index that answers "no such session" has answered. Listing would ask the
// same question at a much higher price, once per keepalive poll.
func TestFindSandboxBySessionIDTrustsAnIndexedMiss(t *testing.T) {
	t.Parallel()
	fallback := &countingLister{Client: indexedClient(t, sandboxWithSession("other", "another-session"))}
	c := &K8sSandboxCreator{client: fallback, cachedReader: indexedClient(t)}

	if _, err := c.findSandboxBySessionID(context.Background(), lookupSession); err == nil {
		t.Error("a session with no sandbox must not resolve")
	}
	if fallback.lists != 0 {
		t.Errorf("listed %d times; an indexed miss is an answer, not a reason to list", fallback.lists)
	}
}

// The cache is unavailable before it syncs, and absent altogether in a deployment
// wired without one. Falling back keeps the worst case at what this path did
// before the index existed.
func TestFindSandboxBySessionIDFallsBackWhenTheCacheCannotAnswer(t *testing.T) {
	t.Parallel()
	sb := sandboxWithSession("wanted", lookupSession)

	t.Run("reader errors", func(t *testing.T) {
		t.Parallel()
		c := &K8sSandboxCreator{
			client:       indexedClient(t, sb),
			cachedReader: failingReader{err: errors.New("the cache is not started")},
		}
		found, err := c.findSandboxBySessionID(context.Background(), lookupSession)
		if err != nil {
			t.Fatalf("findSandboxBySessionID: %v", err)
		}
		if found.Name != "wanted" {
			t.Errorf("found %q, want %q", found.Name, "wanted")
		}
	})

	t.Run("no reader", func(t *testing.T) {
		t.Parallel()
		c := &K8sSandboxCreator{client: indexedClient(t, sb)}
		found, err := c.findSandboxBySessionID(context.Background(), lookupSession)
		if err != nil {
			t.Fatalf("findSandboxBySessionID: %v", err)
		}
		if found.Name != "wanted" {
			t.Errorf("found %q, want %q", found.Name, "wanted")
		}
	})
}

// An index queried against a client that has none is the shape of a wiring
// mistake, and it must degrade to listing rather than report every session
// missing.
func TestFindSandboxBySessionIDFallsBackWithoutTheIndex(t *testing.T) {
	t.Parallel()
	sb := sandboxWithSession("wanted", lookupSession)
	unindexed := fake.NewClientBuilder().WithScheme(lookupScheme(t)).WithObjects(sb).Build()
	c := &K8sSandboxCreator{client: indexedClient(t, sb), cachedReader: unindexed}

	found, err := c.findSandboxBySessionID(context.Background(), lookupSession)
	if err != nil {
		t.Fatalf("findSandboxBySessionID: %v", err)
	}
	if found.Name != "wanted" {
		t.Errorf("found %q, want %q", found.Name, "wanted")
	}
}

type failingReader struct {
	err error
}

func (f failingReader) Get(context.Context, ctrlclient.ObjectKey, ctrlclient.Object, ...ctrlclient.GetOption) error {
	return f.err
}

func (f failingReader) List(context.Context, ctrlclient.ObjectList, ...ctrlclient.ListOption) error {
	return f.err
}
