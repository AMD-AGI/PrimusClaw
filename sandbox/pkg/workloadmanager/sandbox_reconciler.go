// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// SandboxReconciler watches Sandbox resources and notifies waiting HTTP handlers
// when a Sandbox reaches Running state (event-driven, replaces polling).
//
// When a Sandbox reaches Running it also backfills a missing session-id /
// ShutdownTime and ensures a SandboxPolicy CR exists. Existing session-id
// annotations (including legacy sess_*) are left in place for dual-read release.
package workloadmanager

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/api"
	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	log "sigs.k8s.io/agent-sandbox/pkg/logx"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

// SandboxStatusUpdate carries the updated Sandbox to a waiting handler.
type SandboxStatusUpdate struct {
	Sandbox *sandboxv1alpha1.Sandbox
}

// SandboxReconciler watches Sandbox objects and notifies registered watchers
// as soon as the Sandbox Pod transitions to Running.
//
// Store is optional and unused for routing (Sandbox CRs are the source of
// truth). It remains for tests that still assert on session-map cleanup.
type SandboxReconciler struct {
	client.Client
	Scheme *runtime.Scheme
	Store  store.Store

	// watchers maps NamespacedName → channel waiting for Running state.
	watchers map[types.NamespacedName]chan SandboxStatusUpdate
	mu       sync.RWMutex

	// sessionOf maps a Sandbox to its session id for deletion-side cleanup of
	// an optional Store. Recorded while the Sandbox exists because Reconcile
	// only receives a NamespacedName after the object is gone.
	sessionOf   map[types.NamespacedName]string
	sessionOfMu sync.Mutex
}

// Reconcile is called whenever a Sandbox resource changes.
// When the sandbox Pod is Running, it notifies waiters and backfills CR defaults.
func (r *SandboxReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	sandbox := &sandboxv1alpha1.Sandbox{}
	if err := r.Get(ctx, req.NamespacedName, sandbox); err != nil {
		if apierrors.IsNotFound(err) {
			// The Sandbox is gone. Deletions reach us here because the default
			// handler enqueues them too, and this is the only notification we
			// get for the routes that bypass the WM API entirely: an operator's
			// kubectl delete, the Sandbox controller expiring a ShutdownTime,
			// or a SandboxClaim reclaiming its Sandbox.
			return ctrl.Result{}, r.onSandboxDeleted(ctx, req.NamespacedName)
		}
		return ctrl.Result{}, err
	}

	if getSandboxPodPhase(sandbox) != "running" {
		return ctrl.Result{}, nil
	}

	log.V(2).Infof("SandboxReconciler: sandbox %s/%s is Running", sandbox.Namespace, sandbox.Name)

	// ── 1. Notify watcher (existing behavior) ────────────────────────────
	r.mu.Lock()
	ch, exists := r.watchers[req.NamespacedName]
	if exists {
		delete(r.watchers, req.NamespacedName)
	}
	r.mu.Unlock()

	if exists {
		select {
		case ch <- SandboxStatusUpdate{Sandbox: sandbox}:
			log.V(2).Infof("SandboxReconciler: notified waiter for %s/%s", sandbox.Namespace, sandbox.Name)
		default:
			log.Warnf("SandboxReconciler: channel full or no receiver for %s/%s", sandbox.Namespace, sandbox.Name)
		}
	}

	if err := r.ensureSessionRegistered(ctx, sandbox); err != nil {
		log.Warnf("SandboxReconciler: session defaults patch failed for %s/%s: %v",
			sandbox.Namespace, sandbox.Name, err)
	}

	return ctrl.Result{}, nil
}

// rememberSession records which session a live Sandbox carries, so a later
// deletion can be cleaned up by name alone.
//
// Called on every reconcile of a Running Sandbox rather than only on first
// registration: the map is process-local, so a restarted controller repopulates
// it from the initial informer sync instead of starting blind.
func (r *SandboxReconciler) rememberSession(key types.NamespacedName, sessionID string) {
	if sessionID == "" {
		return
	}
	r.sessionOfMu.Lock()
	defer r.sessionOfMu.Unlock()
	if r.sessionOf == nil {
		r.sessionOf = make(map[types.NamespacedName]string)
	}
	r.sessionOf[key] = sessionID
}

// peekSession reads the session recorded for a Sandbox without consuming it, so
// a cleanup that fails can be retried against the same recording.
func (r *SandboxReconciler) peekSession(key types.NamespacedName) string {
	r.sessionOfMu.Lock()
	defer r.sessionOfMu.Unlock()
	return r.sessionOf[key]
}

// forgetSession drops a recording once its cleanup has succeeded.
func (r *SandboxReconciler) forgetSession(key types.NamespacedName) {
	r.sessionOfMu.Lock()
	defer r.sessionOfMu.Unlock()
	delete(r.sessionOf, key)
}

// onSandboxDeleted drops in-process session bookkeeping for a vanished Sandbox.
// Routing reads CRs, so there is no external session map to clear; optional
// Store cleanup remains for tests that still use a MemoryStore.
func (r *SandboxReconciler) onSandboxDeleted(ctx context.Context, key types.NamespacedName) error {
	sessionID := r.peekSession(key)
	if sessionID == "" {
		return nil
	}
	if r.Store == nil {
		r.forgetSession(key)
		return nil
	}

	info, err := r.Store.GetSandboxBySessionID(ctx, sessionID)
	if errors.Is(err, store.ErrNotFound) {
		r.forgetSession(key)
		return nil
	}
	if err != nil {
		return fmt.Errorf("look up session %s of deleted sandbox %s: %w", sessionID, key, err)
	}
	if info == nil || info.SandboxName != key.Name || info.Namespace != key.Namespace {
		r.forgetSession(key)
		return nil
	}

	if err := r.Store.DeleteSandboxBySessionID(ctx, sessionID); err != nil {
		return fmt.Errorf("deregister session %s of deleted sandbox %s: %w", sessionID, key, err)
	}
	r.forgetSession(key)
	return nil
}

// ensureSessionRegistered backfills session-id and ShutdownTime on Sandbox CRs
// that omit them (e.g. kubectl apply). Egress policy lives on the SandboxPolicy
// CR, not on Sandbox annotations.
//
// Dual-read upgrade: new sandboxes get namespace/name. Existing annotations
// (including legacy sess_*) are preserved so Brain can still DELETE by the id
// it already holds.
func (r *SandboxReconciler) ensureSessionRegistered(ctx context.Context, sandbox *sandboxv1alpha1.Sandbox) error {
	canonicalID := api.FormatSandboxID(sandbox.Namespace, sandbox.Name)
	sessionID := ""
	if sandbox.Annotations != nil {
		sessionID = strings.TrimSpace(sandbox.Annotations[sessionIDAnnotationKey])
	}

	ownedByClaim := false
	for _, ref := range sandbox.OwnerReferences {
		if ref.Kind == "SandboxClaim" {
			ownedByClaim = true
			break
		}
	}

	needsPatch := false
	if sessionID == "" {
		sessionID = canonicalID
		needsPatch = true
		log.V(2).Infof("SandboxReconciler: binding sandbox id %s for %s/%s",
			sessionID, sandbox.Namespace, sandbox.Name)
	}

	r.rememberSession(types.NamespacedName{Namespace: sandbox.Namespace, Name: sandbox.Name}, sessionID)

	var defaultShutdown *metav1.Time
	if sandbox.Spec.Lifecycle.ShutdownTime == nil || sandbox.Spec.Lifecycle.ShutdownTime.IsZero() {
		st := shutdownTimeFromDuration(DefaultMaxSessionDuration)
		defaultShutdown = &st
		needsPatch = true
	}

	if needsPatch {
		base := sandbox.DeepCopy()
		if sandbox.Annotations == nil {
			sandbox.Annotations = make(map[string]string)
		}
		sandbox.Annotations[sessionIDAnnotationKey] = sessionID
		if defaultShutdown != nil {
			sandbox.Spec.Lifecycle.ShutdownTime = defaultShutdown
		}
		patch := client.MergeFromWithOptions(base, client.MergeFromWithOptimisticLock{})
		if err := r.Patch(ctx, sandbox, patch); err != nil {
			// Conflict: requeue via error so the next reconcile retries.
			return fmt.Errorf("patch sandbox defaults: %w", err)
		}
		log.V(2).Infof("SandboxReconciler: patched defaults onto %s/%s (session=%s, shutdown=%v)",
			sandbox.Namespace, sandbox.Name, sessionID, defaultShutdown)
	}

	// Claim path writes SandboxPolicy at claim time. kubectl-applied sandboxes
	// get a default policy CR here.
	if !ownedByClaim {
		if err := r.ensureDefaultSandboxPolicy(ctx, sandbox); err != nil {
			return err
		}
	}

	// Optional MemoryStore mirror for tests / local-dev without a CR reader.
	// Production CRStore.StoreSandbox is a no-op.
	if r.Store == nil {
		return nil
	}
	podAddr, err := r.resolveSandboxAddress(sandbox)
	if err != nil {
		return nil
	}
	kind := store.SandboxKind
	if ownedByClaim {
		kind = store.SandboxClaimKind
	}
	expiresAt := time.Now().Add(DefaultMaxSessionDuration)
	if sandbox.Spec.Lifecycle.ShutdownTime != nil && !sandbox.Spec.Lifecycle.ShutdownTime.IsZero() {
		expiresAt = sandbox.Spec.Lifecycle.ShutdownTime.Time
	}
	info := &store.SandboxInfo{
		Kind: kind, SessionID: sessionID, SandboxName: sandbox.Name, Namespace: sandbox.Namespace,
		PodIP: podAddr, PodPort: 8080,
		EntryPoints: map[string]string{"/": fmt.Sprintf("%s:%d", podAddr, 8080)},
		CreatedAt:   sandbox.CreationTimestamp.Time, LastActivity: time.Now(),
		ExpiresAt: expiresAt, Status: "running",
	}
	if sandbox.Labels != nil {
		info.UserID = sandbox.Labels[userIDLabelKey]
	}
	if sandbox.Annotations != nil {
		info.UserName = sandbox.Annotations[userNameAnnotationKey]
	}
	_ = r.Store.StoreSandbox(ctx, info)
	return nil
}

// ensureDefaultSandboxPolicy creates a SandboxPolicy CR when none exists.
func (r *SandboxReconciler) ensureDefaultSandboxPolicy(ctx context.Context, sandbox *sandboxv1alpha1.Sandbox) error {
	key := types.NamespacedName{Namespace: sandbox.Namespace, Name: sandbox.Name}
	existing := &runtimev1alpha1.SandboxPolicy{}
	if err := r.Get(ctx, key, existing); err == nil {
		return nil
	} else if !apierrors.IsNotFound(err) {
		return fmt.Errorf("get SandboxPolicy: %w", err)
	}
	obj := &runtimev1alpha1.SandboxPolicy{
		ObjectMeta: metav1.ObjectMeta{
			Name:      sandbox.Name,
			Namespace: sandbox.Namespace,
		},
		Spec: policyToSpec(defaultSandboxPolicy()),
	}
	if r.Scheme != nil {
		if err := controllerutil.SetControllerReference(sandbox, obj, r.Scheme); err != nil {
			return fmt.Errorf("set SandboxPolicy owner: %w", err)
		}
	}
	if err := r.Create(ctx, obj); err != nil && !apierrors.IsAlreadyExists(err) {
		return fmt.Errorf("create SandboxPolicy: %w", err)
	}
	return nil
}

// resolveSandboxAddress returns the best available address for the Sandbox.
func (r *SandboxReconciler) resolveSandboxAddress(sandbox *sandboxv1alpha1.Sandbox) (string, error) {
	if sandbox.Status.ServiceFQDN != "" {
		return sandbox.Status.ServiceFQDN, nil
	}
	if sandbox.Status.Service != "" {
		return fmt.Sprintf("%s.%s.svc.cluster.local", sandbox.Status.Service, sandbox.Namespace), nil
	}
	return "", fmt.Errorf("sandbox %s/%s has no ServiceFQDN or Service in status", sandbox.Namespace, sandbox.Name)
}

// WatchSandboxOnce registers a one-time watcher for the given sandbox.
// Returns a channel that will receive exactly one SandboxStatusUpdate when the
// sandbox reaches Running state. The channel is buffered (size 1).
func (r *SandboxReconciler) WatchSandboxOnce(_ context.Context, namespace, name string) <-chan SandboxStatusUpdate {
	ch := make(chan SandboxStatusUpdate, 1)
	key := types.NamespacedName{Namespace: namespace, Name: name}

	r.mu.Lock()
	defer r.mu.Unlock()
	if r.watchers == nil {
		r.watchers = make(map[types.NamespacedName]chan SandboxStatusUpdate)
	}
	r.watchers[key] = ch
	log.V(2).Infof("SandboxReconciler: registered watcher for %s/%s", namespace, name)
	return ch
}

// UnWatchSandbox removes a watcher (used on timeout / cancellation).
func (r *SandboxReconciler) UnWatchSandbox(namespace, name string) {
	key := types.NamespacedName{Namespace: namespace, Name: name}
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.watchers, key)
}

// SetupWithManager registers the reconciler with the controller-runtime manager.
func (r *SandboxReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		Named("sandbox-session-controller").
		For(&sandboxv1alpha1.Sandbox{}).
		Complete(r)
}

// getSandboxPodPhase returns "running" when the Sandbox's Ready condition is True.
// The SandboxConditionReady condition is set by the agent-sandbox controller when
// all replicas are running and the Service is created.
func getSandboxPodPhase(sandbox *sandboxv1alpha1.Sandbox) string {
	for _, cond := range sandbox.Status.Conditions {
		if cond.Type == string(sandboxv1alpha1.SandboxConditionReady) && cond.Status == "True" {
			return "running"
		}
	}
	// Fallback: at least one replica running
	if sandbox.Status.Replicas > 0 && sandbox.Status.Service != "" {
		return "running"
	}
	return "pending"
}
