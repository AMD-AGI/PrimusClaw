// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Authorization helpers for Workload Manager.
// Implements role-based access control (RBAC) on control-plane endpoints
// based on SaFE user roles (system-admin / system-admin-readonly / default).
//
// Router data-plane invocation enforces the same owner/full-admin boundary.
package workloadmanager

import (
	"github.com/gin-gonic/gin"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
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
	templatePublicLabelKey = "runtime.agent-sandbox.io/public"
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

// resolveRoleFromSaFERoles picks the highest-priority role from SaFE roles array.
// Priority: system-admin > system-admin-readonly > default.
func resolveRoleFromSaFERoles(roles []string) string {
	best := RoleDefault
	for _, r := range roles {
		switch r {
		case RoleSystemAdmin:
			return RoleSystemAdmin // highest, return immediately
		case RoleSystemAdminReadonly:
			best = RoleSystemAdminReadonly
		}
	}
	return best
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

// isTemplateWritable checks if the current user can update/delete this template.
// Writable if: system-admin (canWriteAll) OR owner.
func isTemplateWritable(c *gin.Context, ci *runtimev1alpha1.CodeInterpreter) bool {
	if canWriteAll(c) {
		return true
	}
	return isOwnerOfTemplate(c, ci)
}
