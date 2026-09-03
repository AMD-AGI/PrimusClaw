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
	"strings"
	"testing"
	"time"

	"k8s.io/client-go/tools/record"

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
