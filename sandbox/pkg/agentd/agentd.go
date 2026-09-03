// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package agentd implements the session guardian controller.
// It watches Sandbox objects and deletes those that have been idle
// (no requests) for longer than the configured timeout.
// Activity comes from Redis, updated by the Router on every request. A
// deployment without a store falls back to the K8s annotation and creation time;
// one with a store that cannot produce a record declines to reclaim, leaving the
// sandbox to the absolute deadline on its CR.
package agentd

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/audit"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

const (
	// LastActivityAnnotation is the legacy K8s annotation for last activity.
	// Kept as fallback when Redis is unavailable.
	LastActivityAnnotation = "agent-sandbox.io/last-activity"

	// sessionIDAnnotation stores the session ID on the Sandbox object.
	sessionIDAnnotation = "runtime.agent-sandbox.io/session-id"

	// User identity label/annotation keys (mirrors workloadmanager conventions).
	// Used to enrich idle-gc audit events with user context.
	userIDLabelKey        = "runtime.agent-sandbox.io/user.id"
	userNameAnnotationKey = "runtime.agent-sandbox.io/user.name"

	// IdleTimeoutAnnotation stores per-sandbox idle timeout set by WM at creation time.
	// Value is a Go duration string (e.g. "2m0s"). When present, overrides DefaultSessionTimeout.
	IdleTimeoutAnnotation = "runtime.agent-sandbox.io/idle-timeout"

	// primusClawSessionIDLabel is the Claw task session UUID on Sandbox labels (distinct from
	// sessionIDAnnotation, which stores the data-plane / workload session id).
	primusClawSessionIDLabel = "primus-claw/session-id"

	// DefaultSessionTimeout is the global idle duration after which a Sandbox is deleted.
	// Users can override via IdleTimeoutAnnotation; maxSessionDuration (default 24h,
	// configurable per-template/per-request, no hard cap) is the final backstop.
	DefaultSessionTimeout = 15 * time.Minute

	// unknownActivityRequeue is how long to wait before reconsidering a Sandbox
	// whose activity could not be established at all. Short enough that a
	// recovered store resumes reclaiming promptly, long enough that an outage
	// does not turn every Sandbox into a hot loop.
	unknownActivityRequeue = 1 * time.Minute

	// missingRecordRequeue is how long to wait before reconsidering a Sandbox the
	// store has no record for. Longer than the above because nothing is broken and
	// nothing changes quickly: only a write puts a record back, and until one
	// exists the answer is the same. Short enough that reclamation resumes within
	// an idle timeout of that write.
	missingRecordRequeue = 5 * time.Minute
)

// SandboxReconciler watches Sandbox objects and enforces idle-timeout cleanup.
//
// +kubebuilder:rbac:groups=agents.x-k8s.io,resources=sandboxes,verbs=get;list;watch;delete
type SandboxReconciler struct {
	client.Client
	Scheme         *runtime.Scheme
	SessionTimeout time.Duration
	// Recorder publishes the reclaim as a Kubernetes Event on the Sandbox.
	//
	// The audit store already records it, but only somewhere a person has to
	// know to look: `kubectl describe sandbox` and every dashboard built on
	// Events show nothing, so a sandbox that was deleted while its work was
	// still running is indistinguishable from one that was never created --
	// which is how one reclaim cost three hours of log archaeology across a
	// 120-hour control-plane window to attribute. Nil disables it; the audit
	// event is written either way.
	Recorder record.EventRecorder
	// Store is the Redis-backed session store (optional).
	//
	// When non-nil it carries the most recent activity time, written by the
	// Router on every proxy request and by the keepalive GET, and it is the only
	// source this reconciler will reclaim on.
	//
	// A store that produces no record for a session -- whether it says so or
	// cannot answer at all -- ends the search rather than falling back. Every
	// other timestamp available predates what the store used to hold, so acting
	// on one deletes a sandbox that was busy right up to the loss. The absolute
	// deadline on the CR bounds what declining costs.
	//
	// Nil is the standalone K8s-only deployment, which judges sandboxes by the
	// annotation and creation time alone and has no record it can lose.
	Store store.Store
	// Audit is the optional audit event store. When non-nil, idle-gc deletions
	// emit a sandbox.deleted event with delete_reason=gc_idle so callers can
	// observe why their sandbox disappeared (e.g. via GET /v1/sandbox/sessions/:id/logs).
	Audit audit.AuditStore

	// startedAt is when this process began watching. Set in SetupWithManager.
	startedAt time.Time
}

// Two ways an activity time can be missing, told apart because only one of them
// is a fault.
//
// errNoActivityRecord is a store that answered: there is no record for this
// session. Expected after the store loses data, and bounded -- Spec.ShutdownTime
// still expires the sandbox without consulting any store.
//
// errActivityUnreadable is a store that could not answer at all, which is a fault
// worth reporting even though the response to both is the same: do not reclaim.
var (
	errNoActivityRecord   = errors.New("no activity record for this session")
	errActivityUnreadable = errors.New("activity record unreadable")
)

// Reconcile checks if the Sandbox has been idle too long and deletes it if so.
func (r *SandboxReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	sandbox := &sandboxv1alpha1.Sandbox{}
	if err := r.Get(ctx, req.NamespacedName, sandbox); err != nil {
		if client.IgnoreNotFound(err) == nil {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	// Already on its way out, by somebody else's decision. Reconciling it would
	// at best re-issue a delete that changes nothing and at worst attribute
	// another controller's teardown -- or a user's -- to the idle collector.
	if !sandbox.DeletionTimestamp.IsZero() {
		return ctrl.Result{}, nil
	}

	lastActivity, err := r.resolveLastActivity(ctx, sandbox)
	if err != nil {
		// Neither case reclaims, but they are not the same event and should not
		// read as one.
		//
		// A missing record is an expected steady state after the store loses data,
		// and it persists until something writes one, so warning on every pass
		// would report an outage once a period per sandbox for as long as it lasts.
		// Info, and rechecked at a rate that suits something that will not change
		// quickly. Spec.ShutdownTime, not this, is what bounds the sandbox.
		if errors.Is(err, errNoActivityRecord) {
			logger.Info("not reclaiming: no activity record, leaving expiry to ShutdownTime",
				"sandbox", sandbox.Name,
				"namespace", sandbox.Namespace,
				"retry_after", missingRecordRequeue,
			)
			return ctrl.Result{RequeueAfter: missingRecordRequeue}, nil
		}
		// An unreadable store is a fault, and this line is the only thing that
		// says so. Retried promptly, because reclamation should resume as soon as
		// the store does.
		slog.Warn("deferring idle check, activity unavailable",
			"sandbox", sandbox.Name,
			"namespace", sandbox.Namespace,
			"retry_after", unknownActivityRequeue,
			"error", err,
		)
		return ctrl.Result{RequeueAfter: unknownActivityRequeue}, nil
	}

	// Determine idle timeout: per-sandbox annotation > controller config > global default.
	// No hard cap on idle timeout — maxSessionDuration (default 24h, configurable) is
	// the final backstop.
	timeout := r.SessionTimeout
	if idleStr, ok := sandbox.Annotations[IdleTimeoutAnnotation]; ok && idleStr != "" {
		if d, err := time.ParseDuration(idleStr); err == nil && d > 0 {
			timeout = d
		}
	}
	if timeout == 0 {
		timeout = DefaultSessionTimeout
	}

	expiresAt := lastActivity.Add(timeout)

	if time.Now().After(expiresAt) {
		runtimeSessionID := ""
		if sandbox.Annotations != nil {
			runtimeSessionID = sandbox.Annotations[sessionIDAnnotation]
		}
		clawSessionID := ""
		if sandbox.Labels != nil {
			clawSessionID = sandbox.Labels[primusClawSessionIDLabel]
		}
		logger.Info("deleting idle sandbox",
			"sandbox", sandbox.Name,
			"namespace", sandbox.Namespace,
			"runtime_session_id", runtimeSessionID,
			"claw_session_id", clawSessionID,
			"last_activity", lastActivity,
			"timeout", timeout,
		)
		// Emit audit event BEFORE deletion so callers can observe the cause.
		// Fire-and-forget: never block the GC on audit failures.
		r.emitIdleDeletedEvent(ctx, sandbox, lastActivity, timeout)
		deleteErr := r.Delete(ctx, sandbox)
		if deleteErr != nil && client.IgnoreNotFound(deleteErr) != nil {
			return ctrl.Result{}, deleteErr
		}
		// Only when this call is the one that removed it, and only after it did.
		//
		// Before the delete, an Event would claim a reclaim that RBAC, a webhook
		// or a flaky API call then refused -- and the Event is the thing an
		// operator trusts, so it would send them looking for a pod still sitting
		// there. On a NotFound it would claim someone else's teardown: a user
		// deleting their own sandbox, or another controller, filed under
		// IdleReclaimed and counted against an idle timeout that had nothing to
		// do with it.
		if deleteErr == nil {
			r.recordIdleDeletedEvent(sandbox, lastActivity, timeout)
		}
		// Reached whether this call removed the Sandbox or found it already gone --
		// something else deleting it first still leaves the mapping stale, and the
		// session id is in hand either way. Safe to run on that path because
		// deregisterSession only drops a mapping that still points here.
		r.deregisterSession(ctx, runtimeSessionID, sandbox.Namespace, sandbox.Name)
		return ctrl.Result{}, nil
	}

	// Re-queue just before expiry
	requeueAfter := time.Until(expiresAt) + time.Second
	logger.V(1).Info("sandbox still active, requeueing",
		"sandbox", sandbox.Name,
		"requeue_after", requeueAfter,
	)
	return ctrl.Result{RequeueAfter: requeueAfter}, nil
}

// deregisterSession drops the session→sandbox mapping of a Sandbox this
// controller just deleted.
//
// The idle timeout is minutes while the session key's TTL tracks ExpiresAt
// (24h by default, plus a grace hour), so without this the mapping outlives
// its Pod by up to a full day: the Router keeps resolving the session to a
// dead address, and the health watcher keeps reporting it as PodNotFound.
//
// Best-effort by design. The Sandbox is already gone, so a Store failure must
// not fail the reconcile — the key still expires on its own TTL, and a
// requeue would only re-Get a resource that no longer exists.
func (r *SandboxReconciler) deregisterSession(ctx context.Context, sessionID, namespace, name string) {
	if r.Store == nil || sessionID == "" {
		return
	}
	// Only drop a mapping that still points at the Sandbox just deleted. The
	// session id comes from an annotation a caller may set itself, so the same
	// id can belong to a later Sandbox; deleting that would 404 a live one.
	info, err := r.Store.GetSandboxBySessionID(ctx, sessionID)
	if errors.Is(err, store.ErrNotFound) {
		return // already deregistered, or the key expired on its own
	}
	if err != nil {
		// Kept distinct from not-found, because the two leave the system in
		// opposite states. This one leaves a live mapping pointing at a Pod that
		// is already gone, with nothing behind it but the key's own TTL -- up to a
		// day of the Router resolving the session to a dead address, which is the
		// exact failure this function exists to prevent. The WM reconciler
		// attempts the same cleanup and does retry, but only while its
		// process-local bookkeeping holds this sandbox, so it is no guarantee.
		// Logged rather than returned all the same: the Sandbox is deleted, so a
		// requeue would only re-Get a resource that no longer exists.
		slog.Warn("idle-gc: session lookup failed, mapping left to its TTL",
			"sessionID", sessionID, "sandbox", name, "error", err)
		return
	}
	if info == nil || info.SandboxName != name || info.Namespace != namespace {
		slog.Info("idle-gc: session now points at another sandbox, leaving it alone",
			"sessionID", sessionID, "sandbox", name)
		return
	}
	if err := r.Store.DeleteSandboxBySessionID(ctx, sessionID); err != nil {
		slog.Warn("idle-gc: failed to deregister session",
			"sessionID", sessionID, "error", err)
		return
	}
	slog.Info("idle-gc: session deregistered", "sessionID", sessionID)
}

// resolveLastActivity returns the activity timestamp to judge a sandbox by, or
// an error when no trustworthy one can be established.
//
// Preference: the store's record, then the K8s annotation, then creation time.
// The last two are only sound for a sandbox the store never had a record of --
// for one whose record was lost they predate the traffic that record described,
// and using them reclaims a busy sandbox immediately.
//
// So a store configured but unable to produce a record, for either reason, ends
// the search rather than falling through. Nothing here bounds how long a sandbox
// survives that; Spec.ShutdownTime does, from the CR and without a store.
func (r *SandboxReconciler) resolveLastActivity(ctx context.Context, sandbox *sandboxv1alpha1.Sandbox) (time.Time, error) {
	lastActivity := sandbox.CreationTimestamp.Time
	if s, ok := sandbox.Annotations[LastActivityAnnotation]; ok {
		if t, parseErr := time.Parse(time.RFC3339, s); parseErr == nil {
			lastActivity = t
		}
	}

	if r.Store != nil {
		if sessionID, ok := sandbox.Annotations[sessionIDAnnotation]; ok && sessionID != "" {
			info, getErr := r.Store.GetSandboxBySessionID(ctx, sessionID)
			switch {
			case getErr == nil && info != nil:
				lastActivity = info.LastActivity
			case errors.Is(getErr, store.ErrNotFound):
				// The mapping is gone while the Sandbox is still here, and nothing
				// left can say whether the session ended or the store lost the
				// record. Both remaining candidates -- the annotation and the
				// creation time -- predate whatever the store used to hold, so
				// either would date a busy sandbox from before its traffic and
				// reclaim it immediately.
				//
				// Declining costs a sandbox that outlives its idle timeout. It does
				// not cost an unbounded one: Spec.ShutdownTime is an absolute
				// deadline on the CR, enforced by sandbox-runtime-controller
				// without reading any store, and workloadmanager backfills it on
				// every Sandbox. Reclamation resumes on its own as soon as a record
				// exists again, which the keepalive rebuilds within a minute for
				// anything with a client still attached.
				return time.Time{}, fmt.Errorf("%w: session %q", errNoActivityRecord, sessionID)
			default:
				// Unreadable is not idle. Refusing to answer sends the caller to
				// a requeue instead of a deletion decided on a timestamp nobody
				// could read.
				if getErr == nil {
					// No store does this today, but a (nil, nil) reply would
					// otherwise be wrapped as %!w(<nil>) and lose the reason.
					getErr = errors.New("store returned neither a record nor an error")
				}
				return time.Time{}, fmt.Errorf("%w: session %q: %w", errActivityUnreadable, sessionID, getErr)
			}
		}
	}

	return lastActivity, nil
}

// emitIdleDeletedEvent records a sandbox.deleted audit event for idle-gc.
// Fire-and-forget — audit failures never block or fail the deletion path.
// No-op when Audit store is not configured (dev/test mode).
func (r *SandboxReconciler) emitIdleDeletedEvent(
	ctx context.Context,
	sandbox *sandboxv1alpha1.Sandbox,
	lastActivity time.Time,
	timeout time.Duration,
) {
	if r.Audit == nil {
		return
	}

	sessionID := ""
	if sandbox.Annotations != nil {
		sessionID = sandbox.Annotations[sessionIDAnnotation]
	}

	userID := ""
	if sandbox.Labels != nil {
		userID = sandbox.Labels[userIDLabelKey]
	}
	userName := ""
	if sandbox.Annotations != nil {
		userName = sandbox.Annotations[userNameAnnotationKey]
	}

	now := time.Now()
	meta := map[string]string{
		"last_activity": lastActivity.UTC().Format(time.RFC3339),
		"idle_timeout":  timeout.String(),
	}
	if sandbox.Labels != nil {
		if cid := sandbox.Labels[primusClawSessionIDLabel]; cid != "" {
			meta["claw_session_id"] = cid
		}
	}

	event := &audit.AuditEvent{
		ID:           audit.NewEventID(),
		EventType:    audit.EventDeleted,
		SessionID:    sessionID,
		SandboxName:  sandbox.Name,
		Namespace:    sandbox.Namespace,
		UserID:       userID,
		UserName:     userName,
		Timestamp:    now,
		DeleteReason: audit.ReasonGCIdle,
		DurationMs:   now.Sub(sandbox.CreationTimestamp.Time).Milliseconds(),
		Metadata:     meta,
	}
	audit.NormalizeEvent(event)
	if err := r.Audit.Store(ctx, event); err != nil {
		slog.Warn("agentd: failed to emit idle-gc audit event",
			"sandbox", sandbox.Name,
			"session_id", sessionID,
			"error", err)
	}
}

// recordIdleDeletedEvent publishes the reclaim where a person will find it.
//
// Same facts the audit event carries -- when the sandbox was last active, and
// the timeout it outran -- because those two are what turn "the pod vanished"
// into "the pod was reclaimed for being idle, and here is the window it missed
// by". Without them the Event only restates the disappearance.
//
// Normal rather than Warning: reclaiming an idle sandbox is this controller
// working, and a Warning would put every routine reclaim in front of whatever
// watches for Warnings. That it is sometimes wrong -- the pod was busy in a way
// nothing outside it could see -- is an argument for saying so, not for
// alarming on every one.
//
// Emitted after the delete, unlike the audit event: this one is what an
// operator reads, and one saying a sandbox was reclaimed while it is still
// there -- RBAC, a webhook, a flaky API call -- is worse than none at all. The
// object being gone is not a problem; an Event holds its own reference. Events
// also expire on their own (an hour, in a default cluster), so this is a
// debugging aid on top of the audit trail, not a replacement for it.
func (r *SandboxReconciler) recordIdleDeletedEvent(
	sandbox *sandboxv1alpha1.Sandbox,
	lastActivity time.Time,
	timeout time.Duration,
) {
	if r.Recorder == nil {
		return
	}
	r.Recorder.Eventf(sandbox, corev1.EventTypeNormal, "IdleReclaimed",
		"Deleted after %s idle (last activity %s)",
		timeout, lastActivity.UTC().Format(time.RFC3339))
}

// SetupWithManager registers the controller.
func (r *SandboxReconciler) SetupWithManager(mgr ctrl.Manager) error {
	// Recorded here rather than at first reconcile: the gap between them is
	// exactly the window where nobody was observing activity, which is what the
	// baseline has to cover.
	if r.startedAt.IsZero() {
		r.startedAt = time.Now()
	}
	return ctrl.NewControllerManagedBy(mgr).
		Named("sandbox-idle-gc-controller").
		For(&sandboxv1alpha1.Sandbox{}).
		Complete(r)
}
