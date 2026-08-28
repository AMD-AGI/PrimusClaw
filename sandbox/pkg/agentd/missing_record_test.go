// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Idleness is a claim about activity, so a store that has no record for a session
// supports no such claim. The remaining candidates -- the K8s annotation and the
// creation timestamp -- both predate whatever the store used to hold, which is why
// dating a sandbox from them reclaims a busy one the moment its record is lost.
//
// Declining is bounded rather than permanent, and by something that cannot fail the
// same way: Spec.ShutdownTime is an absolute deadline on the CR, enforced by
// sandbox-runtime-controller without consulting any store. These tests pin the
// decline, and that it lifts as soon as a record exists again.
package agentd

import (
	"context"
	"testing"
	"time"

	"sigs.k8s.io/agent-sandbox/pkg/store"
)

// recordLosingStore is reachable and answers, but has no record for the session --
// the shape a store left holding nothing produces, and distinct from one that
// cannot be reached at all.
type recordLosingStore struct {
	store.Store
}

func (s *recordLosingStore) GetSandboxBySessionID(context.Context, string) (*store.SandboxInfo, error) {
	return nil, store.ErrNotFound
}

// TestIdleGCDoesNotReclaimASandboxWithNoRecord is the protection this exists for.
// The sandbox is idle by every timestamp still available, and every one of them is
// older than the traffic the lost record described.
func TestIdleGCDoesNotReclaimASandboxWithNoRecord(t *testing.T) {
	r := idleGCReconciler(t, &recordLosingStore{Store: store.NewMemoryStore()}, sandboxCR(testSession))

	res := reconcile(t, r)

	if !sandboxExists(t, r) {
		t.Error("a sandbox whose record was lost must not be read as an idle one")
	}
	if res.RequeueAfter <= 0 {
		t.Error("it must be reconsidered, or a record written later is never noticed")
	}
}

// TestIdleGCResumesReclaimingOnceARecordExists is the other half: the decline is a
// response to missing evidence, not a permanent exemption. Without this, "never
// delete without a record" would quietly become "never delete".
func TestIdleGCResumesReclaimingOnceARecordExists(t *testing.T) {
	base := store.NewMemoryStore()
	r := idleGCReconciler(t, &recordLosingStore{Store: base}, sandboxCR(testSession))

	if reconcile(t, r); !sandboxExists(t, r) {
		t.Fatal("precondition: the sandbox should survive while no record exists")
	}

	// The record comes back, as the keepalive rebuild would put it back, and it
	// is old enough to be reclaimed on its own terms.
	seedSession(t, base, testSession, time.Hour)
	r.Store = base

	reconcile(t, r)

	if sandboxExists(t, r) {
		t.Error("an idle sandbox must be reclaimed again once a record vouches for it")
	}
	if sessionExists(t, base, testSession) {
		t.Error("the mapping must go with the sandbox")
	}
}

// TestIdleGCWithoutAStoreStillReclaims keeps the standalone K8s deployment working.
// With no store there is no record to be missing, so the annotation and creation
// time are the only evidence there ever was and remain sound.
func TestIdleGCWithoutAStoreStillReclaims(t *testing.T) {
	r := idleGCReconciler(t, nil, sandboxCR(testSession))

	reconcile(t, r)

	if sandboxExists(t, r) {
		t.Error("a store-less deployment must still reclaim idle sandboxes")
	}
}
