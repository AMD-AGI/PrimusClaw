// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	apierrors "k8s.io/apimachinery/pkg/api/errors"

	"sigs.k8s.io/agent-sandbox/pkg/grant"
	log "sigs.k8s.io/agent-sandbox/pkg/logx"
)

// ownerPolicyTemplatesPath serves the templates of the owner policy: the
// templates identity keys may create sandboxes from.
const ownerPolicyTemplatesPath = "/v1/admin/owner-policy/templates"

// WithOwnerPolicyStore attaches the store behind the owner policy template API.
// Without a store the API answers 404.
func (s *Server) WithOwnerPolicyStore(store *grant.OwnerPolicyStore) *Server {
	s.ownerPolicy = store
	return s
}

// mountOwnerPolicyRoutes registers the owner policy template API on g, a
// group under /v1. Every route requires caller auth and the system-admin role.
func (s *Server) mountOwnerPolicyRoutes(g *gin.RouterGroup) {
	g.Use(s.requireOwnerPolicyStore(), s.requireVerifiedSystemAdmin())
	g.GET("", s.handleOwnerPolicyList)
	g.GET("/:name", s.handleOwnerPolicyGet)
	g.PUT("/:name", s.handleOwnerPolicyPut)
	g.DELETE("/:name", s.handleOwnerPolicyDelete)
}

// requireOwnerPolicyStore answers 404 when no owner policy store is attached.
func (s *Server) requireOwnerPolicyStore() gin.HandlerFunc {
	return func(c *gin.Context) {
		if s.ownerPolicy == nil {
			c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "owner policy API is not configured", "code": "owner_policy_api_disabled"})
			return
		}
		c.Next()
	}
}

// requireVerifiedSystemAdmin answers 403 unless caller auth is enabled and the
// verified caller is a full system-admin. Without caller auth the role is not verified.
func (s *Server) requireVerifiedSystemAdmin() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !s.cfg.EnableAuth || currentUserID(c) == "" || resolveRole(c) != RoleSystemAdmin {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "only an authenticated system-admin can manage the owner policy"})
			return
		}
		c.Next()
	}
}

// handleOwnerPolicyList returns every stored template and whether this replica applied them.
func (s *Server) handleOwnerPolicyList(c *gin.Context) {
	out, err := s.ownerPolicy.Templates(c.Request.Context())
	if err != nil {
		writeOwnerPolicyErr(c, err)
		return
	}
	c.JSON(http.StatusOK, out)
}

// handleOwnerPolicyGet returns one stored template.
func (s *Server) handleOwnerPolicyGet(c *gin.Context) {
	out, err := s.ownerPolicy.Templates(c.Request.Context())
	if err != nil {
		writeOwnerPolicyErr(c, err)
		return
	}
	for _, tpl := range out.Templates {
		if tpl.Name == c.Param("name") {
			c.JSON(http.StatusOK, tpl)
			return
		}
	}
	c.JSON(http.StatusNotFound, gin.H{"error": "template not found: " + c.Param("name"), "code": "template_not_found"})
}

// handleOwnerPolicyPut adds or replaces one template, then applies the stored policy.
// The name comes from the path; a body name must match it.
func (s *Server) handleOwnerPolicyPut(c *gin.Context) {
	var tpl grant.TemplateRequest
	if err := c.ShouldBindJSON(&tpl); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request: " + err.Error(), "code": "invalid_template"})
		return
	}
	name := c.Param("name")
	if tpl.Name != "" && tpl.Name != name {
		c.JSON(http.StatusBadRequest, gin.H{"error": "body name differs from path name", "code": "invalid_template"})
		return
	}
	tpl.Name = name
	if err := s.ownerPolicy.PutTemplate(c.Request.Context(), tpl); err != nil {
		writeOwnerPolicyErr(c, err)
		return
	}
	log.Info("owner policy template stored", "template", name, "userId", currentUserID(c))
	c.JSON(http.StatusOK, tpl)
}

// handleOwnerPolicyDelete removes one template, then applies the stored policy.
func (s *Server) handleOwnerPolicyDelete(c *gin.Context) {
	name := c.Param("name")
	if err := s.ownerPolicy.DeleteTemplate(c.Request.Context(), name); err != nil {
		writeOwnerPolicyErr(c, err)
		return
	}
	log.Info("owner policy template deleted", "template", name, "userId", currentUserID(c))
	c.Status(http.StatusNoContent)
}

// writeOwnerPolicyErr maps a store error to the HTTP answer.
func writeOwnerPolicyErr(c *gin.Context, err error) {
	var op *grant.OpError
	switch {
	case errors.As(err, &op):
		c.JSON(op.Status, gin.H{"error": op.Message(), "code": op.Reason})
	case apierrors.IsConflict(err):
		c.JSON(http.StatusConflict, gin.H{"error": "owner policy changed concurrently, retry", "code": "owner_policy_conflict"})
	default:
		log.Warn("owner policy write failed", "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "owner policy write failed", "code": "owner_policy_write_failed"})
	}
}
