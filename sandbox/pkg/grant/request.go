// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"encoding/json"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
)

// grantName matches a DNS-1123 label, which is what a namespaced object name allows
// when the id has no dots. Grant ids from Claw are of the form gr-<ulid>.
var grantName = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

// IssueRequest is POST /internal/v1/grants.
type IssueRequest struct {
	GrantID           string                 `json:"grantId"`
	Owner             OwnerRequest           `json:"owner"`
	PlatformKey       string                 `json:"platformKey"`
	Issuer            IssuerRequest          `json:"issuer"`
	Roles             map[string]RoleRequest `json:"roles"`
	Templates         []TemplateRequest      `json:"templates"`
	GPUHoursBudget    float64                `json:"gpuHoursBudget"`
	MaxSandboxSeconds int64                  `json:"maxSandboxSeconds"`
	ExpiresAt         time.Time              `json:"expiresAt"`
	Attestation       string                 `json:"attestation"`
}

// OwnerRequest is the user the grant spends as.
type OwnerRequest struct {
	UserID     string   `json:"userId"`
	UserName   string   `json:"userName"`
	Workspaces []string `json:"workspaces"`
}

// IssuerRequest identifies the Claw session and app run.
type IssuerRequest struct {
	SessionID string `json:"sessionId"`
	AppRunID  string `json:"appRunId"`
}

// RoleRequest is one role's caps. Templates are names before expansion.
type RoleRequest struct {
	Templates    []string `json:"templates"`
	MaxSandboxes int32    `json:"maxSandboxes"`
	MaxGPUs      int32    `json:"maxGpus"`
}

// TemplateRequest is a run-level template. Spec is kept as raw JSON.
type TemplateRequest struct {
	Name        string          `json:"name"`
	PerGPUCount []int32         `json:"perGpuCount"`
	Spec        json.RawMessage `json:"spec"`
}

// ExtendRequest is PATCH /internal/v1/grants/{id}. Only a later expiry is accepted.
type ExtendRequest struct {
	ExpiresAt   time.Time `json:"expiresAt"`
	Attestation string    `json:"attestation"`
}

// IssueResponse is the body of a successful issue call.
// Keys is omitted when the grant already existed.
type IssueResponse struct {
	GrantID   string              `json:"grantId"`
	Keys      map[string]string   `json:"keys,omitempty"`
	Templates map[string][]string `json:"templates,omitempty"`
}

// GrantView is GET /internal/v1/grants/{id}. It has no keys and no platform key.
type GrantView struct {
	GrantID           string                                    `json:"grantId"`
	State             string                                    `json:"state"`
	Owner             runtimev1alpha1.GrantOwner                `json:"owner"`
	Issuer            runtimev1alpha1.GrantIssuer               `json:"issuer"`
	Roles             map[string]runtimev1alpha1.GrantRole      `json:"roles"`
	GPUHoursBudget    float64                                   `json:"gpuHoursBudget"`
	MaxSandboxSeconds int64                                     `json:"maxSandboxSeconds"`
	ExpiresAt         time.Time                                 `json:"expiresAt"`
	Usage             map[string]runtimev1alpha1.GrantRoleUsage `json:"usage,omitempty"`
	GPUSeconds        int64                                     `json:"gpuSeconds"`
	Sandboxes         []runtimev1alpha1.GrantSandboxRef         `json:"sandboxes,omitempty"`
}

// RevokeResponse is the body of DELETE /internal/v1/grants/{id}.
type RevokeResponse struct {
	GrantID   string `json:"grantId"`
	Remaining int    `json:"remaining"`
}

func validateIssue(req IssueRequest, now time.Time) error {
	if !grantName.MatchString(req.GrantID) || len(req.GrantID) > 63 {
		return opErr(http.StatusBadRequest, "invalid_grant", "grantId is not a label value")
	}
	if req.Owner.UserID == "" || len(req.Owner.Workspaces) == 0 {
		return opErr(http.StatusBadRequest, "invalid_grant", "owner userId and workspaces are required")
	}
	if req.Issuer.AppRunID == "" {
		return opErr(http.StatusBadRequest, "invalid_grant", "issuer.appRunId is required")
	}
	if req.Issuer.AppRunID == ownerAppRunID {
		return opErr(http.StatusBadRequest, "invalid_grant", "issuer.appRunId "+ownerAppRunID+" is reserved for identity keys")
	}
	if len(req.Roles) == 0 {
		return opErr(http.StatusBadRequest, "invalid_grant", "at least one role is required")
	}
	if req.ExpiresAt.IsZero() || !req.ExpiresAt.After(now) {
		return opErr(http.StatusBadRequest, "invalid_grant", "expiresAt must be in the future")
	}
	if req.Attestation == "" {
		return opErr(http.StatusBadRequest, "invalid_grant", "attestation is required")
	}
	if req.PlatformKey == "" {
		return opErr(http.StatusBadRequest, "invalid_grant", "platformKey is required")
	}
	if req.GPUHoursBudget < 0 || req.MaxSandboxSeconds < 0 {
		return opErr(http.StatusBadRequest, "invalid_grant", "budgets must be >= 0")
	}
	for role, cap := range req.Roles {
		if !roleLabel(role) {
			return opErr(http.StatusBadRequest, "invalid_grant", "role "+role+" is not a workload display name")
		}
		if cap.MaxSandboxes < 0 || cap.MaxGPUs < 0 {
			return opErr(http.StatusBadRequest, "invalid_grant", "role caps must be >= 0")
		}
	}
	return nil
}

// roleLabel reports whether name can be a SaFE Workload display name.
// That label is a DNS label of at most 40 characters.
func roleLabel(name string) bool {
	const maxRoleLabel = 40
	if name == "" || len(name) > maxRoleLabel {
		return false
	}
	for i, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
		case r == '-' && i > 0 && i < len(name)-1:
		default:
			return false
		}
	}
	return true
}

// expandTemplates rewrites role template names to the registered names.
// A template with perGpuCount [1,8] becomes <appRun>-<name>-g1 and -g8.
func expandTemplates(appRunID string, roles map[string]RoleRequest, templates []TemplateRequest) (map[string]runtimev1alpha1.GrantRole, map[string][]string, []runtimev1alpha1.GrantTemplate, error) {
	byName := make(map[string]TemplateRequest, len(templates))
	stored := make([]runtimev1alpha1.GrantTemplate, 0, len(templates))
	expanded := make(map[string][]string, len(templates))
	for _, tpl := range templates {
		if tpl.Name == "" {
			return nil, nil, nil, opErr(http.StatusBadRequest, "invalid_grant", "template name is required")
		}
		if _, dup := byName[tpl.Name]; dup {
			return nil, nil, nil, opErr(http.StatusBadRequest, "invalid_grant", "duplicate template "+tpl.Name)
		}
		byName[tpl.Name] = tpl
		names := expandOne(appRunID, tpl)
		expanded[tpl.Name] = names
		spec := ""
		if len(tpl.Spec) > 0 && string(tpl.Spec) != "null" {
			spec = string(tpl.Spec)
		}
		stored = append(stored, runtimev1alpha1.GrantTemplate{
			Name:        tpl.Name,
			PerGPUCount: append([]int32(nil), tpl.PerGPUCount...),
			Spec:        spec,
		})
	}
	out := make(map[string]runtimev1alpha1.GrantRole, len(roles))
	for role, cap := range roles {
		var names []string
		for _, ref := range cap.Templates {
			got, ok := expanded[ref]
			if !ok {
				return nil, nil, nil, opErr(http.StatusBadRequest, "invalid_grant", "role "+role+" references unknown template "+ref)
			}
			names = append(names, got...)
		}
		out[role] = runtimev1alpha1.GrantRole{
			Templates:    names,
			MaxSandboxes: cap.MaxSandboxes,
			MaxGPUs:      cap.MaxGPUs,
		}
	}
	return out, expanded, stored, nil
}

// TemplateNames is the CodeInterpreter name registered for one grant template.
func TemplateNames(appRunID, templateName string, perGPU []int32) []string {
	if len(perGPU) == 0 {
		return []string{templateObjectName(appRunID, templateName, "")}
	}
	names := make([]string, 0, len(perGPU))
	for _, n := range perGPU {
		names = append(names, templateObjectName(appRunID, templateName, "g"+itoa(int(n))))
	}
	return names
}

func expandOne(appRunID string, tpl TemplateRequest) []string {
	return TemplateNames(appRunID, tpl.Name, tpl.PerGPUCount)
}

// templateObjectName builds a DNS-1123 name. Run ids may contain underscores.
func templateObjectName(appRunID, templateName, suffix string) string {
	raw := appRunID + "-" + templateName
	if suffix != "" {
		raw += "-" + suffix
	}
	return dnsName(raw)
}

// dnsName keeps lowercase letters, digits, and hyphens.
func dnsName(value string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(value) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	return strings.Trim(b.String(), "-")
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [12]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func viewOf(g *runtimev1alpha1.SandboxGrant) GrantView {
	state := g.Status.State
	if state == "" {
		state = runtimev1alpha1.GrantStateActive
	}
	return GrantView{
		GrantID:           g.Name,
		State:             state,
		Owner:             g.Spec.Owner,
		Issuer:            g.Spec.Issuer,
		Roles:             g.Spec.Roles,
		GPUHoursBudget:    g.Spec.GPUHoursBudget,
		MaxSandboxSeconds: g.Spec.MaxSandboxSeconds,
		ExpiresAt:         g.Spec.ExpiresAt.Time,
		Usage:             g.Status.Usage,
		GPUSeconds:        g.Status.GPUSeconds,
		Sandboxes:         sandboxViews(g.Status.Sandboxes),
	}
}

// sandboxViews copies sandbox refs for the admin API and omits access-token hashes.
func sandboxViews(in []runtimev1alpha1.GrantSandboxRef) []runtimev1alpha1.GrantSandboxRef {
	if len(in) == 0 {
		return nil
	}
	out := make([]runtimev1alpha1.GrantSandboxRef, len(in))
	for i := range in {
		in[i].DeepCopyInto(&out[i])
		out[i].AccessTokenHash = ""
		out[i].AccessTokenHashes = nil
	}
	return out
}

// specMatches reports whether an existing grant has the same execution spec as
// a retry. Attestation text and the sealed platform key are excluded: the JWT
// is verified on every call, and sealing uses a fresh nonce.
func specMatches(got *runtimev1alpha1.SandboxGrant, want runtimev1alpha1.SandboxGrantSpec) bool {
	if got.Spec.Owner.UserID != want.Owner.UserID || !slices.Equal(got.Spec.Owner.Workspaces, want.Owner.Workspaces) {
		return false
	}
	if got.Spec.Issuer.SessionID != want.Issuer.SessionID || got.Spec.Issuer.AppRunID != want.Issuer.AppRunID {
		return false
	}
	if !sameExpiry(got.Spec.ExpiresAt.Time, want.ExpiresAt.Time) {
		return false
	}
	if got.Spec.GPUHoursBudget != want.GPUHoursBudget || got.Spec.MaxSandboxSeconds != want.MaxSandboxSeconds {
		return false
	}
	return sameRoles(got.Spec.Roles, want.Roles) && sameTemplates(got.Spec.Templates, want.Templates)
}

func sameRoles(got, want map[string]runtimev1alpha1.GrantRole) bool {
	if len(got) != len(want) {
		return false
	}
	for name, role := range want {
		have, ok := got[name]
		if !ok || have.MaxSandboxes != role.MaxSandboxes || have.MaxGPUs != role.MaxGPUs || !slices.Equal(have.Templates, role.Templates) {
			return false
		}
	}
	return true
}

func sameTemplates(got, want []runtimev1alpha1.GrantTemplate) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range want {
		if got[i].Name != want[i].Name ||
			got[i].Spec != want[i].Spec ||
			!slices.Equal(got[i].PerGPUCount, want[i].PerGPUCount) ||
			!slices.Equal(got[i].GPUCounts, want[i].GPUCounts) {
			return false
		}
	}
	return true
}

// expiresAtTime wraps a time for the CR spec.
func expiresAtTime(t time.Time) metav1.Time {
	return metav1.NewTime(t.UTC())
}
