// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package e2b

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"sigs.k8s.io/agent-sandbox/pkg/grant"
)

// Handler serves the E2B sandbox routes.
type Handler struct {
	svc *Service
}

// NewHandler returns HTTP handlers for svc.
func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

// Mount registers the E2B routes on the engine root.
func (h *Handler) Mount(r gin.IRoutes) {
	r.POST("/sandboxes", h.create)
	r.GET("/sandboxes", h.list)
	r.GET("/v2/sandboxes", h.list)
	r.GET("/sandboxes/:sandboxID", h.get)
	r.DELETE("/sandboxes/:sandboxID", h.kill)
	r.POST("/sandboxes/:sandboxID/connect", h.connect)
	r.POST("/sandboxes/:sandboxID/timeout", h.timeout)
}

func (h *Handler) create(c *gin.Context) {
	key, ok := apiKey(c)
	if !ok {
		return
	}
	var body CreateBody
	if err := c.ShouldBindJSON(&body); err != nil {
		writeErr(c, grant.Op(http.StatusBadRequest, "invalid_sandbox", "request body is not valid JSON"))
		return
	}
	resp, status, err := h.svc.Create(c.Request.Context(), key, body)
	if err != nil {
		writeErr(c, err)
		return
	}
	c.JSON(status, resp)
}

func (h *Handler) get(c *gin.Context) {
	key, ok := apiKey(c)
	if !ok {
		return
	}
	resp, err := h.svc.Get(c.Request.Context(), key, c.Param("sandboxID"))
	if err != nil {
		writeErr(c, err)
		return
	}
	c.JSON(http.StatusOK, resp)
}

func (h *Handler) list(c *gin.Context) {
	key, ok := apiKey(c)
	if !ok {
		return
	}
	limit := 0
	if raw := c.Query("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 {
			writeErr(c, grant.Op(http.StatusBadRequest, "invalid_sandbox", "limit must be >= 0"))
			return
		}
		limit = n
	}
	resp, err := h.svc.List(c.Request.Context(), key, c.Query("metadata"), c.Query("state"), c.Query("nextToken"), limit)
	if err != nil {
		writeErr(c, err)
		return
	}
	c.JSON(http.StatusOK, resp)
}

func (h *Handler) kill(c *gin.Context) {
	key, ok := apiKey(c)
	if !ok {
		return
	}
	if err := h.svc.Kill(c.Request.Context(), key, c.Param("sandboxID")); err != nil {
		writeErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *Handler) connect(c *gin.Context) {
	key, ok := apiKey(c)
	if !ok {
		return
	}
	resp, err := h.svc.Connect(c.Request.Context(), key, c.Param("sandboxID"))
	if err != nil {
		writeErr(c, err)
		return
	}
	c.JSON(http.StatusOK, resp)
}

func (h *Handler) timeout(c *gin.Context) {
	key, ok := apiKey(c)
	if !ok {
		return
	}
	var body struct {
		Timeout int64 `json:"timeout"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		writeErr(c, grant.Op(http.StatusBadRequest, "invalid_sandbox", "request body is not valid JSON"))
		return
	}
	if err := h.svc.Timeout(c.Request.Context(), key, c.Param("sandboxID"), body.Timeout); err != nil {
		writeErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func apiKey(c *gin.Context) (string, bool) {
	key := c.GetHeader("X-API-KEY")
	if key == "" {
		writeErr(c, grant.Op(http.StatusUnauthorized, "invalid_key", "X-API-KEY is required"))
		return "", false
	}
	return key, true
}

func writeErr(c *gin.Context, err error) {
	var oe *grant.OpError
	if errors.As(err, &oe) {
		c.JSON(oe.Status, gin.H{"code": oe.Status, "reason": oe.Reason, "message": oe.Message()})
		return
	}
	c.JSON(http.StatusInternalServerError, gin.H{
		"code":    http.StatusInternalServerError,
		"reason":  "internal",
		"message": "internal: sandbox request failed",
	})
}
