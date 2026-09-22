// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"sigs.k8s.io/agent-sandbox/pkg/audit"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

type sessionLogsResponse struct {
	TotalCount int                 `json:"totalCount"`
	Items      []*audit.AuditEvent `json:"items"`
}

type internalAuditRequest struct {
	EventType string               `json:"eventType,omitempty"`
	Source    string               `json:"source,omitempty"`
	Action    string               `json:"action,omitempty"`
	Reason    string               `json:"reason,omitempty"`
	Egress    *audit.EgressDetails `json:"egress,omitempty"`
	Metadata  map[string]string    `json:"metadata,omitempty"`
}

func (s *Server) handleGetLogs(c *gin.Context) {
	if s.auditStore == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "audit logging is not enabled"})
		return
	}

	_, _, sessionID, ok := pathSandboxRef(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "namespace and name are required"})
		return
	}

	info, err := s.store.GetSandboxBySessionID(c.Request.Context(), sessionID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}
	if !s.admitSession(c, info) {
		return
	}

	if !canViewAll(c) {
		if uid := currentUserID(c); uid != "" && info.UserID != uid {
			c.JSON(http.StatusForbidden, gin.H{"error": "you can only view your own sandbox logs"})
			return
		}
	}

	events, err := s.auditStore.QueryBySession(c.Request.Context(), sessionID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to query logs: " + err.Error()})
		return
	}

	sourceFilter := c.Query("source")
	eventTypeFilter := c.Query("eventType")
	limit := parsePositiveInt(c.Query("limit"), 100, 1000)
	offset := parsePositiveInt(c.Query("offset"), 0, 1<<31-1)

	filtered := make([]*audit.AuditEvent, 0, len(events))
	for i := len(events) - 1; i >= 0; i-- {
		event := events[i]
		if sourceFilter != "" && event.Source != sourceFilter {
			continue
		}
		if eventTypeFilter != "" && event.EventType != eventTypeFilter {
			continue
		}
		filtered = append(filtered, event)
	}

	totalCount := len(filtered)
	if offset > totalCount {
		offset = totalCount
	}
	end := offset + limit
	if end > totalCount {
		end = totalCount
	}

	c.JSON(http.StatusOK, sessionLogsResponse{
		TotalCount: totalCount,
		Items:      filtered[offset:end],
	})
}

func (s *Server) handleInternalAudit(c *gin.Context) {
	if s.auditStore == nil {
		c.Status(http.StatusAccepted)
		return
	}

	sessionID := c.Param("sessionId")
	if sessionID == "" {
		_, _, sessionID, _ = pathSandboxRef(c)
	}
	if sessionID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "namespace and name are required"})
		return
	}

	var req internalAuditRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request: " + err.Error()})
		return
	}

	info, err := s.store.GetSandboxBySessionID(c.Request.Context(), sessionID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to query session"})
		}
		return
	}

	eventType := req.EventType
	if eventType == "" {
		eventType = audit.EventEgress
	}

	s.emitAudit(c.Request.Context(), &audit.AuditEvent{
		ID:          audit.NewEventID(),
		EventType:   eventType,
		Source:      req.Source,
		Action:      req.Action,
		Reason:      req.Reason,
		SessionID:   sessionID,
		SandboxName: info.SandboxName,
		Namespace:   info.Namespace,
		UserID:      info.UserID,
		UserName:    info.UserName,
		Timestamp:   observedTimestamp(req.Metadata, time.Now().UTC(), info.CreatedAt),
		Egress:      req.Egress,
		Metadata:    req.Metadata,
	})

	c.Status(http.StatusAccepted)
}

// maxAuditBackdate is how far before its arrival a reported event may always
// be stamped; an event may also go back to its sandbox's creation.
const maxAuditBackdate = 24 * time.Hour

// observedTimestamp is when the reporter observed an internal audit event:
// envd holds events while it has no token WM accepts, and the audit index is
// ordered by this time. A missing, unparsable or future value, or one older
// than both the sandbox's creation and maxAuditBackdate, falls back to now,
// the arrival time.
func observedTimestamp(metadata map[string]string, now, created time.Time) time.Time {
	observed, err := time.Parse(time.RFC3339Nano, metadata[audit.MetadataObservedAt])
	if err != nil || observed.After(now) {
		return now
	}
	earliest := now.Add(-maxAuditBackdate)
	if !created.IsZero() && created.Before(earliest) {
		earliest = created
	}
	if observed.Before(earliest) {
		return now
	}
	return observed.UTC()
}

func parsePositiveInt(raw string, defaultValue int, maxValue int) int {
	if raw == "" {
		return defaultValue
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 0 {
		return defaultValue
	}
	if value > maxValue {
		return maxValue
	}
	return value
}
