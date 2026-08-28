// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package audit provides structured audit event recording for sandbox lifecycle.
package audit

import (
	"crypto/rand"
	"encoding/hex"
	"time"
)

// Event type constants.
const (
	EventCreated        = "sandbox.created"
	EventReady          = "sandbox.ready"
	EventDeleted        = "sandbox.deleted"
	EventResourceReport = "sandbox.resource_report"
	EventEgress         = "sandbox.egress"
)

// Source constants for log filtering.
const (
	SourceLifecycle = "lifecycle"
	SourceResource  = "resource"
	SourceEgress    = "egress"
)

// Delete reason constants for sandbox.deleted events.
const (
	ReasonUserDelete      = "user_delete"
	ReasonGCTTL           = "gc_ttl"
	ReasonGCIdle          = "gc_idle"
	ReasonShutdownExpired = "shutdown_expired"
)

// AuditEvent is a structured audit record for sandbox lifecycle events.
type AuditEvent struct {
	ID            string            `json:"id"`
	EventType     string            `json:"event_type"`
	Source        string            `json:"source,omitempty"`
	Action        string            `json:"action,omitempty"`
	Reason        string            `json:"reason,omitempty"`
	SessionID     string            `json:"session_id"`
	SandboxName   string            `json:"sandbox_name"`
	Namespace     string            `json:"namespace"`
	UserID        string            `json:"user_id,omitempty"`
	UserName      string            `json:"user_name,omitempty"`
	Timestamp     time.Time         `json:"timestamp"`
	TemplateName  string            `json:"template_name,omitempty"`
	ResourceSpec  *ResourceSpec     `json:"resource_spec,omitempty"`
	DurationMs    int64             `json:"duration_ms,omitempty"`
	TimeToReadyMs int64             `json:"time_to_ready_ms,omitempty"`
	DeleteReason  string            `json:"delete_reason,omitempty"`
	ResourceUsage *ResourceUsage    `json:"resource_usage,omitempty"`
	Egress        *EgressDetails    `json:"egress,omitempty"`
	Metadata      map[string]string `json:"metadata,omitempty"`
}

// ResourceSpec captures the declared resource requests/limits.
type ResourceSpec struct {
	CPURequest    string `json:"cpu_request,omitempty"`
	CPULimit      string `json:"cpu_limit,omitempty"`
	MemoryRequest string `json:"memory_request,omitempty"`
	MemoryLimit   string `json:"memory_limit,omitempty"`
	GPUCount      int    `json:"gpu_count,omitempty"`
	GPUModel      string `json:"gpu_model,omitempty"`
}

// ResourceUsage captures actual cgroup-based resource consumption.
type ResourceUsage struct {
	CPUUsageSeconds  float64 `json:"cpu_usage_seconds"`
	CPUUserSeconds   float64 `json:"cpu_user_seconds"`
	CPUSystemSeconds float64 `json:"cpu_system_seconds"`
	MemoryBytes      int64   `json:"memory_bytes"`
	MemoryPeakBytes  int64   `json:"memory_peak_bytes"`
	MemoryCacheBytes int64   `json:"memory_cache_bytes"`
}

// EgressDetails captures a structured outbound access decision.
type EgressDetails struct {
	Stage      string `json:"stage,omitempty"`
	Domain     string `json:"domain,omitempty"`
	OriginalIP string `json:"original_ip,omitempty"`
	ResolvedIP string `json:"resolved_ip,omitempty"`
	Port       int    `json:"port,omitempty"`
	IsTLS      bool   `json:"is_tls,omitempty"`
}

// NewEventID generates a random hex ID for audit events.
func NewEventID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// NormalizeEvent fills default fields used by storage and query paths.
func NormalizeEvent(event *AuditEvent) {
	if event == nil {
		return
	}
	if event.Timestamp.IsZero() {
		event.Timestamp = time.Now().UTC()
	}
	if event.Source != "" {
		return
	}
	switch event.EventType {
	case EventEgress:
		event.Source = SourceEgress
	case EventResourceReport:
		event.Source = SourceResource
	default:
		event.Source = SourceLifecycle
	}
}
