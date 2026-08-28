// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Does a deleted Sandbox take its session mapping with it?
//
// Most routes that remove a Sandbox never touch the WM API, so none of its own
// store cleanup runs: an operator's kubectl delete, the Sandbox controller
// expiring a ShutdownTime, a SandboxClaim reclaiming its Sandbox. The mapping
// then outlived the Pod until the key's own TTL expired — up to a day — and in
// the meantime the Router kept resolving the session to a dead address and the
// health watcher reported it as PodNotFound on every 30s scan.
//
// This controller already watches Sandbox and is already the thing that
// registers sessions, so it is where the deregistration belongs. The catch is
// that Reconcile only gets a name: the object carrying the session-id
// annotation is gone by then, which is why the pairing is recorded while the
// Sandbox is still alive.

package workloadmanager

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
	delTestNS      = "sandboxes"
	delTestSandbox = "sbx-1"
	delTestSession = "sess-1"
)

func delTestKey() types.NamespacedName {
	return types.NamespacedName{Namespace: delTestNS, Name: delTestSandbox}
}

func deleteTestReconciler(t *testing.T, st store.Store, objs ...ctrlclient.Object) *SandboxReconciler {
	t.Helper()
	scheme := k8sruntime.NewScheme()
	utilruntime.Must(sandboxv1alpha1.AddToScheme(scheme))
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(objs...).Build()
	return &SandboxReconciler{Client: c, Scheme: scheme, Store: st}
}

// runningSandbox builds a Sandbox the reconciler will treat as Running, so it
// reaches the session-registration path.
func runningSandbox(sessionID string) *sandboxv1alpha1.Sandbox {
	shutdown := metav1.NewTime(time.Now().Add(24 * time.Hour))
	return &sandboxv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{
			Name:        delTestSandbox,
			Namespace:   delTestNS,
			Annotations: map[string]string{sessionIDAnnotationKey: sessionID},
		},
		Spec: sandboxv1alpha1.SandboxSpec{
			Lifecycle: sandboxv1alpha1.Lifecycle{ShutdownTime: &shutdown},
		},
		Status: sandboxv1alpha1.SandboxStatus{
			Replicas: 1,
			Service:  "svc",
			Conditions: []metav1.Condition{{
				Type:               string(sandboxv1alpha1.SandboxConditionReady),
				Status:             metav1.ConditionTrue,
				Reason:             "DependenciesReady",
				LastTransitionTime: metav1.Now(),
			}},
		},
	}
}

func reconcileDelTest(t *testing.T, r *SandboxReconciler) {
	t.Helper()
	if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: delTestKey()}); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
}

func delTestSessionExists(t *testing.T, st store.Store, sessionID string) bool {
	t.Helper()
	info, err := st.GetSandboxBySessionID(context.Background(), sessionID)
	return err == nil && info != nil
}

func TestDeletedSandboxDeregistersItsSession(t *testing.T) {
	st := store.NewMemoryStore()
	r := deleteTestReconciler(t, st, runningSandbox(delTestSession))

	// The Sandbox reaches Running: the session is registered and the pairing
	// recorded.
	reconcileDelTest(t, r)
	if !delTestSessionExists(t, st, delTestSession) {
		t.Fatal("a Running sandbox must register its session")
	}

	// Something outside the WM API removes the CR — kubectl, ShutdownTime
	// expiry, claim reclaim. The controller sees only the follow-up reconcile.
	if err := r.Delete(context.Background(), runningSandbox(delTestSession)); err != nil {
		t.Fatalf("delete sandbox: %v", err)
	}
	reconcileDelTest(t, r)

	if delTestSessionExists(t, st, delTestSession) {
		t.Error("a deleted sandbox must take its session mapping with it")
	}
}

// TestDeregistrationDoesNotLeakRecordings pins that the bookkeeping is popped,
// not just read — it is process-local state that would otherwise grow for the
// lifetime of the controller.
func TestDeregistrationDoesNotLeakRecordings(t *testing.T) {
	st := store.NewMemoryStore()
	r := deleteTestReconciler(t, st, runningSandbox(delTestSession))

	reconcileDelTest(t, r)
	if got := r.peekSession(delTestKey()); got != delTestSession {
		t.Fatalf("expected the live sandbox to be recorded, got %q", got)
	}

	if err := r.Delete(context.Background(), runningSandbox(delTestSession)); err != nil {
		t.Fatalf("delete sandbox: %v", err)
	}
	reconcileDelTest(t, r)

	if got := r.peekSession(delTestKey()); got != "" {
		t.Errorf("expected the recording to be dropped, got %q", got)
	}
}

// TestUnknownSandboxDeletionTouchesNothing guards the blind cases: a Sandbox
// deleted before it ever registered, or one this replica never observed. With
// no recorded session there is nothing to identify, and guessing would risk
// dropping a live session's mapping.
func TestUnknownSandboxDeletionTouchesNothing(t *testing.T) {
	st := store.NewMemoryStore()
	if err := st.StoreSandbox(context.Background(), &store.SandboxInfo{
		Kind:        store.SandboxKind,
		SessionID:   "someone-elses-session",
		SandboxName: delTestSandbox,
		Namespace:   delTestNS,
		ExpiresAt:   time.Now().Add(24 * time.Hour),
	}); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	r := deleteTestReconciler(t, st) // no Sandbox in the cluster, nothing recorded

	reconcileDelTest(t, r)

	if !delTestSessionExists(t, st, "someone-elses-session") {
		t.Error("an unrecorded deletion must not delete mappings by guesswork")
	}
}

// TestDeletionWithoutAStoreIsInert keeps dev mode (no Redis) working.
func TestDeletionWithoutAStoreIsInert(t *testing.T) {
	r := deleteTestReconciler(t, nil)
	reconcileDelTest(t, r) // must not panic on a nil Store
}

// flakyStore fails deletes until healed, standing in for a Redis blip.
type flakyStore struct {
	store.Store
	deleteErr error
	deletes   int
}

func (f *flakyStore) DeleteSandboxBySessionID(ctx context.Context, sessionID string) error {
	f.deletes++
	if f.deleteErr != nil {
		return f.deleteErr
	}
	return f.Store.DeleteSandboxBySessionID(ctx, sessionID)
}

// TestFailedDeregistrationIsRetriedNotDropped covers the one notification
// problem: the deletion event never comes again, so a Store failure has to
// surface as a reconcile error (which the controller retries with backoff) and
// the recording has to survive for that retry to have anything to work with.
// Consuming it eagerly would silently fall back to the key's own TTL.
func TestFailedDeregistrationIsRetriedNotDropped(t *testing.T) {
	base := store.NewMemoryStore()
	st := &flakyStore{Store: base, deleteErr: errors.New("redis: connection refused")}
	r := deleteTestReconciler(t, st, runningSandbox(delTestSession))

	reconcileDelTest(t, r)
	if err := r.Delete(context.Background(), runningSandbox(delTestSession)); err != nil {
		t.Fatalf("delete sandbox: %v", err)
	}

	_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: delTestKey()})
	if err == nil {
		t.Error("a Store failure must surface so the controller retries it")
	}
	if r.peekSession(delTestKey()) != delTestSession {
		t.Fatal("the recording must survive a failed cleanup so the retry can use it")
	}
	if !delTestSessionExists(t, base, delTestSession) {
		t.Fatal("nothing should have been removed yet")
	}

	// Redis comes back; the retried reconcile finishes the job.
	st.deleteErr = nil
	reconcileDelTest(t, r)

	if delTestSessionExists(t, base, delTestSession) {
		t.Error("the retry must deregister the session")
	}
	if r.peekSession(delTestKey()) != "" {
		t.Error("a succeeded cleanup must drop its recording")
	}
}

// TestDeregistrationSparesAReusedSession is the reason the ownership check
// exists. Session ids come from an annotation a caller can set, and the retry
// window spans minutes, so a newer Sandbox can register the same id while the
// old one's cleanup is still backing off. Deleting then would 404 a live
// sandbox until its next reconcile.
func TestDeregistrationSparesAReusedSession(t *testing.T) {
	base := store.NewMemoryStore()
	st := &flakyStore{Store: base, deleteErr: errors.New("redis: down")}
	r := deleteTestReconciler(t, st, runningSandbox(delTestSession))

	reconcileDelTest(t, r)
	if err := r.Delete(context.Background(), runningSandbox(delTestSession)); err != nil {
		t.Fatalf("delete sandbox: %v", err)
	}
	if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: delTestKey()}); err == nil {
		t.Fatal("expected the first attempt to fail")
	}

	// While the retry backs off, a different Sandbox claims the same session id.
	if err := base.StoreSandbox(context.Background(), &store.SandboxInfo{
		Kind:        store.SandboxKind,
		SessionID:   delTestSession,
		SandboxName: "a-newer-sandbox",
		Namespace:   delTestNS,
		ExpiresAt:   time.Now().Add(24 * time.Hour),
	}); err != nil {
		t.Fatalf("re-register session: %v", err)
	}
	st.deleteErr = nil
	deletesBefore := st.deletes

	reconcileDelTest(t, r)

	if !delTestSessionExists(t, base, delTestSession) {
		t.Error("a mapping owned by another sandbox must survive")
	}
	if st.deletes != deletesBefore {
		t.Error("no delete should even be attempted once ownership no longer matches")
	}
	if r.peekSession(delTestKey()) != "" {
		t.Error("the stale recording must still be dropped")
	}
}
