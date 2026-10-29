// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
	// SandboxGrantKind is the Kind of a sandbox grant execution record.
	SandboxGrantKind = "SandboxGrant"

	// GrantStateActive means new sandboxes may still be created under the grant.
	GrantStateActive = "active"
	// GrantStateRevoked means Claw withdrew the grant. Keys must fail immediately.
	GrantStateRevoked = "revoked"
	// GrantStateExpired means the grant reached expiresAt and was reclaimed.
	GrantStateExpired = "expired"

	// AnnGrantKeyHashes maps each role to the hex SHA-256 of its E2B key.
	// The key itself is returned once at issue time and is not stored.
	AnnGrantKeyHashes = "agent-sandbox.io/key-hashes"

	// SandboxPending is a sandbox charged to a grant and not yet running.
	SandboxPending = "pending"
	// SandboxRunning is a sandbox whose data plane can be used.
	SandboxRunning = "running"
	// SandboxEnded is a sandbox that no longer counts against quota.
	// The ref stays so an idempotency key can still be resolved.
	SandboxEnded = "ended"
)

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced,shortName=sbg
// +kubebuilder:printcolumn:name="State",type=string,JSONPath=`.status.state`
// +kubebuilder:printcolumn:name="User",type=string,JSONPath=`.spec.owner.userId`
// +kubebuilder:printcolumn:name="Expires",type=date,JSONPath=`.spec.expiresAt`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// SandboxGrant is Agent Sandbox's execution copy of a grant Claw issued.
// Claw keeps the authority (the decision, the keys, the signed attestation).
// This object exists so create, quota, and reclaim keep working while Claw
// is down. Losing it fails closed: every key under it stops working and Claw
// reissues from its own record.
type SandboxGrant struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   SandboxGrantSpec   `json:"spec"`
	Status SandboxGrantStatus `json:"status,omitempty"`
}

// SandboxGrantSpec is the issued grant. Quota counters live in status so
// concurrent creates can update them with resourceVersion.
type SandboxGrantSpec struct {
	// Owner is the user and workspaces the grant may spend.
	Owner GrantOwner `json:"owner"`
	// Issuer identifies the Claw session and app run that issued the grant.
	Issuer GrantIssuer `json:"issuer"`
	// Roles maps a role name (measurement, subrun, dev) to its template
	// allow-list and concurrency caps. Template names here are the expanded
	// names, after per-GPU variants are applied.
	Roles map[string]GrantRole `json:"roles"`
	// Templates is the run-level template set Claw submitted. Kept on the
	// grant until CodeInterpreter grows the safe-workload fields.
	// +optional
	Templates []GrantTemplate `json:"templates,omitempty"`
	// GPUHoursBudget is the GPU-hour cap for the whole grant. Zero means no cap.
	// +optional
	GPUHoursBudget float64 `json:"gpuHoursBudget,omitempty"`
	// MaxSandboxSeconds caps a single sandbox lifetime. Zero means no extra cap.
	// +optional
	MaxSandboxSeconds int64 `json:"maxSandboxSeconds,omitempty"`
	// ExpiresAt is when the grant stops accepting creates.
	ExpiresAt metav1.Time `json:"expiresAt"`
	// Attestation is the Claw-signed JWT copied onto each Workload.
	Attestation string `json:"attestation"`
	// PlatformKeyCiphertext is the AES-GCM ciphertext of the delegated user
	// platform key. Empty after revoke. The plaintext is never stored.
	// +optional
	PlatformKeyCiphertext string `json:"platformKeyCiphertext,omitempty"`
}

// GrantOwner is the user the grant spends as.
type GrantOwner struct {
	UserID     string   `json:"userId"`
	UserName   string   `json:"userName,omitempty"`
	Workspaces []string `json:"workspaces"`
}

// GrantIssuer is the Claw session that issued the grant.
type GrantIssuer struct {
	SessionID string `json:"sessionId,omitempty"`
	AppRunID  string `json:"appRunId,omitempty"`
}

// GrantRole is one role's allow-list and concurrency cap.
type GrantRole struct {
	Templates    []string `json:"templates,omitempty"`
	MaxSandboxes int32    `json:"maxSandboxes"`
	MaxGPUs      int32    `json:"maxGpus"`
}

// GrantTemplate is a run-level template as submitted, before name expansion.
type GrantTemplate struct {
	Name        string  `json:"name"`
	PerGPUCount []int32 `json:"perGpuCount,omitempty"`
	// GPUCounts aligns with the expanded template names and drives quota.
	GPUCounts []int32 `json:"gpuCounts,omitempty"`
	// Spec is the template body as JSON. Stored as a string so fields that
	// CodeInterpreter does not know yet are not dropped.
	Spec string `json:"spec,omitempty"`
}

// SandboxGrantStatus is the live usage of a grant.
type SandboxGrantStatus struct {
	// State is active, revoked, or expired.
	State string `json:"state,omitempty"`
	// KeyHashes maps role to hex SHA-256 of that role's E2B key.
	KeyHashes map[string]string `json:"keyHashes,omitempty"`
	// Usage is the in-flight sandbox and GPU count per role.
	Usage map[string]GrantRoleUsage `json:"usage,omitempty"`
	// GPUSeconds is GPU time already accounted against gpuHoursBudget.
	GPUSeconds int64 `json:"gpuSeconds,omitempty"`
	// Sandboxes are the sandboxes recorded on this grant, including ended ones.
	Sandboxes []GrantSandboxRef `json:"sandboxes,omitempty"`
}

// GrantRoleUsage is the in-flight count for one role.
type GrantRoleUsage struct {
	Sandboxes int32 `json:"sandboxes,omitempty"`
	GPUs      int32 `json:"gpus,omitempty"`
}

// GrantSandboxRef is one sandbox charged to the grant.
type GrantSandboxRef struct {
	ID                string            `json:"id"`
	Role              string            `json:"role"`
	GPUs              int32             `json:"gpus"`
	SessionID         string            `json:"sessionId,omitempty"`
	StartedAt         metav1.Time       `json:"startedAt,omitempty"`
	EndedAt           metav1.Time       `json:"endedAt,omitempty"`
	Alias             string            `json:"alias,omitempty"`
	TemplateID        string            `json:"templateID,omitempty"`
	Namespace         string            `json:"namespace,omitempty"`
	SandboxName       string            `json:"sandboxName,omitempty"`
	State             string            `json:"state,omitempty"`
	EndReason         string            `json:"endReason,omitempty"`
	TimeoutSec        int64             `json:"timeoutSec,omitempty"`
	PendingTimeoutSec int64             `json:"pendingTimeoutSec,omitempty"`
	IdempotencyKey    string            `json:"idempotencyKey,omitempty"`
	AccessTokenHash   string            `json:"accessTokenHash,omitempty"`
	AccessTokenHashes []string          `json:"accessTokenHashes,omitempty"`
	NodeName          string            `json:"nodeName,omitempty"`
	Sealed            bool              `json:"sealed,omitempty"`
	Inputs            []string          `json:"inputs,omitempty"`
	Outputs           []string          `json:"outputs,omitempty"`
	Metadata          map[string]string `json:"metadata,omitempty"`
}

// +kubebuilder:object:root=true

// SandboxGrantList is a list of SandboxGrant.
type SandboxGrantList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []SandboxGrant `json:"items"`
}

func init() {
	SchemeBuilder.Register(&SandboxGrant{}, &SandboxGrantList{})
}
