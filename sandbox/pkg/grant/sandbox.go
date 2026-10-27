// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/audit"
)

// BeginRequest charges one sandbox and records its E2B control-plane fields.
type BeginRequest struct {
	GrantID         string
	Role            string
	SandboxID       string
	Alias           string
	TemplateID      string
	Namespace       string
	GPUs            int32
	TimeoutSec      int64
	IdempotencyKey  string
	AccessTokenHash string
	Metadata        map[string]string
	Sealed          bool
	Inputs          []string
	Outputs         []string
}

// Replay is returned when the idempotency key already names a sandbox.
// The ref is the existing record, including an ended one.
type Replay struct {
	Ref runtimev1alpha1.GrantSandboxRef
}

// Error reports an idempotency replay. Callers inspect the ref state.
func (r *Replay) Error() string { return "idempotency replay" }

// Snapshot is the grant spec the E2B control plane is allowed to see.
// It has no platform key and no attestation.
type Snapshot struct {
	UserID            string
	UserName          string
	AppRunID          string
	SessionID         string
	Workspaces        []string
	MaxSandboxSeconds int64
	Roles             map[string]runtimev1alpha1.GrantRole
	Templates         []runtimev1alpha1.GrantTemplate
}

// RunningUpdate is the data-plane address recorded once a sandbox is up.
type RunningUpdate struct {
	SandboxName string
	Namespace   string
	NodeName    string
	// Cluster is the SaFE cluster id from the Workload. Empty leaves the stored value unchanged.
	Cluster string
}

// Snapshot returns the grant fields needed to authorize a create.
func (s *Service) Snapshot(ctx context.Context, grantID string) (Snapshot, error) {
	g, err := s.get(ctx, grantID)
	if err != nil {
		return Snapshot{}, err
	}
	roles := make(map[string]runtimev1alpha1.GrantRole, len(g.Spec.Roles))
	for k, v := range g.Spec.Roles {
		roles[k] = *v.DeepCopy()
	}
	templates := make([]runtimev1alpha1.GrantTemplate, len(g.Spec.Templates))
	for i := range g.Spec.Templates {
		g.Spec.Templates[i].DeepCopyInto(&templates[i])
	}
	return Snapshot{
		UserID:            g.Spec.Owner.UserID,
		UserName:          g.Spec.Owner.UserName,
		AppRunID:          g.Spec.Issuer.AppRunID,
		SessionID:         g.Spec.Issuer.SessionID,
		Workspaces:        append([]string(nil), g.Spec.Owner.Workspaces...),
		MaxSandboxSeconds: g.Spec.MaxSandboxSeconds,
		Roles:             roles,
		Templates:         templates,
	}, nil
}

// BeginSandbox charges a sandbox in one status update.
// A repeated idempotency key returns *Replay and does not charge again.
func (s *Service) BeginSandbox(ctx context.Context, req BeginRequest) (runtimev1alpha1.GrantSandboxRef, error) {
	var got runtimev1alpha1.GrantSandboxRef
	err := s.setStatus(ctx, req.GrantID, func(g *runtimev1alpha1.SandboxGrant) error {
		if err := beginOne(g, req, s.now()); err != nil {
			var replay *Replay
			if errors.As(err, &replay) {
				got = replay.Ref
			}
			return err
		}
		got = g.Status.Sandboxes[len(g.Status.Sandboxes)-1]
		return nil
	})
	return got, err
}

// MarkRunning records that the sandbox data plane is up.
func (s *Service) MarkRunning(ctx context.Context, grantID, sandboxID string, up RunningUpdate) error {
	return s.setStatus(ctx, grantID, func(g *runtimev1alpha1.SandboxGrant) error {
		ref, idx := findSandbox(g, sandboxID)
		if idx < 0 || ref.State == runtimev1alpha1.SandboxEnded {
			return opErr(http.StatusNotFound, "sandbox_not_found", sandboxID)
		}
		ref.State = runtimev1alpha1.SandboxRunning
		if up.SandboxName != "" {
			ref.SandboxName = up.SandboxName
		}
		if up.Namespace != "" {
			ref.Namespace = up.Namespace
		}
		if up.NodeName != "" {
			ref.NodeName = up.NodeName
		}
		if up.Cluster != "" {
			ref.Cluster = up.Cluster
		}
		g.Status.Sandboxes[idx] = ref
		return nil
	})
}

// RotateToken adds an access-token hash while retaining recent tokens.
// Raw tokens are never stored.
func (s *Service) RotateToken(ctx context.Context, grantID, sandboxID, hash string) error {
	if hash == "" {
		return opErr(http.StatusBadRequest, "invalid_sandbox", "access token hash is required")
	}
	return s.setStatus(ctx, grantID, func(g *runtimev1alpha1.SandboxGrant) error {
		ref, idx := findSandbox(g, sandboxID)
		if idx < 0 || ref.State == runtimev1alpha1.SandboxEnded {
			return opErr(http.StatusNotFound, "sandbox_not_found", sandboxID)
		}
		hashes := tokenHashes(ref)
		for _, existing := range hashes {
			if existing == hash {
				return nil
			}
		}
		const retainedAccessTokens = 8
		hashes = append(hashes, hash)
		if len(hashes) > retainedAccessTokens {
			hashes = hashes[len(hashes)-retainedAccessTokens:]
		}
		ref.AccessTokenHash = ""
		ref.AccessTokenHashes = hashes
		g.Status.Sandboxes[idx] = ref
		return nil
	})
}

// EndSandbox stops charging a sandbox and keeps the ref for idempotency.
// Ending an already ended sandbox is a no-op.
func (s *Service) EndSandbox(ctx context.Context, grantID, sandboxID, reason string) error {
	return s.setStatus(ctx, grantID, func(g *runtimev1alpha1.SandboxGrant) error {
		now := s.now()
		if err := endOne(g, sandboxID, reason, now); err != nil {
			return err
		}
		compactEndedRefs(g, now)
		return nil
	})
}

// SetSandboxTimeout replaces the lifetime requested for a live sandbox.
// The new duration is measured from now, and the sandbox still cannot run
// longer than MaxSandboxSeconds from the time it started.
func (s *Service) SetSandboxTimeout(ctx context.Context, grantID, role, sandboxID string, timeoutSec int64) error {
	if timeoutSec <= 0 {
		return opErr(http.StatusBadRequest, "invalid_sandbox", "timeout must be > 0")
	}
	return s.setStatus(ctx, grantID, func(g *runtimev1alpha1.SandboxGrant) error {
		if err := usable(g, s.now()); err != nil {
			return err
		}
		for i, ref := range g.Status.Sandboxes {
			if ref.ID != sandboxID || ref.Role != role {
				continue
			}
			if ref.State == runtimev1alpha1.SandboxEnded {
				return opErr(http.StatusNotFound, "sandbox_not_found", sandboxID)
			}
			if g.Spec.MaxSandboxSeconds > 0 && !timeoutWithinLifetime(ref.StartedAt.Time, s.now(), timeoutSec, g.Spec.MaxSandboxSeconds) {
				return opErr(http.StatusForbidden, "timeout_not_allowed",
					fmtDetail("%d > %d", timeoutSec, g.Spec.MaxSandboxSeconds))
			}
			ref.TimeoutSec = timeoutSec
			g.Status.Sandboxes[i] = ref
			return nil
		}
		return opErr(http.StatusNotFound, "sandbox_not_found", sandboxID)
	})
}

// timeoutWithinLifetime reports whether now plus timeoutSec is still within
// maxSec after started. A zero start time compares timeoutSec with maxSec.
func timeoutWithinLifetime(started, now time.Time, timeoutSec, maxSec int64) bool {
	if maxSec <= 0 {
		return true
	}
	if timeoutSec > maxSec {
		return false
	}
	if started.IsZero() {
		return true
	}
	deadline := started.Add(time.Duration(maxSec) * time.Second)
	return !now.Add(time.Duration(timeoutSec) * time.Second).After(deadline)
}

// Sandbox returns one sandbox when it belongs to the role. Other roles are not found.
func (s *Service) Sandbox(ctx context.Context, grantID, role, sandboxID string) (runtimev1alpha1.GrantSandboxRef, error) {
	g, err := s.get(ctx, grantID)
	if err != nil {
		return runtimev1alpha1.GrantSandboxRef{}, err
	}
	for _, ref := range g.Status.Sandboxes {
		if ref.ID == sandboxID && ref.Role == role {
			return ref, nil
		}
	}
	return runtimev1alpha1.GrantSandboxRef{}, opErr(http.StatusNotFound, "sandbox_not_found", sandboxID)
}

// ListRoleSandboxes returns the sandboxes recorded under one role.
func (s *Service) ListRoleSandboxes(ctx context.Context, grantID, role string) ([]runtimev1alpha1.GrantSandboxRef, error) {
	g, err := s.get(ctx, grantID)
	if err != nil {
		return nil, err
	}
	var out []runtimev1alpha1.GrantSandboxRef
	for _, ref := range g.Status.Sandboxes {
		if ref.Role == role {
			out = append(out, ref)
		}
	}
	return out, nil
}

// LookupAccess matches a sandbox id and access token. A mismatch is invalid_token
// whether the id is unknown or the token is wrong.
func (s *Service) LookupAccess(ctx context.Context, sandboxID, token string) (runtimev1alpha1.GrantSandboxRef, error) {
	if sandboxID == "" || token == "" {
		return runtimev1alpha1.GrantSandboxRef{}, opErr(http.StatusUnauthorized, "invalid_token", "access token is required")
	}
	want := HashKey(token)
	list, err := s.list(ctx)
	if err != nil {
		return runtimev1alpha1.GrantSandboxRef{}, err
	}
	for i := range list {
		for _, ref := range list[i].Status.Sandboxes {
			if ref.ID != sandboxID || (ref.AccessTokenHash == "" && len(ref.AccessTokenHashes) == 0) {
				continue
			}
			if tokenHashMatches(ref, want) {
				if err := usable(&list[i], s.now()); err != nil {
					return runtimev1alpha1.GrantSandboxRef{}, err
				}
				return ref, nil
			}
			return runtimev1alpha1.GrantSandboxRef{}, opErr(http.StatusUnauthorized, "invalid_token", "access token does not match")
		}
	}
	return runtimev1alpha1.GrantSandboxRef{}, opErr(http.StatusUnauthorized, "invalid_token", "access token does not match")
}

func tokenHashes(ref runtimev1alpha1.GrantSandboxRef) []string {
	hashes := make([]string, 0, 1+len(ref.AccessTokenHashes))
	if ref.AccessTokenHash != "" {
		hashes = append(hashes, ref.AccessTokenHash)
	}
	hashes = append(hashes, ref.AccessTokenHashes...)
	return hashes
}

func tokenHashMatches(ref runtimev1alpha1.GrantSandboxRef, want string) bool {
	matched := 0
	for _, hash := range tokenHashes(ref) {
		matched |= subtle.ConstantTimeCompare([]byte(hash), []byte(want))
	}
	return matched == 1
}

// AuditDenied records a create that the grant refused.
func (s *Service) AuditDenied(ctx context.Context, grantID, sandboxID string) {
	userID, userName, sessionID, appRunID := "", "", "", ""
	if g, err := s.get(ctx, grantID); err == nil {
		userID, userName = g.Spec.Owner.UserID, g.Spec.Owner.UserName
		sessionID, appRunID = g.Spec.Issuer.SessionID, g.Spec.Issuer.AppRunID
	}
	s.audit(ctx, audit.EventSandboxDenied, grantID, sessionID, appRunID, userID, userName, sandboxID)
}

func beginOne(g *runtimev1alpha1.SandboxGrant, req BeginRequest, now time.Time) error {
	if err := usable(g, now); err != nil {
		return err
	}
	if req.SandboxID == "" || req.Role == "" || req.TemplateID == "" {
		return opErr(http.StatusBadRequest, "invalid_sandbox", "sandbox id, role, and template are required")
	}
	if req.TimeoutSec < 0 {
		return opErr(http.StatusBadRequest, "invalid_sandbox", "timeout must be >= 0")
	}
	for _, ref := range g.Status.Sandboxes {
		if req.IdempotencyKey != "" && ref.IdempotencyKey == req.IdempotencyKey {
			if ref.Role != req.Role {
				return opErr(http.StatusConflict, "idempotency_conflict", req.IdempotencyKey)
			}
			return &Replay{Ref: ref}
		}
		if ref.ID == req.SandboxID {
			return opErr(http.StatusConflict, "sandbox_exists", req.SandboxID)
		}
	}
	limit, ok := g.Spec.Roles[req.Role]
	if !ok {
		return opErr(http.StatusForbidden, "role_not_allowed", req.Role)
	}
	if !containsStr(limit.Templates, req.TemplateID) {
		return opErr(http.StatusForbidden, "template_not_allowed", req.TemplateID)
	}
	if g.Spec.MaxSandboxSeconds > 0 && req.TimeoutSec > g.Spec.MaxSandboxSeconds {
		return opErr(http.StatusForbidden, "timeout_not_allowed",
			fmtDetail("%d > %d", req.TimeoutSec, g.Spec.MaxSandboxSeconds))
	}
	usage := g.Status.Usage[req.Role]
	if limit.MaxSandboxes >= 0 && usage.Sandboxes+1 > limit.MaxSandboxes {
		return opErr(http.StatusTooManyRequests, "grant_quota_exceeded",
			fmtDetail("%s %d/%d sandboxes", req.Role, usage.Sandboxes, limit.MaxSandboxes))
	}
	if limit.MaxGPUs >= 0 && usage.GPUs+req.GPUs > limit.MaxGPUs {
		return opErr(http.StatusTooManyRequests, "grant_quota_exceeded",
			fmtDetail("%s %d/%d gpus", req.Role, usage.GPUs, limit.MaxGPUs))
	}
	if overBudget(g) {
		return opErr(http.StatusTooManyRequests, "grant_quota_exceeded",
			fmtDetail("%s gpu hours", g.Name))
	}
	if g.Status.Usage == nil {
		g.Status.Usage = map[string]runtimev1alpha1.GrantRoleUsage{}
	}
	usage.Sandboxes++
	usage.GPUs += req.GPUs
	g.Status.Usage[req.Role] = usage
	g.Status.Sandboxes = append(g.Status.Sandboxes, runtimev1alpha1.GrantSandboxRef{
		ID:              req.SandboxID,
		Role:            req.Role,
		GPUs:            req.GPUs,
		SessionID:       req.SandboxID,
		StartedAt:       metav1.NewTime(now),
		Alias:           req.Alias,
		TemplateID:      req.TemplateID,
		Namespace:       req.Namespace,
		State:           runtimev1alpha1.SandboxPending,
		TimeoutSec:      req.TimeoutSec,
		IdempotencyKey:  req.IdempotencyKey,
		AccessTokenHash: req.AccessTokenHash,
		Sealed:          req.Sealed,
		Inputs:          append([]string(nil), req.Inputs...),
		Outputs:         append([]string(nil), req.Outputs...),
		Metadata:        copyMap(req.Metadata),
	})
	return nil
}

func endOne(g *runtimev1alpha1.SandboxGrant, sandboxID, reason string, now time.Time) error {
	ref, idx := findSandbox(g, sandboxID)
	if idx < 0 {
		return opErr(http.StatusNotFound, "sandbox_not_found", sandboxID)
	}
	if ref.State == runtimev1alpha1.SandboxEnded {
		return nil
	}
	seconds := int64(0)
	if !ref.StartedAt.IsZero() {
		d := now.Sub(ref.StartedAt.Time)
		if d > 0 && ref.GPUs > 0 {
			seconds = int64(d.Seconds()) * int64(ref.GPUs)
		}
	}
	ref.State = runtimev1alpha1.SandboxEnded
	ref.EndReason = reason
	ref.EndedAt = metav1.NewTime(now)
	ref.AccessTokenHash = ""
	ref.AccessTokenHashes = nil
	ref.SandboxName = ""
	ref.Namespace = ""
	ref.NodeName = ""
	ref.Metadata = nil
	ref.Inputs = nil
	ref.Outputs = nil
	g.Status.Sandboxes[idx] = ref
	if g.Status.Usage != nil {
		usage := g.Status.Usage[ref.Role]
		usage.Sandboxes--
		usage.GPUs -= ref.GPUs
		if usage.Sandboxes < 0 {
			usage.Sandboxes = 0
		}
		if usage.GPUs < 0 {
			usage.GPUs = 0
		}
		g.Status.Usage[ref.Role] = usage
	}
	if seconds > 0 {
		g.Status.GPUSeconds += seconds
	}
	return nil
}

const maxEndedSandboxRefs = 1000

// compactEndedRefs retains recent ended refs for idempotency and audit while
// bounding the status size. Live refs are never removed.
func compactEndedRefs(g *runtimev1alpha1.SandboxGrant, now time.Time) bool {
	cutoff := now.Add(-retention)
	kept := make([]runtimev1alpha1.GrantSandboxRef, 0, len(g.Status.Sandboxes))
	ended := make([]runtimev1alpha1.GrantSandboxRef, 0, len(g.Status.Sandboxes))
	for _, ref := range g.Status.Sandboxes {
		if ref.State != runtimev1alpha1.SandboxEnded {
			kept = append(kept, ref)
			continue
		}
		if !ref.EndedAt.IsZero() && ref.EndedAt.Time.Before(cutoff) {
			continue
		}
		ended = append(ended, ref)
	}
	if len(ended) > maxEndedSandboxRefs {
		ended = ended[len(ended)-maxEndedSandboxRefs:]
	}
	kept = append(kept, ended...)
	if len(kept) == len(g.Status.Sandboxes) {
		return false
	}
	g.Status.Sandboxes = kept
	return true
}

func findSandbox(g *runtimev1alpha1.SandboxGrant, sandboxID string) (runtimev1alpha1.GrantSandboxRef, int) {
	for i, ref := range g.Status.Sandboxes {
		if ref.ID == sandboxID {
			return ref, i
		}
	}
	return runtimev1alpha1.GrantSandboxRef{}, -1
}

func containsStr(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}

func copyMap(in map[string]string) map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
