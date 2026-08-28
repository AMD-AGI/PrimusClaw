// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// SandboxReconciler watches Sandbox resources and notifies waiting HTTP handlers
// when a Sandbox reaches Running state (event-driven, replaces polling).
//
// Additionally, when a Sandbox reaches Running and carries a session-id annotation,
// the reconciler ensures the session is registered in Redis so that the Router can
// route requests immediately — even for Sandboxes created via kubectl apply rather
// than the standard POST /v1/code-interpreter API.
package workloadmanager

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/klog/v2"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

// SandboxStatusUpdate carries the updated Sandbox to a waiting handler.
type SandboxStatusUpdate struct {
	Sandbox *sandboxv1alpha1.Sandbox
}

// SandboxReconciler watches Sandbox objects and notifies registered watchers
// as soon as the Sandbox Pod transitions to Running.
//
// When Store is non-nil, it also auto-registers sessions into Redis for
// Sandboxes that carry the runtime.agent-sandbox.io/session-id annotation.
// If a Sandbox reaches Running without a session-id, one is generated and
// patched onto the Sandbox CR so that it can always be resolved via Router.
type SandboxReconciler struct {
	client.Client
	Scheme *runtime.Scheme
	Store  store.Store // nil in dev/test mode — session auto-register is skipped

	// watchers maps NamespacedName → channel waiting for Running state.
	watchers map[types.NamespacedName]chan SandboxStatusUpdate
	mu       sync.RWMutex

	// sessionOf maps a Sandbox to the session registered for it. Recorded while
	// the Sandbox exists because Reconcile only receives a NamespacedName, and
	// by the time a deletion is observed the object holding the session-id
	// annotation is already gone. Consumed and dropped by onSandboxDeleted.
	//
	// Steady-state size is one entry per live Sandbox, which the cluster bounds.
	// A controller that stops does not leak from this map, it loses the map --
	// entries cannot outlive the process holding them, and the initial informer
	// sync rebuilds the ones that still matter. The single path that does grow
	// without bound is a Store that stays unreachable: onSandboxDeleted keeps its
	// recording so the retry has something to work with, and the requeue backs off
	// but never gives up. Left unbounded even so, because evicting an entry means
	// abandoning the deregistration it exists to perform -- falling back to the
	// key's own TTL, which is the failure this map was added to prevent.
	sessionOf   map[types.NamespacedName]string
	sessionOfMu sync.Mutex
}

// Reconcile is called whenever a Sandbox resource changes.
// When the sandbox Pod is Running, it:
//  1. Notifies any registered watcher (existing behavior for API-created sandboxes).
//  2. Ensures a session mapping exists in Redis (new behavior for YAML-created sandboxes).
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

	klog.V(2).Infof("SandboxReconciler: sandbox %s/%s is Running", sandbox.Namespace, sandbox.Name)

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
			klog.V(2).Infof("SandboxReconciler: notified waiter for %s/%s", sandbox.Namespace, sandbox.Name)
		default:
			klog.Warningf("SandboxReconciler: channel full or no receiver for %s/%s", sandbox.Namespace, sandbox.Name)
		}
	}

	// ── 2. Auto-register session in Redis ────────────────────────────────
	if r.Store != nil {
		if err := r.ensureSessionRegistered(ctx, sandbox); err != nil {
			klog.Warningf("SandboxReconciler: session auto-register failed for %s/%s: %v",
				sandbox.Namespace, sandbox.Name, err)
		}
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

// onSandboxDeleted runs the cleanup a vanished Sandbox needs. Extend here when
// a deleted sandbox acquires more state to release.
//
// Today that is the Store mapping: without it the session outlives its Pod
// until the key's own TTL expires (ExpiresAt plus a grace hour, so up to a day),
// during which the Router still resolves the session to a dead address and the
// health watcher reports it as PodNotFound on every scan.
//
// A failure is returned rather than logged so the controller retries with
// backoff. The deletion event is the only notification there will ever be, so
// giving up on the first Store blip would fall back to the TTL — precisely the
// case this hook exists to avoid. Retrying is safe: the requeue re-observes an
// absent object, lands here again, and finds the recording still in place.
func (r *SandboxReconciler) onSandboxDeleted(ctx context.Context, key types.NamespacedName) error {
	sessionID := r.peekSession(key)
	if r.Store == nil || sessionID == "" {
		// Never registered (deleted before reaching Running), or this replica
		// never saw it registered. The key's TTL remains the backstop.
		return nil
	}

	// Only drop a mapping that still points at the Sandbox that went away. The
	// session id comes from an annotation a caller may set itself, and the retry
	// above can span minutes, so a newer Sandbox can have claimed the same id in
	// between — deleting that would 404 a live sandbox until its next reconcile.
	info, err := r.Store.GetSandboxBySessionID(ctx, sessionID)
	if errors.Is(err, store.ErrNotFound) {
		r.forgetSession(key) // already deregistered, by the API path or a TTL
		return nil
	}
	if err != nil {
		return fmt.Errorf("look up session %s of deleted sandbox %s: %w", sessionID, key, err)
	}
	if info == nil || info.SandboxName != key.Name || info.Namespace != key.Namespace {
		r.forgetSession(key)
		klog.Infof("SandboxReconciler: session %s now points at another sandbox; leaving it alone", sessionID)
		return nil
	}

	if err := r.Store.DeleteSandboxBySessionID(ctx, sessionID); err != nil {
		return fmt.Errorf("deregister session %s of deleted sandbox %s: %w", sessionID, key, err)
	}
	r.forgetSession(key)
	klog.Infof("SandboxReconciler: deregistered session %s for deleted sandbox %s", sessionID, key)
	return nil
}

// ensureSessionRegistered checks whether the Sandbox has a session-id annotation.
// If present and Redis has no mapping, it registers the session.
// If absent, it generates a new session-id, patches the Sandbox CR, then registers.
//
// Also backfills Spec.Lifecycle.ShutdownTime with DefaultMaxSessionDuration when
// the CR was created without one (e.g. via `kubectl apply`). This keeps the
// "no timeout = 24h default" semantics uniform across all creation paths and
// ensures K8s itself enforces the lifetime cap, not just the in-memory Redis TTL.
func (r *SandboxReconciler) ensureSessionRegistered(ctx context.Context, sandbox *sandboxv1alpha1.Sandbox) error {
	sessionID := ""
	if sandbox.Annotations != nil {
		sessionID = sandbox.Annotations[sessionIDAnnotationKey]
	}

	needsPatch := false
	if sessionID == "" {
		sessionID = generateSessionID()
		needsPatch = true
		klog.V(2).Infof("SandboxReconciler: generated session-id %s for %s/%s",
			sessionID, sandbox.Namespace, sandbox.Name)
	}

	// Remember the pairing before the early return below, so a Sandbox
	// registered by the API path is just as cleanable as one registered here.
	r.rememberSession(types.NamespacedName{Namespace: sandbox.Namespace, Name: sandbox.Name}, sessionID)

	// Check if Redis already has this session (e.g. created via API path).
	if _, err := r.Store.GetSandboxBySessionID(ctx, sessionID); err == nil {
		klog.V(4).Infof("SandboxReconciler: session %s already registered, skipping", sessionID)
		return nil
	}

	// Resolve Pod address — prefer ServiceFQDN > Service DNS > Pod IP.
	podAddr, err := r.resolveSandboxAddress(sandbox)
	if err != nil {
		return fmt.Errorf("resolve sandbox address: %w", err)
	}

	// Backfill ShutdownTime with DefaultMaxSessionDuration when the CR omits it
	// (kubectl apply path). Keeps CR + Redis aligned and lets K8s enforce the cap.
	var defaultShutdown *metav1.Time
	if sandbox.Spec.Lifecycle.ShutdownTime == nil || sandbox.Spec.Lifecycle.ShutdownTime.IsZero() {
		st := shutdownTimeFromDuration(DefaultMaxSessionDuration)
		defaultShutdown = &st
		needsPatch = true
	}

	// Single Patch covers session-id annotation + default ShutdownTime when needed.
	if needsPatch {
		patch := client.MergeFrom(sandbox.DeepCopy())
		if sandbox.Annotations == nil {
			sandbox.Annotations = make(map[string]string)
		}
		sandbox.Annotations[sessionIDAnnotationKey] = sessionID
		if defaultShutdown != nil {
			sandbox.Spec.Lifecycle.ShutdownTime = defaultShutdown
		}
		if err := r.Patch(ctx, sandbox, patch); err != nil {
			return fmt.Errorf("patch sandbox defaults: %w", err)
		}
		klog.V(2).Infof("SandboxReconciler: patched defaults onto %s/%s (session=%s, shutdown=%v)",
			sandbox.Namespace, sandbox.Name, sessionID, defaultShutdown)
	}

	// Determine Kind from ownerReferences.
	kind := store.SandboxKind
	for _, ref := range sandbox.OwnerReferences {
		if ref.Kind == "SandboxClaim" {
			kind = store.SandboxClaimKind
			break
		}
	}

	// Redis ExpiresAt mirrors the (now always populated) Lifecycle.ShutdownTime
	// so the K8s-enforced cap and the in-memory session TTL stay in sync.
	expiresAt := sandbox.Spec.Lifecycle.ShutdownTime.Time

	info := &store.SandboxInfo{
		Kind:         kind,
		SessionID:    sessionID,
		SandboxName:  sandbox.Name,
		Namespace:    sandbox.Namespace,
		PodIP:        podAddr,
		PodPort:      8080,
		EntryPoints:  map[string]string{"/": fmt.Sprintf("%s:%d", podAddr, 8080)},
		CreatedAt:    sandbox.CreationTimestamp.Time,
		LastActivity: time.Now(),
		ExpiresAt:    expiresAt,
		Status:       "running",
	}

	// Recover user identity from annotations/labels.
	if sandbox.Labels != nil {
		info.UserID = sandbox.Labels[userIDLabelKey]
	}
	if sandbox.Annotations != nil {
		info.UserName = sandbox.Annotations[userNameAnnotationKey]
	}

	if err := r.Store.StoreSandbox(ctx, info); err != nil {
		return fmt.Errorf("store session: %w", err)
	}

	klog.Infof("SandboxReconciler: session %s registered for %s/%s (addr=%s)",
		sessionID, sandbox.Namespace, sandbox.Name, podAddr)
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

// generateSessionID creates a new session ID with the standard "sess_" prefix.
func generateSessionID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return "sess_" + hex.EncodeToString(b)
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
	klog.V(2).Infof("SandboxReconciler: registered watcher for %s/%s", namespace, name)
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
