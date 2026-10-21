// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package controllers

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/audit"
)

// fakeAuditStore is an in-memory audit.AuditStore for unit tests that only
// need to observe which events Store was called with -- the L639 gap this
// package closes is "was Store ever called at all", which the real Redis
// round trip (pkg/audit's own tests) already covers end to end.
type fakeAuditStore struct {
	mu      sync.Mutex
	events  []*audit.AuditEvent
	failAll bool
}

func (f *fakeAuditStore) Store(ctx context.Context, event *audit.AuditEvent) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failAll {
		return context.DeadlineExceeded
	}
	f.events = append(f.events, event)
	return nil
}

func (f *fakeAuditStore) QueryBySession(ctx context.Context, sessionID string) ([]*audit.AuditEvent, error) {
	return nil, nil
}

func (f *fakeAuditStore) QueryByTimeRange(ctx context.Context, start, end time.Time, opts audit.QueryOptions) (*audit.QueryResult, error) {
	return nil, nil
}

func (f *fakeAuditStore) DeleteBefore(ctx context.Context, before time.Time) (int64, error) {
	return 0, nil
}

func (f *fakeAuditStore) stored() []*audit.AuditEvent {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]*audit.AuditEvent, len(f.events))
	copy(out, f.events)
	return out
}

// TestEmitUnaccountedDeleteAudit_Fires covers the L639 shape directly: a
// Sandbox disappears via a path that never called into any of this
// package's own audit-emitting code (no user-delete, no GC-TTL, no
// shutdown-expiry). Reconcile observing DeletionTimestamp set must still
// leave one sandbox.deleted/external record behind instead of the silence
// L639 found.
func TestEmitUnaccountedDeleteAudit_Fires(t *testing.T) {
	store := &fakeAuditStore{}
	r := &SandboxReconciler{Audit: store}

	sandbox := &sandboxv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "sb-1",
			Namespace: "default",
		},
	}
	fc := newFakeClient(sandbox)
	r.Client = fc

	r.emitUnaccountedDeleteAudit(context.Background(), sandbox)

	events := store.stored()
	require.Len(t, events, 1)
	require.Equal(t, audit.EventDeleted, events[0].EventType)
	require.Equal(t, audit.ReasonExternal, events[0].DeleteReason)

	// Idempotency marker must be left behind so a second observation (the
	// controller commonly reconciles a terminating object more than once
	// before it is actually gone) does not emit a duplicate event.
	require.Equal(t, "true", sandbox.Annotations[audit.AnnDeleteAuditIssued])
}

// TestEmitUnaccountedDeleteAudit_SkipsWhenAlreadyIssued is the
// de-duplication half: a deletion already accounted for by one of the
// three pre-existing paths (shutdown-expiry here; user-delete and GC-TTL
// are exercised the same way via markDeleteAuditIssued in
// pkg/workloadmanager/k8s_builder.go) must not also get a second,
// misleadingly-labelled external event.
func TestEmitUnaccountedDeleteAudit_SkipsWhenAlreadyIssued(t *testing.T) {
	store := &fakeAuditStore{}
	r := &SandboxReconciler{Audit: store}

	sandbox := &sandboxv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "sb-2",
			Namespace: "default",
			Annotations: map[string]string{
				audit.AnnDeleteAuditIssued: "true",
			},
		},
	}
	fc := newFakeClient(sandbox)
	r.Client = fc

	r.emitUnaccountedDeleteAudit(context.Background(), sandbox)

	require.Empty(t, store.stored())
}

// TestEmitUnaccountedDeleteAudit_SkipsOnShutdownExpiryMarker covers the
// older, shutdown-expiry-only annotation directly, in case a Sandbox
// mid-rollout carries that marker but not the newer shared one yet.
func TestEmitUnaccountedDeleteAudit_SkipsOnShutdownExpiryMarker(t *testing.T) {
	store := &fakeAuditStore{}
	r := &SandboxReconciler{Audit: store}

	sandbox := &sandboxv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "sb-3",
			Namespace: "default",
			Annotations: map[string]string{
				annShutdownExpiryAuditIssued: "true",
			},
		},
	}
	fc := newFakeClient(sandbox)
	r.Client = fc

	r.emitUnaccountedDeleteAudit(context.Background(), sandbox)

	require.Empty(t, store.stored())
}

// TestEmitUnaccountedDeleteAudit_NilStoreIsNoop confirms the audit path
// never panics or blocks reconciliation in a deployment where Audit is nil
// (store.NewFromEnv returned a non-Redis store, or AUDIT_ENABLED=false --
// see cmd/controlplane/main.go).
func TestEmitUnaccountedDeleteAudit_NilStoreIsNoop(t *testing.T) {
	r := &SandboxReconciler{}
	sandbox := &sandboxv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{Name: "sb-4", Namespace: "default"},
	}
	require.NotPanics(t, func() {
		r.emitUnaccountedDeleteAudit(context.Background(), sandbox)
	})
}

// TestEmitUnaccountedDeleteAudit_StoreFailureDoesNotPatch documents the
// fire-and-forget contract: a failed write (what L639 could never observe,
// since nothing surfaced it) must not be mistaken for success -- the
// idempotency annotation is only set once Store actually returns nil, and
// RedisAuditStore.Store's own audit_store_write_errors_total counter (see
// pkg/audit/redis_store.go) is what makes the failure itself visible.
func TestEmitUnaccountedDeleteAudit_StoreFailureDoesNotPatch(t *testing.T) {
	store := &fakeAuditStore{failAll: true}
	r := &SandboxReconciler{Audit: store}

	sandbox := &sandboxv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{Name: "sb-5", Namespace: "default"},
	}
	fc := newFakeClient(sandbox)
	r.Client = fc

	r.emitUnaccountedDeleteAudit(context.Background(), sandbox)

	require.Empty(t, store.stored())
	require.Empty(t, sandbox.Annotations[audit.AnnDeleteAuditIssued])
}
