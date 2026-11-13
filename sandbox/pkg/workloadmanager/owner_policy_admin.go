// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"encoding/json"
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

// OwnerPolicyTemplateRequest is the body of PUT /v1/admin/owner-policy/templates/{name}.
type OwnerPolicyTemplateRequest struct {
	Name        string          `json:"name,omitempty"`
	PerGPUCount []int32         `json:"perGpuCount"`
	Spec        json.RawMessage `json:"spec"`
}

// WithOwnerPolicyStore serves the owner policy template API from store.
// Every route requires caller auth and the system-admin role.
func (s *Server) WithOwnerPolicyStore(store *grant.OwnerPolicyStore) *Server {
	if store == nil || s.router == nil {
		return s
	}
	g := s.router.Group(ownerPolicyTemplatesPath, s.loggingMiddleware())
	if s.cfg.EnableAuth {
		g.Use(s.callerAuthMiddleware())
	}
	g.Use(s.requireVerifiedSystemAdmin())
	h := ownerPolicyHandler{store: store}
	g.GET("", h.list)
	g.GET("/:name", h.get)
	g.PUT("/:name", h.put)
	g.DELETE("/:name", h.delete)
	return s
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

type ownerPolicyHandler struct {
	store *grant.OwnerPolicyStore
}

// list returns every template of the owner policy.
func (h ownerPolicyHandler) list(c *gin.Context) {
	templates, err := h.store.Templates(c.Request.Context())
	if err != nil {
		writeOwnerPolicyErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"templates": templates})
}

// get returns one template of the owner policy.
func (h ownerPolicyHandler) get(c *gin.Context) {
	templates, err := h.store.Templates(c.Request.Context())
	if err != nil {
		writeOwnerPolicyErr(c, err)
		return
	}
	for _, tpl := range templates {
		if tpl.Name == c.Param("name") {
			c.JSON(http.StatusOK, tpl)
			return
		}
	}
	c.JSON(http.StatusNotFound, gin.H{"error": "template not found: " + c.Param("name"), "code": "template_not_found"})
}

// put adds or replaces one template and applies the new policy.
func (h ownerPolicyHandler) put(c *gin.Context) {
	var req OwnerPolicyTemplateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request: " + err.Error(), "code": "invalid_template"})
		return
	}
	name := c.Param("name")
	if req.Name != "" && req.Name != name {
		c.JSON(http.StatusBadRequest, gin.H{"error": "body name differs from path name", "code": "invalid_template"})
		return
	}
	tpl := grant.TemplateRequest{Name: name, PerGPUCount: req.PerGPUCount, Spec: req.Spec}
	if err := h.store.PutTemplate(c.Request.Context(), tpl); err != nil {
		writeOwnerPolicyErr(c, err)
		return
	}
	log.Info("owner policy template stored", "template", name, "userId", currentUserID(c))
	c.JSON(http.StatusOK, tpl)
}

// delete removes one template and applies the new policy.
func (h ownerPolicyHandler) delete(c *gin.Context) {
	name := c.Param("name")
	if err := h.store.DeleteTemplate(c.Request.Context(), name); err != nil {
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
