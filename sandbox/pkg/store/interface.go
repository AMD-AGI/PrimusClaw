// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package store provides the session→sandbox state storage abstraction.
package store

import (
	"context"
	"time"
)

// Kind constants for SandboxInfo.
const (
	SandboxKind         = "Sandbox"
	SandboxClaimKind    = "SandboxClaim"
	CodeInterpreterKind = "CodeInterpreter"
)

// SandboxInfo holds all metadata for a session↔sandbox mapping.
type SandboxInfo struct {
	// Kind indicates the K8s resource kind: "Sandbox" or "SandboxClaim"
	// Used by GC to choose the correct deletion method.
	Kind        string `json:"kind"`
	SessionID   string `json:"session_id"`
	SandboxName string `json:"sandbox_name"`
	Namespace   string `json:"namespace"`
	PodIP       string `json:"pod_ip"`
	PodPort     int    `json:"pod_port"`
	// EntryPoints maps path prefix → "ip:port" for multi-port routing.
	// e.g. {"/": "10.1.2.3:8080", "/metrics": "10.1.2.3:9090"}
	EntryPoints  map[string]string `json:"entry_points,omitempty"`
	CreatedAt    time.Time         `json:"created_at"`
	LastActivity time.Time         `json:"last_activity"`
	ExpiresAt    time.Time         `json:"expires_at"`
	Status       string            `json:"status,omitempty"` // "creating", "running"
	// UserID is the verified user identity (from SaFE API Key auth).
	// Empty when auth is disabled.
	UserID   string `json:"user_id,omitempty"`
	UserName string `json:"user_name,omitempty"`
	// InferenceApiKey is the user's API Key for the unified inference gateway (§4.2).
	// Stored by WM at sandbox creation/claim, pulled by EnvD via policy endpoint,
	// injected into child processes as OPENAI_API_KEY. Empty when inference is disabled.
	InferenceApiKey string `json:"inference_api_key,omitempty"`

	// RuntimePolicy is the name of the ClusterSandboxPolicy applied to this sandbox (§4.1).
	// "agent-default" = external open + internal blocked; "agent-restricted" = whitelist mode.
	RuntimePolicy string `json:"runtime_policy,omitempty"`
	// PolicyMode is "enforce" or "audit". Audit mode logs but does not block.
	PolicyMode string `json:"policy_mode,omitempty"`
	// AllowedEgressHosts is the merged list of external domains this sandbox can access.
	AllowedEgressHosts []string `json:"allowed_egress_hosts,omitempty"`
	// AllowedInternalHosts is the merged list of internal IPs/CIDRs this sandbox can access.
	AllowedInternalHosts []string `json:"allowed_internal_hosts,omitempty"`
	// PolicyVersion is incremented when policy changes, used by EnvD to detect updates.
	PolicyVersion int64 `json:"policy_version,omitempty"`
}

// Store is the session state storage interface.
type Store interface {
	// Ping checks connectivity.
	Ping(ctx context.Context) error

	// GetSandboxBySessionID retrieves sandbox info for a session.
	GetSandboxBySessionID(ctx context.Context, sessionID string) (*SandboxInfo, error)

	// StoreSandbox persists a new sandbox mapping.
	StoreSandbox(ctx context.Context, info *SandboxInfo) error

	// UpdateSandbox updates an existing sandbox mapping.
	UpdateSandbox(ctx context.Context, info *SandboxInfo) error

	// DeleteSandboxBySessionID removes a session mapping.
	DeleteSandboxBySessionID(ctx context.Context, sessionID string) error

	// ListExpiredSandboxes returns sessions whose expiresAt < before.
	ListExpiredSandboxes(ctx context.Context, before time.Time, limit int64) ([]*SandboxInfo, error)

	// ListInactiveSandboxes returns sessions whose lastActivity < before.
	ListInactiveSandboxes(ctx context.Context, before time.Time, limit int64) ([]*SandboxInfo, error)

	// UpdateSessionLastActivity updates the last-activity timestamp.
	//
	// Returns ErrNotFound when the session has no stored record. Callers must
	// not read that as "kept alive": idle-gc reads the timestamp off the record,
	// so a missing one means the refresh had nowhere to land, and treating it as
	// success is how an activity signal is lost without a trace.
	UpdateSessionLastActivity(ctx context.Context, sessionID string, at time.Time) error

	// ListAllSandboxes returns all active sandbox sessions.
	// Used by the sandbox list API for frontend display.
	ListAllSandboxes(ctx context.Context, limit int64) ([]*SandboxInfo, error)

	// Close releases resources.
	Close() error
}
