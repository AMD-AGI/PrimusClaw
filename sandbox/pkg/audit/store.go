// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package audit

import (
	"context"
	"time"
)

// AuditStore persists and queries audit events.
// Implementations must be safe for concurrent use.
type AuditStore interface {
	// Store persists an audit event.
	Store(ctx context.Context, event *AuditEvent) error

	// QueryBySession returns all events for a session, ordered by time.
	QueryBySession(ctx context.Context, sessionID string) ([]*AuditEvent, error)

	// QueryByTimeRange returns events within [start, end) with filtering and pagination.
	QueryByTimeRange(ctx context.Context, start, end time.Time, opts QueryOptions) (*QueryResult, error)

	// DeleteBefore removes events older than the cutoff (retention cleanup).
	DeleteBefore(ctx context.Context, before time.Time) (int64, error)
}

// QueryOptions controls filtering and pagination for time-range queries.
type QueryOptions struct {
	UserID    string
	EventType string
	Source    string
	Limit     int64
	Offset    int64
}

// QueryResult wraps paginated audit query results.
type QueryResult struct {
	Total  int64         `json:"total"`
	Events []*AuditEvent `json:"events"`
}
