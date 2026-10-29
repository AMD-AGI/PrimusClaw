// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// revokeWait is how long DELETE waits for sandbox reclaim before answering.
const revokeWait = 60 * time.Second

// Handler serves the grant admin API.
type Handler struct {
	svc *Service
}

// NewHandler returns HTTP handlers for svc.
func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

// Mount registers the grant routes on g. g's prefix is /internal/v1/grants.
func (h *Handler) Mount(g *gin.RouterGroup) {
	g.POST("", h.issue)
	g.GET("/:grantId", h.get)
	g.DELETE("/:grantId", h.revoke)
	g.PATCH("/:grantId", h.extend)
}

func (h *Handler) issue(c *gin.Context) {
	if err := h.auth(c); err != nil {
		writeErr(c, err)
		return
	}
	var req IssueRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		writeErr(c, opErr(http.StatusBadRequest, "invalid_grant", "request body is not valid JSON"))
		return
	}
	resp, status, err := h.svc.Issue(c.Request.Context(), req)
	if err != nil {
		writeErr(c, err)
		return
	}
	c.JSON(status, resp)
}

func (h *Handler) get(c *gin.Context) {
	if err := h.auth(c); err != nil {
		writeErr(c, err)
		return
	}
	view, err := h.svc.Get(c.Request.Context(), c.Param("grantId"))
	if err != nil {
		writeErr(c, err)
		return
	}
	c.JSON(http.StatusOK, view)
}

func (h *Handler) revoke(c *gin.Context) {
	if err := h.auth(c); err != nil {
		writeErr(c, err)
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), revokeWait)
	defer cancel()
	resp, err := h.svc.Revoke(ctx, c.Param("grantId"))
	if err != nil {
		writeErr(c, err)
		return
	}
	c.JSON(http.StatusOK, resp)
}

func (h *Handler) extend(c *gin.Context) {
	if err := h.auth(c); err != nil {
		writeErr(c, err)
		return
	}
	var req ExtendRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		writeErr(c, opErr(http.StatusBadRequest, "invalid_grant", "request body is not valid JSON"))
		return
	}
	view, err := h.svc.Extend(c.Request.Context(), c.Param("grantId"), req)
	if err != nil {
		writeErr(c, err)
		return
	}
	c.JSON(http.StatusOK, view)
}

func (h *Handler) auth(c *gin.Context) error {
	header := c.GetHeader("Authorization")
	if header == "" {
		header = c.GetHeader("X-Forwarded-Authorization")
	}
	return h.svc.Authenticate(c.Request.Context(), header)
}

func writeErr(c *gin.Context, err error) {
	var oe *OpError
	if errors.As(err, &oe) {
		c.JSON(oe.Status, gin.H{"code": oe.Status, "reason": oe.Reason, "message": oe.Message()})
		return
	}
	c.JSON(http.StatusInternalServerError, gin.H{
		"code":    http.StatusInternalServerError,
		"reason":  "internal",
		"message": "internal: grant request failed",
	})
}
