// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"sync/atomic"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/util/retry"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/audit"
	log "sigs.k8s.io/agent-sandbox/pkg/logx"
)

// retention is how long a revoked or expired grant CR is kept for audit.
const retention = 24 * time.Hour

// SandboxRef is the identity of a sandbox charged to a grant.
type SandboxRef struct {
	ID        string
	Role      string
	GPUs      int32
	SessionID string
}

// Reclaimer deletes one sandbox that belonged to a grant.
type Reclaimer interface {
	Reclaim(ctx context.Context, ref SandboxRef) error
}

// SandboxExists reports whether a charged sandbox is still present.
type SandboxExists interface {
	Exists(ctx context.Context, ref SandboxRef) (bool, error)
}

// Recorder stores a grant audit event.
type Recorder interface {
	Record(ctx context.Context, event *audit.AuditEvent)
}

// Service is the grant admin API backed by SandboxGrant CRs.
type Service struct {
	client     ctrlclient.Client
	reader     ctrlclient.Reader
	namespace  string
	dataKey    []byte
	authn      Authenticator
	attest     AttestationChecker
	identity   IdentityChecker
	membership MembershipChecker
	reclaimer  Reclaimer
	exists     SandboxExists
	promoter   PendingPromoter
	record     Recorder
	now        func() time.Time
	owner      atomic.Pointer[ownerConfig]
}

// PendingPromoter finishes a pending sandbox whose Workload the create goroutine no longer owns.
type PendingPromoter interface {
	PromotePending(ctx context.Context, grantID string, ref runtimev1alpha1.GrantSandboxRef) error
}

// SetPromoter adopts pending sandboxes that are already running after a control-plane restart.
func (s *Service) SetPromoter(p PendingPromoter) {
	if s != nil {
		s.promoter = p
	}
}

// Options configures a Service.
type Options struct {
	Client     ctrlclient.Client
	Reader     ctrlclient.Reader
	Namespace  string
	DataKey    []byte
	Authn      Authenticator
	Attest     AttestationChecker
	Identity   IdentityChecker
	Membership MembershipChecker
	Reclaimer  Reclaimer
	Exists     SandboxExists
	Record     Recorder
	Now        func() time.Time
}

// New returns a grant service. Client and Namespace are required.
func New(opt Options) *Service {
	now := opt.Now
	if now == nil {
		now = time.Now
	}
	reader := opt.Reader
	if reader == nil {
		reader = opt.Client
	}
	return &Service{
		client:     opt.Client,
		reader:     reader,
		namespace:  opt.Namespace,
		dataKey:    opt.DataKey,
		authn:      opt.Authn,
		attest:     opt.Attest,
		identity:   opt.Identity,
		membership: opt.Membership,
		reclaimer:  opt.Reclaimer,
		exists:     opt.Exists,
		record:     opt.Record,
		now:        now,
	}
}

// Authenticate checks the grant admin caller.
func (s *Service) Authenticate(ctx context.Context, token string) error {
	if s.authn == nil {
		return opErr(http.StatusUnauthorized, "unauthenticated", "grant auth is not configured")
	}
	return s.authn.Authenticate(ctx, token)
}

// Issue creates a grant or, when the same id was already issued with the same
// execution spec, returns it without keys. A new attestation for that spec is
// accepted after it is verified. Keys are returned only by the call that
// creates the CR.
func (s *Service) Issue(ctx context.Context, req IssueRequest) (IssueResponse, int, error) {
	if err := validateIssue(req, s.now()); err != nil {
		return IssueResponse{}, 0, err
	}
	if s.attest == nil {
		return IssueResponse{}, 0, opErr(http.StatusServiceUnavailable, "attestation_unavailable", "JWKS is not configured")
	}
	if err := s.attest.Check(req.Attestation, req); err != nil {
		return IssueResponse{}, 0, err
	}
	if s.identity == nil {
		return IssueResponse{}, 0, opErr(http.StatusServiceUnavailable, "identity_unavailable", "SaFE client is not configured")
	}
	userName, err := s.identity.Check(ctx, req.PlatformKey, req.Owner.UserID)
	if err != nil {
		return IssueResponse{}, 0, err
	}
	if userName != "" {
		req.Owner.UserName = userName
	}
	if s.membership == nil {
		return IssueResponse{}, 0, opErr(http.StatusServiceUnavailable, "membership_unavailable", "User client is not configured")
	}
	if err := s.membership.Check(ctx, req.Owner.UserID, req.Owner.Workspaces); err != nil {
		return IssueResponse{}, 0, err
	}
	roles, expanded, stored, err := expandTemplates(req.Issuer.AppRunID, req.Roles, req.Templates)
	if err != nil {
		return IssueResponse{}, 0, err
	}
	if err := s.resolveTemplateGPUCounts(ctx, req.Issuer.AppRunID, stored); err != nil {
		return IssueResponse{}, 0, err
	}
	if err := s.checkResolvedGPUs(req.Attestation, stored); err != nil {
		return IssueResponse{}, 0, err
	}
	if len(s.dataKey) == 0 {
		return IssueResponse{}, 0, opErr(http.StatusServiceUnavailable, "grant_data_key_missing", "GRANT_DATA_KEY is not configured")
	}
	sealed, err := Seal(s.dataKey, []byte(req.PlatformKey))
	if err != nil {
		return IssueResponse{}, 0, opWrap(http.StatusInternalServerError, "grant_seal_failed", "", err)
	}

	keys := make(map[string]string, len(roles))
	hashes := make(map[string]string, len(roles))
	for role := range roles {
		key, err := NewE2BKey()
		if err != nil {
			return IssueResponse{}, 0, opWrap(http.StatusInternalServerError, "grant_key_failed", "", err)
		}
		keys[role] = key
		hashes[role] = HashKey(key)
	}

	obj := &runtimev1alpha1.SandboxGrant{
		ObjectMeta: metav1.ObjectMeta{
			Name:      req.GrantID,
			Namespace: s.namespace,
			Annotations: map[string]string{
				runtimev1alpha1.AnnGrantKeyHashes: FormatKeyHashes(hashes),
			},
		},
		Spec: runtimev1alpha1.SandboxGrantSpec{
			Owner: runtimev1alpha1.GrantOwner{
				UserID:     req.Owner.UserID,
				UserName:   req.Owner.UserName,
				Workspaces: append([]string(nil), req.Owner.Workspaces...),
			},
			Issuer: runtimev1alpha1.GrantIssuer{
				SessionID: req.Issuer.SessionID,
				AppRunID:  req.Issuer.AppRunID,
			},
			Roles:                 roles,
			Templates:             stored,
			GPUHoursBudget:        req.GPUHoursBudget,
			MaxSandboxSeconds:     req.MaxSandboxSeconds,
			ExpiresAt:             expiresAtTime(req.ExpiresAt),
			Attestation:           req.Attestation,
			PlatformKeyCiphertext: sealed,
		},
	}
	if err := s.client.Create(ctx, obj); err != nil {
		if !apierrors.IsAlreadyExists(err) {
			return IssueResponse{}, 0, opWrap(http.StatusInternalServerError, "grant_create_failed", "", err)
		}
		existing, gerr := s.get(ctx, req.GrantID)
		if gerr != nil {
			return IssueResponse{}, 0, gerr
		}
		if !specMatches(existing, obj.Spec) {
			return IssueResponse{}, 0, opErr(http.StatusConflict, "grant_conflict", "grantId already exists with a different spec")
		}
		return IssueResponse{GrantID: req.GrantID, Templates: expandedFrom(existing)}, http.StatusOK, nil
	}
	if err := s.setStatus(ctx, req.GrantID, func(g *runtimev1alpha1.SandboxGrant) error {
		g.Status.State = runtimev1alpha1.GrantStateActive
		g.Status.KeyHashes = hashes
		return nil
	}); err != nil {
		_ = s.client.Delete(ctx, obj)
		return IssueResponse{}, 0, opWrap(http.StatusInternalServerError, "grant_status_failed", "", err)
	}
	if err := s.registerTemplates(ctx, req.GrantID, req.Issuer.AppRunID, stored); err != nil {
		_ = s.deleteTemplates(ctx, obj)
		_ = s.client.Delete(ctx, obj)
		return IssueResponse{}, 0, opWrap(http.StatusInternalServerError, "template_register_failed", "", err)
	}
	s.audit(ctx, audit.EventGrantCreated, req.GrantID, req.Issuer.SessionID, req.Issuer.AppRunID, req.Owner.UserID, req.Owner.UserName, "")
	return IssueResponse{GrantID: req.GrantID, Keys: keys, Templates: expanded}, http.StatusCreated, nil
}

// Get returns the grant without keys or the platform key.
func (s *Service) Get(ctx context.Context, grantID string) (GrantView, error) {
	g, err := s.get(ctx, grantID)
	if err != nil {
		return GrantView{}, err
	}
	return viewOf(g), nil
}

// Extend pushes expiresAt later and stores the replacement attestation.
func (s *Service) Extend(ctx context.Context, grantID string, req ExtendRequest) (GrantView, error) {
	g, err := s.get(ctx, grantID)
	if err != nil {
		return GrantView{}, err
	}
	if g.Status.State == runtimev1alpha1.GrantStateRevoked {
		return GrantView{}, opErr(http.StatusConflict, "grant_revoked", grantID)
	}
	if !req.ExpiresAt.After(g.Spec.ExpiresAt.Time) {
		return GrantView{}, opErr(http.StatusBadRequest, "invalid_grant", "expiresAt must move later")
	}
	issue := issueFrom(g, req.ExpiresAt, req.Attestation)
	if s.attest == nil {
		return GrantView{}, opErr(http.StatusServiceUnavailable, "attestation_unavailable", "JWKS is not configured")
	}
	if err := s.attest.Check(req.Attestation, issue); err != nil {
		return GrantView{}, err
	}
	err = retry.RetryOnConflict(retry.DefaultRetry, func() error {
		current, err := s.get(ctx, grantID)
		if err != nil {
			return err
		}
		if current.Status.State == runtimev1alpha1.GrantStateRevoked {
			return opErr(http.StatusConflict, "grant_revoked", grantID)
		}
		if !req.ExpiresAt.After(current.Spec.ExpiresAt.Time) {
			return opErr(http.StatusBadRequest, "invalid_grant", "expiresAt must move later")
		}
		current.Spec.ExpiresAt = expiresAtTime(req.ExpiresAt)
		current.Spec.Attestation = req.Attestation
		return s.client.Update(ctx, current)
	})
	if err != nil {
		if _, ok := err.(*OpError); ok {
			return GrantView{}, err
		}
		return GrantView{}, opWrap(http.StatusInternalServerError, "grant_update_failed", "", err)
	}
	if err := s.setStatus(ctx, grantID, func(cur *runtimev1alpha1.SandboxGrant) error {
		if cur.Status.State == runtimev1alpha1.GrantStateExpired {
			cur.Status.State = runtimev1alpha1.GrantStateActive
		}
		return nil
	}); err != nil {
		return GrantView{}, err
	}
	updated, err := s.get(ctx, grantID)
	if err != nil {
		return GrantView{}, err
	}
	return viewOf(updated), nil
}

// Revoke marks the grant revoked, drops the platform key, and reclaims sandboxes.
// It waits until reclaim finishes or until ctx ends. The caller bounds ctx to 60s.
func (s *Service) Revoke(ctx context.Context, grantID string) (RevokeResponse, error) {
	if _, err := s.get(ctx, grantID); err != nil {
		if apierrors.IsNotFound(err) || IsReason(err, "grant_not_found") {
			return RevokeResponse{GrantID: grantID, Remaining: 0}, nil
		}
		return RevokeResponse{}, err
	}
	if err := s.setStatus(ctx, grantID, func(g *runtimev1alpha1.SandboxGrant) error {
		g.Status.State = runtimev1alpha1.GrantStateRevoked
		return nil
	}); err != nil && !IsReason(err, "grant_not_found") {
		return RevokeResponse{}, err
	}
	_ = s.clearPlatformKey(ctx, grantID)
	if g, gerr := s.get(ctx, grantID); gerr == nil {
		_ = s.deleteTemplates(ctx, g)
	}
	remaining, err := s.reclaimAll(ctx, grantID)
	if err != nil {
		return RevokeResponse{}, err
	}
	g, _ := s.get(ctx, grantID)
	sessionID, appRunID, userID, userName := "", "", "", ""
	if g != nil {
		sessionID, appRunID = g.Spec.Issuer.SessionID, g.Spec.Issuer.AppRunID
		userID, userName = g.Spec.Owner.UserID, g.Spec.Owner.UserName
	}
	s.audit(ctx, audit.EventGrantRevoked, grantID, sessionID, appRunID, userID, userName, "")
	return RevokeResponse{GrantID: grantID, Remaining: remaining}, nil
}

// Reserve charges a sandbox against the grant. Concurrent callers cannot
// exceed the role caps: the update uses the CR resourceVersion.
func (s *Service) Reserve(ctx context.Context, grantID, role, sandboxID, sessionID string, gpus int32) error {
	if sandboxID == "" {
		return opErr(http.StatusBadRequest, "invalid_grant", "sandbox id is required")
	}
	return s.setStatus(ctx, grantID, func(g *runtimev1alpha1.SandboxGrant) error {
		return reserveOne(g, role, sandboxID, sessionID, gpus, s.now())
	})
}

// Release removes a sandbox from the grant and adds its GPU seconds.
func (s *Service) Release(ctx context.Context, grantID, sandboxID string, gpuSeconds int64) error {
	return s.setStatus(ctx, grantID, func(g *runtimev1alpha1.SandboxGrant) error {
		releaseOne(g, sandboxID, gpuSeconds)
		return nil
	})
}

// LookupKey resolves an E2B key to its grant and role.
func (s *Service) LookupKey(ctx context.Context, rawKey string) (grantID, role string, err error) {
	hash := HashKey(rawKey)
	list, err := s.list(ctx)
	if err != nil {
		return "", "", err
	}
	for i := range list {
		g := &list[i]
		hashes := g.Status.KeyHashes
		if len(hashes) == 0 && g.Annotations != nil {
			hashes = ParseKeyHashes(g.Annotations[runtimev1alpha1.AnnGrantKeyHashes])
		}
		found, ok := RoleForHash(hashes, hash)
		if !ok {
			continue
		}
		if err := usable(g, s.now()); err != nil {
			return g.Name, found, err
		}
		return g.Name, found, nil
	}
	return "", "", opErr(http.StatusUnauthorized, "invalid_key", "key does not match a grant")
}

// ReapOnce expires due grants, reclaims their sandboxes, drops missing ones,
// and deletes grant CRs kept past the retention window.
func (s *Service) ReapOnce(ctx context.Context) {
	list, err := s.list(ctx)
	if err != nil {
		log.Warn("grant reap list failed", "error", err)
		return
	}
	now := s.now()
	for i := range list {
		g := &list[i]
		if refsNeedCompaction(g, now) {
			if err := s.setStatus(ctx, g.Name, func(cur *runtimev1alpha1.SandboxGrant) error {
				compactEndedRefs(cur, now)
				return nil
			}); err != nil {
				log.Warn("grant sandbox history cleanup failed", "grant", g.Name, "error", err)
			}
		}
		if g.Status.State == runtimev1alpha1.GrantStateActive && !g.Spec.ExpiresAt.IsZero() && !now.Before(g.Spec.ExpiresAt.Time) {
			if err := s.setStatus(ctx, g.Name, func(cur *runtimev1alpha1.SandboxGrant) error {
				cur.Status.State = runtimev1alpha1.GrantStateExpired
				return nil
			}); err != nil {
				log.Warn("grant expire failed", "grant", g.Name, "error", err)
				continue
			}
			s.audit(ctx, audit.EventGrantExpired, g.Name, g.Spec.Issuer.SessionID, g.Spec.Issuer.AppRunID, g.Spec.Owner.UserID, g.Spec.Owner.UserName, "")
			g.Status.State = runtimev1alpha1.GrantStateExpired
		}
		if g.Status.State == runtimev1alpha1.GrantStateActive {
			s.promotePending(ctx, g)
		}
		if s.exists != nil && g.Status.State == runtimev1alpha1.GrantStateActive {
			s.dropMissing(ctx, g)
		}
		ended := g.Status.State == runtimev1alpha1.GrantStateRevoked || g.Status.State == runtimev1alpha1.GrantStateExpired
		remaining := 0
		if ended {
			var reclaimErr error
			remaining, reclaimErr = s.reclaimAll(ctx, g.Name)
			if reclaimErr != nil {
				log.Warn("grant reclaim failed", "grant", g.Name, "error", reclaimErr)
				continue
			}
			if err := s.clearPlatformKey(ctx, g.Name); err != nil && !IsReason(err, "grant_not_found") {
				log.Warn("grant key cleanup failed", "grant", g.Name, "error", err)
			}
			if err := s.deleteTemplates(ctx, g); err != nil {
				log.Warn("grant template cleanup failed", "grant", g.Name, "error", err)
			}
		}
		if ended && !g.Spec.ExpiresAt.IsZero() && now.After(g.Spec.ExpiresAt.Time.Add(retention)) {
			if remaining > 0 {
				continue
			}
			if err := s.client.Delete(ctx, g); err != nil && !apierrors.IsNotFound(err) {
				log.Warn("grant retention delete failed", "grant", g.Name, "error", err)
			}
		}
	}
}

func refsNeedCompaction(g *runtimev1alpha1.SandboxGrant, now time.Time) bool {
	ended := 0
	cutoff := now.Add(-retention)
	for _, ref := range g.Status.Sandboxes {
		if ref.State != runtimev1alpha1.SandboxEnded {
			continue
		}
		ended++
		if !ref.EndedAt.IsZero() && ref.EndedAt.Time.Before(cutoff) {
			return true
		}
	}
	return ended > maxEndedSandboxRefs
}

// Run reaps until ctx ends.
func (s *Service) Run(ctx context.Context, every time.Duration) {
	if every <= 0 {
		every = 30 * time.Second
	}
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.ReapOnce(ctx)
		}
	}
}

// promotePending asks the control plane to adopt a pending sandbox that is already running.
func (s *Service) promotePending(ctx context.Context, g *runtimev1alpha1.SandboxGrant) {
	if s == nil || s.promoter == nil {
		return
	}
	for _, ref := range g.Status.Sandboxes {
		if ref.State != runtimev1alpha1.SandboxPending {
			continue
		}
		if err := s.promoter.PromotePending(ctx, g.Name, ref); err != nil {
			log.Warn("pending sandbox adopt failed", "grant", g.Name, "sandbox", ref.ID, "error", err)
		}
	}
}

func (s *Service) dropMissing(ctx context.Context, g *runtimev1alpha1.SandboxGrant) {
	for _, ref := range g.Status.Sandboxes {
		if pendingWithinDeadline(ref, s.now()) {
			continue
		}
		ok, err := s.exists.Exists(ctx, SandboxRef{ID: ref.ID, Role: ref.Role, GPUs: ref.GPUs, SessionID: ref.SessionID})
		if err != nil || ok || ref.State == runtimev1alpha1.SandboxEnded {
			continue
		}
		if err := s.EndSandbox(ctx, g.Name, ref.ID, "missing"); err != nil && !IsReason(err, "sandbox_not_found") {
			log.Warn("grant reconcile end failed", "grant", g.Name, "sandbox", ref.ID, "error", err)
		}
	}
}

// pendingWithinDeadline reports whether a pending sandbox may still be creating.
func pendingWithinDeadline(ref runtimev1alpha1.GrantSandboxRef, now time.Time) bool {
	if ref.State != runtimev1alpha1.SandboxPending || ref.PendingTimeoutSec <= 0 || ref.StartedAt.IsZero() {
		return false
	}
	return now.Before(ref.StartedAt.Time.Add(time.Duration(ref.PendingTimeoutSec) * time.Second))
}

func (s *Service) reclaimAll(ctx context.Context, grantID string) (int, error) {
	g, err := s.get(ctx, grantID)
	if err != nil {
		if IsReason(err, "grant_not_found") {
			return 0, nil
		}
		return 0, err
	}
	remaining := 0
	for _, ref := range append([]runtimev1alpha1.GrantSandboxRef(nil), g.Status.Sandboxes...) {
		if ref.State == runtimev1alpha1.SandboxEnded {
			continue
		}
		sb := SandboxRef{ID: ref.ID, Role: ref.Role, GPUs: ref.GPUs, SessionID: ref.SessionID}
		if s.reclaimer != nil {
			if err := s.reclaimer.Reclaim(ctx, sb); err != nil {
				remaining++
				log.Warn("grant reclaim failed", "grant", grantID, "sandbox", ref.ID, "error", err)
				continue
			}
		}
		if err := s.EndSandbox(ctx, grantID, ref.ID, "reclaimed"); err != nil && !IsReason(err, "sandbox_not_found") {
			remaining++
			continue
		}
		s.audit(ctx, audit.EventSandboxReclaimed, grantID, g.Spec.Issuer.SessionID, g.Spec.Issuer.AppRunID, g.Spec.Owner.UserID, g.Spec.Owner.UserName, ref.ID)
	}
	return remaining, nil
}

func (s *Service) clearPlatformKey(ctx context.Context, grantID string) error {
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		current, err := s.get(ctx, grantID)
		if err != nil {
			return err
		}
		if current.Spec.PlatformKeyCiphertext == "" {
			return nil
		}
		current.Spec.PlatformKeyCiphertext = ""
		return s.client.Update(ctx, current)
	})
}

func (s *Service) get(ctx context.Context, name string) (*runtimev1alpha1.SandboxGrant, error) {
	g := &runtimev1alpha1.SandboxGrant{}
	err := s.reader.Get(ctx, types.NamespacedName{Name: name, Namespace: s.namespace}, g)
	if apierrors.IsNotFound(err) {
		return nil, opErr(http.StatusNotFound, "grant_not_found", name)
	}
	if err != nil {
		return nil, opWrap(http.StatusInternalServerError, "grant_get_failed", "", err)
	}
	return g, nil
}

func (s *Service) list(ctx context.Context) ([]runtimev1alpha1.SandboxGrant, error) {
	var list runtimev1alpha1.SandboxGrantList
	if err := s.reader.List(ctx, &list, ctrlclient.InNamespace(s.namespace)); err != nil {
		return nil, opWrap(http.StatusInternalServerError, "grant_list_failed", "", err)
	}
	return list.Items, nil
}

func (s *Service) setStatus(ctx context.Context, name string, mutate func(*runtimev1alpha1.SandboxGrant) error) error {
	err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		current, err := s.get(ctx, name)
		if err != nil {
			return err
		}
		if err := mutate(current); err != nil {
			return err
		}
		return s.client.Status().Update(ctx, current)
	})
	if _, ok := err.(*OpError); ok {
		return err
	}
	var replay *Replay
	if errors.As(err, &replay) {
		return err
	}
	if err != nil {
		return opWrap(http.StatusInternalServerError, "grant_status_failed", "", err)
	}
	return nil
}

func (s *Service) audit(ctx context.Context, eventType, grantID, sessionID, appRunID, userID, userName, sandboxID string) {
	if s.record == nil {
		return
	}
	s.record.Record(ctx, &audit.AuditEvent{
		ID:          audit.NewEventID(),
		EventType:   eventType,
		Source:      audit.SourceGrant,
		SessionID:   sessionID,
		SandboxName: sandboxID,
		UserID:      userID,
		UserName:    userName,
		Timestamp:   s.now(),
		Metadata: map[string]string{
			"grantId":  grantID,
			"appRunId": appRunID,
		},
	})
}

func issueFrom(g *runtimev1alpha1.SandboxGrant, expires time.Time, attestation string) IssueRequest {
	roles := make(map[string]RoleRequest, len(g.Spec.Roles))
	for role := range g.Spec.Roles {
		roles[role] = RoleRequest{}
	}
	return IssueRequest{
		GrantID: g.Name,
		Owner: OwnerRequest{
			UserID:     g.Spec.Owner.UserID,
			Workspaces: g.Spec.Owner.Workspaces,
		},
		ExpiresAt:   expires,
		Attestation: attestation,
	}
}

func expandedFrom(g *runtimev1alpha1.SandboxGrant) map[string][]string {
	out := make(map[string][]string, len(g.Spec.Templates))
	for _, tpl := range g.Spec.Templates {
		out[tpl.Name] = expandOne(g.Spec.Issuer.AppRunID, TemplateRequest{Name: tpl.Name, PerGPUCount: tpl.PerGPUCount})
	}
	names := make([]string, 0, len(out))
	for name := range out {
		names = append(names, name)
	}
	sort.Strings(names)
	sorted := make(map[string][]string, len(out))
	for _, name := range names {
		sorted[name] = out[name]
	}
	return sorted
}
