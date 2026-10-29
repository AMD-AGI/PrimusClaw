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
// Both prefixes serve the same operations. SDK 2.51+ creates and connects on /v2.
// PATCH sets the timeout, the same operation as POST .../timeout.
func (h *Handler) Mount(r gin.IRoutes) {
	for _, prefix := range []string{"/sandboxes", "/v2/sandboxes"} {
		r.POST(prefix, h.create)
		r.GET(prefix, h.list)
		r.GET(prefix+"/:sandboxID/metrics", h.metrics)
		r.GET(prefix+"/:sandboxID/logs", h.logs)
		r.GET(prefix+"/:sandboxID", h.get)
		r.DELETE(prefix+"/:sandboxID", h.kill)
		r.PATCH(prefix+"/:sandboxID", h.timeout)
		r.POST(prefix+"/:sandboxID/connect", h.connect)
		r.POST(prefix+"/:sandboxID/timeout", h.timeout)
	}
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
	if err := applyIdempotencyHeader(&body, c.GetHeader("Idempotency-Key")); err != nil {
		writeErr(c, err)
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
	if resp.NextToken != "" {
		c.Header("X-Next-Token", resp.NextToken)
	}
	// The E2B SDK decodes the list body as a JSON array.
	c.JSON(http.StatusOK, resp.Sandboxes)
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

func (h *Handler) metrics(c *gin.Context) {
	if _, ok := h.ready(c); !ok {
		return
	}
	c.JSON(http.StatusOK, []any{})
}

func (h *Handler) logs(c *gin.Context) {
	if _, ok := h.ready(c); !ok {
		return
	}
	c.JSON(http.StatusOK, gin.H{"logs": []any{}, "logEntries": []any{}})
}

// ready authenticates the caller and requires a running sandbox.
func (h *Handler) ready(c *gin.Context) (string, bool) {
	key, ok := apiKey(c)
	if !ok {
		return "", false
	}
	if _, err := h.svc.Get(c.Request.Context(), key, c.Param("sandboxID")); err != nil {
		writeErr(c, err)
		return "", false
	}
	return key, true
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
		c.JSON(oe.Status, gin.H{"code": oe.Status, "reason": oe.Reason, "error_code": oe.Reason, "message": oe.Message()})
		return
	}
	c.JSON(http.StatusInternalServerError, gin.H{
		"code":    http.StatusInternalServerError,
		"reason":  "internal",
		"message": "internal: sandbox request failed",
	})
}
