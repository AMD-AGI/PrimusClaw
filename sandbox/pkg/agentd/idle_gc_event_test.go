// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Does a reclaim say anything where a person will find it?
//
// idle-gc has always written an audit event, but only to the audit store. On a
// cluster where nothing ingests that, `kubectl describe sandbox` and every
// dashboard built on Events show nothing at all, so a sandbox deleted while its
// work was still running looks exactly like one that was never created. Working
// out that a single pod had been reclaimed for idleness -- and what window it
// missed by -- took reading a 120-hour control-plane log, and only one of the
// four cases under investigation still had the line.

package agentd

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

// recordingReconciler is the idle-gc reconciler with a buffered fake recorder.
func recordingReconciler(t *testing.T) (*SandboxReconciler, *record.FakeRecorder) {
	t.Helper()
	st := store.NewMemoryStore()
	r := idleGCReconciler(t, st, sandboxCR(testSession))
	rec := record.NewFakeRecorder(8)
	r.Recorder = rec
	seedSession(t, st, testSession, 30*time.Minute)
	return r, rec
}

func drain(rec *record.FakeRecorder) []string {
	var out []string
	for {
		select {
		case e := <-rec.Events:
			out = append(out, e)
		default:
			return out
		}
	}
}

func TestIdleReclaimIsVisibleAsAnEvent(t *testing.T) {
	r, rec := recordingReconciler(t)

	reconcile(t, r)

	events := drain(rec)
	if len(events) != 1 {
		t.Fatalf("want exactly one Event for one reclaim, got %d: %v", len(events), events)
	}
	if !strings.Contains(events[0], "IdleReclaimed") {
		t.Errorf("the reason is what a watcher filters on; got %q", events[0])
	}
	// Normal, not Warning: reclaiming an idle sandbox is this controller doing
	// its job, and a Warning would put every routine reclaim in front of
	// whatever watches for Warnings.
	if !strings.Contains(events[0], "Normal") {
		t.Errorf("want a Normal event, got %q", events[0])
	}
}

func TestTheEventCarriesWhatMakesItActionable(t *testing.T) {
	r, rec := recordingReconciler(t)

	reconcile(t, r)

	got := drain(rec)[0]
	// Without these two the Event only restates the disappearance. With them it
	// answers the question actually being asked: was this pod idle, and by how
	// much did it miss.
	if !strings.Contains(got, "15m") {
		t.Errorf("the timeout it outran is missing from %q", got)
	}
	if !strings.Contains(got, "last activity") {
		t.Errorf("the last-activity stamp is missing from %q", got)
	}
}

func TestASandboxThatIsNotReclaimedSaysNothing(t *testing.T) {
	st := store.NewMemoryStore()
	r := idleGCReconciler(t, st, sandboxCR(testSession))
	rec := record.NewFakeRecorder(8)
	r.Recorder = rec
	// Well inside the window: this reconcile is a no-op.
	seedSession(t, st, testSession, time.Minute)

	reconcile(t, r)

	if events := drain(rec); len(events) != 0 {
		t.Errorf("an Event per reconcile would bury the one that matters; got %v", events)
	}
}

func TestAReclaimStillHappensWithoutARecorder(t *testing.T) {
	// Nil is the deployment that has not wired one. The reclaim is the
	// controller's job; the Event is commentary on it.
	st := store.NewMemoryStore()
	r := idleGCReconciler(t, st, sandboxCR(testSession))
	seedSession(t, st, testSession, 30*time.Minute)

	reconcile(t, r)

	if sandboxExists(t, r) {
		t.Error("a missing Recorder must not stop the reclaim")
	}
}

func TestNoEventWhenTheDeleteIsRefused(t *testing.T) {
	// An Event is what an operator trusts. One saying a sandbox was reclaimed
	// while it is still there -- RBAC, an admission webhook, a flaky API call --
	// sends them looking for a pod that never went anywhere.
	scheme := k8sruntime.NewScheme()
	utilruntime.Must(sandboxv1alpha1.AddToScheme(scheme))
	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(sandboxCR(testSession)).
		WithInterceptorFuncs(interceptor.Funcs{
			Delete: func(context.Context, ctrlclient.WithWatch, ctrlclient.Object, ...ctrlclient.DeleteOption) error {
				return errors.New("forbidden")
			},
		}).Build()
	st := store.NewMemoryStore()
	rec := record.NewFakeRecorder(8)
	r := &SandboxReconciler{
		Client: c, Scheme: scheme, SessionTimeout: 15 * time.Minute,
		Store: st, Recorder: rec, startedAt: time.Now().Add(-72 * time.Hour),
	}
	seedSession(t, st, testSession, 30*time.Minute)

	_, err := r.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: testSandbox, Namespace: testNamespace},
	})
	if err == nil {
		t.Fatal("a refused delete should surface as an error, not be swallowed")
	}
	if events := drain(rec); len(events) != 0 {
		t.Errorf("the sandbox is still there; got %v", events)
	}
}

func TestNoEventWhenSomethingElseDeletedItFirst(t *testing.T) {
	// A user deleting their own sandbox, or another controller tearing it down,
	// races this reconcile and wins. The delete comes back NotFound, which is a
	// fine outcome -- the sandbox is gone -- but filing it as IdleReclaimed
	// attributes their action to the idle collector and counts it against a
	// timeout that had nothing to do with it.
	scheme := k8sruntime.NewScheme()
	utilruntime.Must(sandboxv1alpha1.AddToScheme(scheme))
	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(sandboxCR(testSession)).
		WithInterceptorFuncs(interceptor.Funcs{
			Delete: func(context.Context, ctrlclient.WithWatch, ctrlclient.Object, ...ctrlclient.DeleteOption) error {
				return apierrors.NewNotFound(
					schema.GroupResource{
						Group:    sandboxv1alpha1.GroupVersion.Group,
						Resource: "sandboxes",
					}, testSandbox)
			},
		}).Build()
	st := store.NewMemoryStore()
	rec := record.NewFakeRecorder(8)
	r := &SandboxReconciler{
		Client: c, Scheme: scheme, SessionTimeout: 15 * time.Minute,
		Store: st, Recorder: rec, startedAt: time.Now().Add(-72 * time.Hour),
	}
	seedSession(t, st, testSession, 30*time.Minute)

	if _, err := r.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: testSandbox, Namespace: testNamespace},
	}); err != nil {
		t.Fatalf("a NotFound on delete is not an error: %v", err)
	}
	if events := drain(rec); len(events) != 0 {
		t.Errorf("somebody else's teardown, filed as ours; got %v", events)
	}
}

func TestATerminatingSandboxIsLeftAlone(t *testing.T) {
	// Something already asked for it to go. Re-issuing the delete changes
	// nothing, and claiming the reclaim takes credit for a decision made
	// elsewhere.
	scheme := k8sruntime.NewScheme()
	utilruntime.Must(sandboxv1alpha1.AddToScheme(scheme))
	sb := sandboxCR(testSession)
	now := metav1.NewTime(time.Now())
	sb.DeletionTimestamp = &now
	sb.Finalizers = []string{"test/hold"}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(sb).Build()
	st := store.NewMemoryStore()
	rec := record.NewFakeRecorder(8)
	r := &SandboxReconciler{
		Client: c, Scheme: scheme, SessionTimeout: 15 * time.Minute,
		Store: st, Recorder: rec, startedAt: time.Now().Add(-72 * time.Hour),
	}
	seedSession(t, st, testSession, 30*time.Minute)

	if _, err := r.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: testSandbox, Namespace: testNamespace},
	}); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if events := drain(rec); len(events) != 0 {
		t.Errorf("it was already going; got %v", events)
	}
}

func TestTheDeleteIsBoundToTheObjectItDecidedAbout(t *testing.T) {
	// The same session coming straight back gets a new sandbox under the same
	// name. Between this reconcile's read and its delete, that replacement is
	// what the name now points at -- and it is by definition not idle. Without a
	// precondition the delete lands on it anyway, and the Event says it was
	// reclaimed for being idle.
	scheme := k8sruntime.NewScheme()
	utilruntime.Must(sandboxv1alpha1.AddToScheme(scheme))
	var gotPreconditionUID bool
	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(sandboxCR(testSession)).
		WithInterceptorFuncs(interceptor.Funcs{
			Delete: func(_ context.Context, _ ctrlclient.WithWatch, _ ctrlclient.Object,
				opts ...ctrlclient.DeleteOption) error {
				for _, o := range opts {
					if p, ok := o.(ctrlclient.Preconditions); ok && p.UID != nil {
						gotPreconditionUID = true
					}
				}
				// What the API server does when the UID no longer matches.
				return apierrors.NewConflict(
					schema.GroupResource{
						Group:    sandboxv1alpha1.GroupVersion.Group,
						Resource: "sandboxes",
					}, testSandbox, errors.New("UID precondition failed"))
			},
		}).Build()
	st := store.NewMemoryStore()
	rec := record.NewFakeRecorder(8)
	r := &SandboxReconciler{
		Client: c, Scheme: scheme, SessionTimeout: 15 * time.Minute,
		Store: st, Recorder: rec, startedAt: time.Now().Add(-72 * time.Hour),
	}
	seedSession(t, st, testSession, 30*time.Minute)

	_, err := r.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: testSandbox, Namespace: testNamespace},
	})

	if !gotPreconditionUID {
		t.Error("the delete named no UID, so it would land on whatever holds the name now")
	}
	if err == nil {
		t.Error("a refused delete should surface, not be read as a reclaim")
	}
	if events := drain(rec); len(events) != 0 {
		t.Errorf("nothing was reclaimed here; got %v", events)
	}
}
