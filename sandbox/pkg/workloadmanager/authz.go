// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Authorization helpers for Workload Manager.
// Implements role-based access control (RBAC) on control-plane endpoints
// based on SaFE user roles (system-admin / system-admin-readonly / default).
//
// Router data-plane invocation enforces the same owner/full-admin boundary.
package workloadmanager

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"k8s.io/apimachinery/pkg/util/validation"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/grant"
	log "sigs.k8s.io/agent-sandbox/pkg/logx"
)

// ─── SaFE Role Constants ─────────────────────────────────────────────────────

const (
	// RoleSystemAdmin has full control over all resources.
	RoleSystemAdmin = "system-admin"
	// RoleSystemAdminReadonly can view all resources but can only modify/delete own resources.
	RoleSystemAdminReadonly = "system-admin-readonly"
	// RoleDefault can only access own resources + public templates.
	RoleDefault = "default"
)

// ─── Header Constants ────────────────────────────────────────────────────────

const (
	// UserRoleHeader carries the resolved role from Router to WM.
	UserRoleHeader = "userRole"
)

// ─── Template Label Constants ────────────────────────────────────────────────

const (
	// templatePublicLabelKey marks a template as publicly visible/usable.
	// Value "true" means public; absent means private.
	templatePublicLabelKey = grant.TemplatePublicLabel
)

// ─── Role Resolution ─────────────────────────────────────────────────────────

// resolveRole returns the effective role for the current request.
// Priority: system-admin > system-admin-readonly > default.
// When auth is disabled (no userId), returns system-admin (full access, no restrictions).
func resolveRole(c *gin.Context) string {
	uid := c.GetHeader(UserIDHeader)
	if uid == "" {
		return RoleSystemAdmin // auth disabled → full access
	}
	// Try header first (set by Router when proxying to WM)
	role := c.GetHeader(UserRoleHeader)
	if role == "" {
		// Fallback to Gin context (set by local auth middleware)
		if v, exists := c.Get("userRole"); exists {
			role, _ = v.(string)
		}
	}
	if role == "" {
		return RoleDefault
	}
	return role
}

// ─── Permission Checks ──────────────────────────────────────────────────────

// canViewAll returns true if the user can view all resources (system-admin or system-admin-readonly).
func canViewAll(c *gin.Context) bool {
	role := resolveRole(c)
	return role == RoleSystemAdmin || role == RoleSystemAdminReadonly
}

// canWriteAll returns true if the user can modify/delete any resource (system-admin only).
func canWriteAll(c *gin.Context) bool {
	return resolveRole(c) == RoleSystemAdmin
}

// currentUserID returns the authenticated user ID from the request.
// Returns empty string when auth is disabled.
func currentUserID(c *gin.Context) string {
	return c.GetHeader(UserIDHeader)
}

// canMutateSandbox allows the owner or a full system-admin. In no-auth mode
// currentUserID is empty and the deployment intentionally has no tenant
// boundary. An authenticated legacy sandbox with no owner fails closed.
func canMutateSandbox(c *gin.Context, ownerUserID string) bool {
	uid := currentUserID(c)
	if uid == "" {
		return true
	}
	if canWriteAll(c) {
		return true
	}
	return ownerUserID != "" && ownerUserID == uid
}

// ─── Template Permission Checks ─────────────────────────────────────────────

// isOwnerOfTemplate checks if the current user created the template.
func isOwnerOfTemplate(c *gin.Context, ci *runtimev1alpha1.CodeInterpreter) bool {
	uid := currentUserID(c)
	if uid == "" {
		return false
	}
	if ci.Labels == nil {
		return false
	}
	return ci.Labels[userIDLabelKey] == uid
}

// isTemplatePublic checks if the template is marked as public.
func isTemplatePublic(ci *runtimev1alpha1.CodeInterpreter) bool {
	if ci.Labels == nil {
		return false
	}
	return ci.Labels[templatePublicLabelKey] == "true"
}

// isTemplateReadable checks if the current user can read/use this template.
// Readable if: admin (canViewAll) OR owner OR public.
func isTemplateReadable(c *gin.Context, ci *runtimev1alpha1.CodeInterpreter) bool {
	if canViewAll(c) {
		return true
	}
	if isOwnerOfTemplate(c, ci) {
		return true
	}
	return isTemplatePublic(ci)
}

// verifiedNonAdmin reports whether caller auth is on and the caller is not system-admin.
func (s *Server) verifiedNonAdmin(c *gin.Context) bool {
	return s.cfg.EnableAuth && !canWriteAll(c)
}

// writeMembershipErr answers a membership failure: the OpError status, else 503.
func writeMembershipErr(c *gin.Context, err error) {
	var oe *grant.OpError
	if errors.As(err, &oe) {
		c.JSON(oe.Status, gin.H{"error": oe.Error(), "code": oe.Reason})
		return
	}
	log.Warn("template workspace check failed", "userId", currentUserID(c), "error", err)
	c.JSON(http.StatusServiceUnavailable, gin.H{"error": "workspace membership is temporarily unreadable", "code": "membership_unavailable"})
}

// admitTemplateWorkspace answers 403 unless a verified non-admin caller belongs
// to workspace, and 503 when membership cannot be read. Without caller auth the
// identity is unverified and no check is made.
func (s *Server) admitTemplateWorkspace(c *gin.Context, workspace string) bool {
	if !s.verifiedNonAdmin(c) {
		return true
	}
	if s.templateMembership == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "workspace membership is not configured", "code": "membership_unavailable"})
		return false
	}
	if err := s.templateMembership.Check(c.Request.Context(), currentUserID(c), []string{workspace}); err != nil {
		writeMembershipErr(c, err)
		return false
	}
	return true
}

// onlyWorkspace returns the only workspace of the caller. It answers 400 when
// the caller has several workspaces, 403 when it has none, and 503 when its
// User cannot be read.
func (s *Server) onlyWorkspace(c *gin.Context) (string, bool) {
	reader, ok := s.templateMembership.(grant.UserReader)
	if !ok {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "workspace membership is not configured", "code": "membership_unavailable"})
		return "", false
	}
	user, err := reader.ReadUser(c.Request.Context(), currentUserID(c))
	if err != nil {
		writeMembershipErr(c, err)
		return "", false
	}
	switch {
	case !user.Found || len(user.Workspaces) == 0:
		c.JSON(http.StatusForbidden, gin.H{"error": "the caller has no workspace", "code": "user_not_in_workspace"})
		return "", false
	case len(user.Workspaces) > 1:
		c.JSON(http.StatusBadRequest, gin.H{"error": "set workspace to one of the caller's workspaces", "code": "workspace_required"})
		return "", false
	}
	return user.Workspaces[0], true
}

// templateTarget returns the namespace and workspace a template create is
// stored under. A template with a workspace goes to the control-plane
// namespace; a verified non-admin caller must name, or default to, one of its
// workspaces. Without a workspace the request namespace is used, "default"
// when empty.
func (s *Server) templateTarget(c *gin.Context, req *CreateTemplateRequest) (string, string, bool) {
	workspace := strings.TrimSpace(req.Workspace)
	if s.verifiedNonAdmin(c) {
		if req.Namespace != "" && req.Namespace != s.cfg.Namespace {
			c.JSON(http.StatusBadRequest, gin.H{"error": "a template is stored per workspace; set workspace instead of namespace", "code": "invalid_request"})
			return "", "", false
		}
		if workspace == "" {
			ws, ok := s.onlyWorkspace(c)
			if !ok {
				return "", "", false
			}
			workspace = ws
		} else if !s.admitTemplateWorkspace(c, workspace) {
			return "", "", false
		}
	}
	if workspace == "" {
		if req.Namespace == "" {
			return "default", "", true
		}
		return req.Namespace, "", true
	}
	if errs := validation.IsDNS1123Label(workspace); len(errs) > 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "workspace " + strconv.Quote(workspace) + " is not a namespace name", "code": "invalid_request"})
		return "", "", false
	}
	if strings.HasPrefix(req.Name, grant.ReservedTemplatePrefix) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "template names starting with " + grant.ReservedTemplatePrefix + " are reserved", "code": "template_name_reserved"})
		return "", "", false
	}
	if s.cfg.Namespace == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "workspace templates need the control-plane namespace", "code": "workspace_templates_unavailable"})
		return "", "", false
	}
	return s.cfg.Namespace, workspace, true
}

// admitSandboxNamespace answers 403 when a verified non-admin caller creates a
// sandbox in the control-plane namespace.
func (s *Server) admitSandboxNamespace(c *gin.Context, namespace string) bool {
	if !s.verifiedNonAdmin(c) || s.cfg.Namespace == "" || namespace != s.cfg.Namespace {
		return true
	}
	c.JSON(http.StatusForbidden, gin.H{"error": "only system-admin can create a sandbox in the control-plane namespace " + strconv.Quote(namespace), "code": "control_plane_namespace"})
	return false
}

// deniedTemplateField returns the first spec field a non-admin caller may not
// set: volumes other than emptyDir, env vars from a source, sidecars, image
// pull secrets, runtime class, pod labels and annotations, a non-default auth
// mode or runtime policy, internal hosts, and a warm pool on a workspace
// template. It returns "" when the spec has none.
func deniedTemplateField(spec runtimev1alpha1.CodeInterpreterSpec, workspace bool) string {
	switch {
	case spec.AuthMode != "" && spec.AuthMode != runtimev1alpha1.AuthModeEnvD:
		return "spec.authMode"
	case spec.RuntimePolicy != "" && spec.RuntimePolicy != "agent-default":
		return "spec.runtimePolicy"
	case len(spec.AllowedInternalHosts) > 0:
		return "spec.allowedInternalHosts"
	case workspace && spec.WarmPoolSize != nil && *spec.WarmPoolSize > 0:
		return "spec.warmPoolSize"
	}
	tmpl := spec.Template
	if tmpl == nil {
		return ""
	}
	for _, vol := range tmpl.Volumes {
		if vol.EmptyDir == nil {
			return "spec.template.volumes[" + vol.Name + "]"
		}
	}
	for _, env := range tmpl.Environment {
		if env.ValueFrom != nil {
			return "spec.template.environment[" + env.Name + "].valueFrom"
		}
	}
	switch {
	case len(tmpl.Sidecars) > 0:
		return "spec.template.sidecars"
	case len(tmpl.ImagePullSecrets) > 0:
		return "spec.template.imagePullSecrets"
	case tmpl.RuntimeClassName != nil:
		return "spec.template.runtimeClassName"
	case len(tmpl.Labels) > 0:
		return "spec.template.labels"
	case len(tmpl.Annotations) > 0:
		return "spec.template.annotations"
	}
	return ""
}

// admitTemplateFields answers 400 when a verified non-admin caller sets a
// field deniedTemplateField reports.
func (s *Server) admitTemplateFields(c *gin.Context, spec runtimev1alpha1.CodeInterpreterSpec, workspace bool) bool {
	if !s.verifiedNonAdmin(c) {
		return true
	}
	if field := deniedTemplateField(spec, workspace); field != "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": field + " needs system-admin", "code": "template_field_not_allowed"})
		return false
	}
	return true
}

// isTemplateWritable checks if the current user can update/delete this template.
// Writable if: system-admin (canWriteAll) OR owner of a private template.
func isTemplateWritable(c *gin.Context, ci *runtimev1alpha1.CodeInterpreter) bool {
	if canWriteAll(c) {
		return true
	}
	return !isTemplatePublic(ci) && isOwnerOfTemplate(c, ci)
}
