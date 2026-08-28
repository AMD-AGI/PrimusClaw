// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Does idle-gc leave the session mapping behind when it deletes a Sandbox?
//
// idle-gc deletes the Sandbox CR directly through the K8s client, never through
// the Workload Manager API, so none of WM's own store cleanup runs. The idle
// timeout is minutes while the session key's TTL tracks ExpiresAt (a day by
// default), which left the mapping pointing at a deleted Pod for up to that
// whole window: the Router kept resolving the session to a dead address and the
// health watcher kept reporting it as PodNotFound.

package agentd

import (
	"context"
	"errors"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

const (
	testNamespace = "sandboxes"
	testSandbox   = "sbx-1"
	testSession   = "sess-1"
)

// idleGCReconciler wires a reconciler against a fake cluster and an in-memory
// store, both seeded with the same sandbox.
func idleGCReconciler(t *testing.T, st store.Store, objs ...ctrlclient.Object) *SandboxReconciler {
	t.Helper()
	scheme := k8sruntime.NewScheme()
	utilruntime.Must(sandboxv1alpha1.AddToScheme(scheme))
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(objs...).Build()
	return &SandboxReconciler{
		Client:         c,
		Scheme:         scheme,
		SessionTimeout: 15 * time.Minute,
		Store:          st,
		// Set here because SetupWithManager, which fills it in production, is not
		// part of these tests. Long ago, so the default is an established
		// controller: tests about a fresh start say so by overriding it.
		startedAt: time.Now().Add(-72 * time.Hour),
	}
}

// sandboxCR builds a Sandbox carrying the session-id annotation idle-gc reads.
func sandboxCR(sessionID string) *sandboxv1alpha1.Sandbox {
	return &sandboxv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{
			Name:              testSandbox,
			Namespace:         testNamespace,
			CreationTimestamp: metav1.NewTime(time.Now().Add(-time.Hour)),
			Annotations:       map[string]string{sessionIDAnnotation: sessionID},
		},
	}
}

// seedSession registers the session mapping with the given idle age.
func seedSession(t *testing.T, st store.Store, sessionID string, idleFor time.Duration) {
	t.Helper()
	if err := st.StoreSandbox(context.Background(), &store.SandboxInfo{
		Kind:         store.SandboxKind,
		SessionID:    sessionID,
		SandboxName:  testSandbox,
		Namespace:    testNamespace,
		CreatedAt:    time.Now().Add(-time.Hour),
		LastActivity: time.Now().Add(-idleFor),
		// Tracks the session TTL, which is exactly why the mapping used to
		// outlive an idle-gc deletion: it is nowhere near expiry.
		ExpiresAt: time.Now().Add(24 * time.Hour),
	}); err != nil {
		t.Fatalf("seed session: %v", err)
	}
}

func reconcile(t *testing.T, r *SandboxReconciler) ctrl.Result {
	t.Helper()
	res, err := r.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: testSandbox, Namespace: testNamespace},
	})
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	return res
}

func sessionExists(t *testing.T, st store.Store, sessionID string) bool {
	t.Helper()
	info, err := st.GetSandboxBySessionID(context.Background(), sessionID)
	return err == nil && info != nil
}

func sandboxExists(t *testing.T, r *SandboxReconciler) bool {
	t.Helper()
	err := r.Get(context.Background(), types.NamespacedName{
		Name: testSandbox, Namespace: testNamespace,
	}, &sandboxv1alpha1.Sandbox{})
	return err == nil
}

func TestIdleGCDropsSessionMappingWithTheSandbox(t *testing.T) {
	st := store.NewMemoryStore()
	seedSession(t, st, testSession, time.Hour) // idle well past the 15m timeout
	r := idleGCReconciler(t, st, sandboxCR(testSession))

	reconcile(t, r)

	if sandboxExists(t, r) {
		t.Error("an idle sandbox must be deleted")
	}
	if sessionExists(t, st, testSession) {
		t.Error("the session mapping must not outlive the sandbox it points at")
	}
}

func TestIdleGCKeepsBothForAnActiveSandbox(t *testing.T) {
	st := store.NewMemoryStore()
	seedSession(t, st, testSession, time.Minute) // well inside the timeout
	r := idleGCReconciler(t, st, sandboxCR(testSession))

	res := reconcile(t, r)

	if !sandboxExists(t, r) {
		t.Error("an active sandbox must be kept")
	}
	if !sessionExists(t, st, testSession) {
		t.Error("an active session's mapping must be kept")
	}
	if res.RequeueAfter <= 0 {
		t.Error("an active sandbox must be requeued for its next expiry check")
	}
}

// TestIdleGCWithoutAStoreDeletesTheSandbox keeps the K8s-only mode working:
// with no store to reconcile against, activity falls back to the annotation
// and deregistration is simply skipped.
func TestIdleGCWithoutAStoreDeletesTheSandbox(t *testing.T) {
	sbx := sandboxCR(testSession)
	sbx.Annotations[LastActivityAnnotation] = time.Now().Add(-time.Hour).Format(time.RFC3339)
	r := idleGCReconciler(t, nil, sbx)

	reconcile(t, r)

	if sandboxExists(t, r) {
		t.Error("an idle sandbox must be deleted even with no store configured")
	}
}

// TestIdleGCSurvivesASandboxWithNoSessionID covers CRs created by hand: there
// is no mapping to drop, and the deletion must still happen.
func TestIdleGCSurvivesASandboxWithNoSessionID(t *testing.T) {
	sbx := sandboxCR("")
	sbx.Annotations = map[string]string{
		LastActivityAnnotation: time.Now().Add(-time.Hour).Format(time.RFC3339),
	}
	r := idleGCReconciler(t, store.NewMemoryStore(), sbx)

	reconcile(t, r)

	if sandboxExists(t, r) {
		t.Error("a sandbox with no session-id must still be reclaimed when idle")
	}
}

// lookupFailingStore fails the session lookup with something that is not
// ErrNotFound, standing in for a Store that cannot be reached rather than one
// that has nothing to say.
type lookupFailingStore struct {
	store.Store
	err error
}

func (l *lookupFailingStore) GetSandboxBySessionID(
	_ context.Context, _ string,
) (*store.SandboxInfo, error) {
	return nil, l.err
}

// TestIdleGCDefersWhenActivityCannotBeRead pins the one thing an unreadable
// store must not cause: a deletion.
//
// Idleness is a claim about activity, and a store that cannot answer supports no
// such claim. Falling back to the creation timestamp -- which is what this used
// to do -- turns a Redis blip into the reclamation of every sandbox older than
// the idle timeout, however busy they are. Deletion is irreversible and the
// judgement can wait, so the reconcile requeues instead.
func TestIdleGCDefersWhenActivityCannotBeRead(t *testing.T) {
	base := store.NewMemoryStore()
	seedSession(t, base, testSession, time.Hour) // idle well past the 15m timeout
	st := &lookupFailingStore{Store: base, err: errors.New("redis: connection refused")}
	r := idleGCReconciler(t, st, sandboxCR(testSession))

	res := reconcile(t, r)

	if !sandboxExists(t, r) {
		t.Error("a sandbox must not be deleted on an activity time nobody could read")
	}
	if res.RequeueAfter <= 0 {
		t.Error("the judgement must be retried, or an outage silently stops reclamation for good")
	}
	if !sessionExists(t, base, testSession) {
		t.Error("a mapping that could not be read must not be deleted on a guess")
	}
}

// TestIdleGCSparesAReusedSession pins the ownership check. The session id comes
// from an annotation the caller sets, so a later Sandbox can hold the same one;
// dropping its mapping would 404 a sandbox that is alive.
func TestIdleGCSparesAReusedSession(t *testing.T) {
	st := store.NewMemoryStore()
	seedSession(t, st, testSession, time.Hour)
	// The mapping now points at a different sandbox under the same session id.
	if err := st.StoreSandbox(context.Background(), &store.SandboxInfo{
		Kind:         store.SandboxKind,
		SessionID:    testSession,
		SandboxName:  "a-newer-sandbox",
		Namespace:    testNamespace,
		LastActivity: time.Now().Add(-time.Hour),
		ExpiresAt:    time.Now().Add(24 * time.Hour),
	}); err != nil {
		t.Fatalf("seed the newer sandbox: %v", err)
	}
	r := idleGCReconciler(t, st, sandboxCR(testSession))

	reconcile(t, r)

	if sandboxExists(t, r) {
		t.Error("the idle sandbox must still be deleted")
	}
	if !sessionExists(t, st, testSession) {
		t.Error("a mapping that points at another sandbox must be left alone")
	}
}
