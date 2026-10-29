// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/util/retry"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/audit"
)

const (
	// OwnerKeyLabel marks a SandboxGrant that holds one owner's quota for identity keys.
	OwnerKeyLabel = "agent-sandbox.io/owner-key"
	// ownerAppRunID prefixes the shared template names used by identity keys.
	ownerAppRunID = "e2b"
	// ownerTemplatesID owns the CodeInterpreters registered from the owner policy.
	ownerTemplatesID = "e2b-owner-templates"
	// ownerRecordLifetime is the expiresAt of an owner quota record.
	ownerRecordLifetime = 10 * 365 * 24 * time.Hour
	// defaultOwnerRole is the role and Workload display name for identity keys.
	defaultOwnerRole = "e2b"
)

// OwnerQuota is the per-owner cap for sandboxes created with an identity key.
type OwnerQuota struct {
	MaxSandboxes      int32   `json:"maxSandboxes"`
	MaxGPUs           int32   `json:"maxGpus"`
	GPUHoursBudget    float64 `json:"gpuHoursBudget"`
	MaxSandboxSeconds int64   `json:"maxSandboxSeconds"`
}

// OwnerPolicy is the quota and template set for identity keys.
// Owners maps a user id to a quota that replaces Default.
type OwnerPolicy struct {
	Role      string                `json:"role"`
	Templates []TemplateRequest     `json:"templates"`
	Default   OwnerQuota            `json:"default"`
	Owners    map[string]OwnerQuota `json:"owners"`
}

// ownerConfig is the resolved policy used to build owner quota records.
type ownerConfig struct {
	role      string
	roleSpec  []string
	templates []runtimev1alpha1.GrantTemplate
	quota     OwnerQuota
	owners    map[string]OwnerQuota
}

// OwnerPolicyFromEnv reads E2B_OWNER_POLICY, or the file named by E2B_OWNER_POLICY_FILE.
// A nil policy means identity keys are not accepted.
func OwnerPolicyFromEnv() (*OwnerPolicy, error) {
	var raw []byte
	if path := strings.TrimSpace(os.Getenv("E2B_OWNER_POLICY_FILE")); path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		raw = b
	} else if v := strings.TrimSpace(os.Getenv("E2B_OWNER_POLICY")); v != "" {
		raw = []byte(v)
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil, nil
	}
	var p OwnerPolicy
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("owner policy is not JSON: %w", err)
	}
	return &p, nil
}

// SetOwnerPolicy validates the policy and registers its templates.
func (s *Service) SetOwnerPolicy(ctx context.Context, p OwnerPolicy) error {
	role := p.Role
	if role == "" {
		role = defaultOwnerRole
	}
	if !roleLabel(role) {
		return opErr(http.StatusBadRequest, "invalid_owner_policy", "role "+role+" is not a workload display name")
	}
	if len(p.Templates) == 0 {
		return opErr(http.StatusBadRequest, "invalid_owner_policy", "at least one template is required")
	}
	for id, q := range p.Owners {
		if id == "" || !validQuota(q) {
			return opErr(http.StatusBadRequest, "invalid_owner_policy", "owner "+id+" quota is invalid")
		}
	}
	if !validQuota(p.Default) {
		return opErr(http.StatusBadRequest, "invalid_owner_policy", "default quota is invalid")
	}
	names := make([]string, 0, len(p.Templates))
	for _, tpl := range p.Templates {
		names = append(names, tpl.Name)
	}
	roles, _, stored, err := expandTemplates(ownerAppRunID, map[string]RoleRequest{role: {Templates: names}}, p.Templates)
	if err != nil {
		return err
	}
	if err := s.resolveTemplateGPUCounts(ctx, ownerAppRunID, stored); err != nil {
		return err
	}
	if err := s.upsertOwnerTemplates(ctx, stored); err != nil {
		return err
	}
	owners := make(map[string]OwnerQuota, len(p.Owners))
	for id, q := range p.Owners {
		owners[id] = q
	}
	s.owner.Store(&ownerConfig{role: role, roleSpec: roles[role].Templates, templates: stored, quota: p.Default, owners: owners})
	return nil
}

func validQuota(q OwnerQuota) bool {
	return q.MaxSandboxes >= 0 && q.MaxGPUs >= 0 && q.GPUHoursBudget >= 0 && q.MaxSandboxSeconds >= 0
}

// OwnerRole returns the role used by identity keys, or "" when they are disabled.
func (s *Service) OwnerRole() string {
	if cfg := s.owner.Load(); cfg != nil {
		return cfg.role
	}
	return ""
}

// OwnerGrantName returns the SandboxGrant name that holds the quota of userID.
func OwnerGrantName(userID string) string {
	sum := sha256.Sum256([]byte(userID))
	return "owner-" + hex.EncodeToString(sum[:])[:24]
}

// EnsureOwner returns the owner quota record of userID, creating it on first use
// and updating its caps when the policy changed.
func (s *Service) EnsureOwner(ctx context.Context, userID, userName string) (string, error) {
	cfg := s.owner.Load()
	if cfg == nil {
		return "", opErr(http.StatusForbidden, "owner_keys_disabled", "identity keys are not enabled")
	}
	if userID == "" {
		return "", opErr(http.StatusUnauthorized, "invalid_key", "key has no subject")
	}
	name := OwnerGrantName(userID)
	want := cfg.spec(userID, userName, s.now())
	g, err := s.get(ctx, name)
	if IsReason(err, "grant_not_found") {
		g, err = s.createOwner(ctx, name, want)
	}
	if err != nil {
		return "", err
	}
	if g.Spec.Owner.UserID != userID {
		return "", opErr(http.StatusConflict, "owner_conflict", name)
	}
	if err := usable(g, s.now()); err != nil {
		return "", err
	}
	if !ownerSpecMatches(g.Spec, want) {
		if err := s.updateOwner(ctx, name, want); err != nil {
			return "", err
		}
	}
	return name, nil
}

// spec builds the owner record spec for userID from the policy.
func (c *ownerConfig) spec(userID, userName string, now time.Time) runtimev1alpha1.SandboxGrantSpec {
	q := c.quota
	if o, ok := c.owners[userID]; ok {
		q = o
	}
	templates := make([]runtimev1alpha1.GrantTemplate, len(c.templates))
	for i := range c.templates {
		c.templates[i].DeepCopyInto(&templates[i])
	}
	return runtimev1alpha1.SandboxGrantSpec{
		Owner: runtimev1alpha1.GrantOwner{UserID: userID, UserName: userName, Workspaces: []string{}},
		Issuer: runtimev1alpha1.GrantIssuer{
			SessionID: OwnerGrantName(userID),
			AppRunID:  ownerAppRunID,
		},
		Roles: map[string]runtimev1alpha1.GrantRole{c.role: {
			Templates:    append([]string(nil), c.roleSpec...),
			MaxSandboxes: q.MaxSandboxes,
			MaxGPUs:      q.MaxGPUs,
		}},
		Templates:         templates,
		GPUHoursBudget:    q.GPUHoursBudget,
		MaxSandboxSeconds: q.MaxSandboxSeconds,
		ExpiresAt:         expiresAtTime(now.Add(ownerRecordLifetime)),
	}
}

// createOwner creates an active owner record. A concurrent create returns the existing one.
func (s *Service) createOwner(ctx context.Context, name string, spec runtimev1alpha1.SandboxGrantSpec) (*runtimev1alpha1.SandboxGrant, error) {
	obj := &runtimev1alpha1.SandboxGrant{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: s.namespace,
			Labels:    map[string]string{OwnerKeyLabel: "true"},
		},
		Spec: spec,
	}
	if err := s.client.Create(ctx, obj); err != nil {
		if apierrors.IsAlreadyExists(err) {
			return s.get(ctx, name)
		}
		return nil, opWrap(http.StatusInternalServerError, "grant_create_failed", "", err)
	}
	if err := s.setStatus(ctx, name, func(g *runtimev1alpha1.SandboxGrant) error {
		if g.Status.State == "" {
			g.Status.State = runtimev1alpha1.GrantStateActive
		}
		return nil
	}); err != nil {
		return nil, err
	}
	s.audit(ctx, audit.EventGrantCreated, name, name, ownerAppRunID, spec.Owner.UserID, spec.Owner.UserName, "")
	return s.get(ctx, name)
}

// updateOwner replaces the caps, templates, and user name of an owner record.
func (s *Service) updateOwner(ctx context.Context, name string, want runtimev1alpha1.SandboxGrantSpec) error {
	err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		current, err := s.get(ctx, name)
		if err != nil {
			return err
		}
		current.Spec.Owner.UserName = want.Owner.UserName
		current.Spec.Roles = want.Roles
		current.Spec.Templates = want.Templates
		current.Spec.GPUHoursBudget = want.GPUHoursBudget
		current.Spec.MaxSandboxSeconds = want.MaxSandboxSeconds
		return s.client.Update(ctx, current)
	})
	if _, ok := err.(*OpError); ok {
		return err
	}
	if err != nil {
		return opWrap(http.StatusInternalServerError, "grant_update_failed", "", err)
	}
	return nil
}

// ownerSpecMatches compares the fields the policy controls.
func ownerSpecMatches(got, want runtimev1alpha1.SandboxGrantSpec) bool {
	return got.Owner.UserName == want.Owner.UserName &&
		got.GPUHoursBudget == want.GPUHoursBudget &&
		got.MaxSandboxSeconds == want.MaxSandboxSeconds &&
		sameRoles(got.Roles, want.Roles) &&
		sameTemplates(got.Templates, want.Templates)
}

// upsertOwnerTemplates creates or updates the CodeInterpreters of the owner policy.
func (s *Service) upsertOwnerTemplates(ctx context.Context, templates []runtimev1alpha1.GrantTemplate) error {
	for _, tpl := range templates {
		base, ok, err := templateFromSpec(tpl.Spec)
		if err != nil {
			return opWrap(http.StatusBadRequest, "invalid_owner_policy", "template spec is not JSON", err)
		}
		if !ok {
			continue
		}
		for i, name := range expandOne(ownerAppRunID, TemplateRequest{Name: tpl.Name, PerGPUCount: tpl.PerGPUCount}) {
			want := codeInterpreter(ownerTemplatesID, name, base, templateGPUCount(tpl, i), s.namespace)
			existing := &runtimev1alpha1.CodeInterpreter{}
			err := s.reader.Get(ctx, types.NamespacedName{Name: name, Namespace: s.namespace}, existing)
			if apierrors.IsNotFound(err) {
				if err := s.client.Create(ctx, want); err != nil {
					return opWrap(http.StatusInternalServerError, "template_register_failed", name, err)
				}
				continue
			}
			if err != nil {
				return opWrap(http.StatusInternalServerError, "template_get_failed", name, err)
			}
			if !ownedByGrant(existing, ownerTemplatesID) {
				return opErr(http.StatusConflict, "template_exists", name)
			}
			existing.Labels = want.Labels
			existing.Annotations = want.Annotations
			existing.Spec = want.Spec
			if err := s.client.Update(ctx, existing); err != nil {
				return opWrap(http.StatusInternalServerError, "template_register_failed", name, err)
			}
		}
	}
	return nil
}

// WorkspaceLister returns the workspaces listed on a user.
type WorkspaceLister interface {
	Workspaces(ctx context.Context, userID string) ([]string, error)
}

// OwnerWorkspace picks the workspace for an identity-key sandbox. A requested
// workspace must pass the membership check unless admin is set. Without a request,
// the user's only listed workspace is used.
func (s *Service) OwnerWorkspace(ctx context.Context, userID, requested string, admin bool) (string, error) {
	if requested != "" {
		if admin {
			return requested, nil
		}
		if s.membership == nil {
			return "", opErr(http.StatusServiceUnavailable, "membership_unavailable", "User client is not configured")
		}
		if err := s.membership.Check(ctx, userID, []string{requested}); err != nil {
			return "", err
		}
		return requested, nil
	}
	lister, ok := s.membership.(WorkspaceLister)
	if !ok {
		return "", opErr(http.StatusServiceUnavailable, "membership_unavailable", "User client is not configured")
	}
	got, err := lister.Workspaces(ctx, userID)
	if err != nil {
		return "", err
	}
	if len(got) != 1 {
		return "", opErr(http.StatusBadRequest, "workspace_required", "set metadata agent-sandbox.io/workspace")
	}
	return got[0], nil
}
