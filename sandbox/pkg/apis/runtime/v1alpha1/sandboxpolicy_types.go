// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// +kubebuilder:object:root=true
// +kubebuilder:resource:scope=Namespaced,shortName=sbp
// +kubebuilder:printcolumn:name="Policy",type="string",JSONPath=".spec.runtimePolicy"
// +kubebuilder:printcolumn:name="Mode",type="string",JSONPath=".spec.policyMode"
// +kubebuilder:printcolumn:name="Version",type="integer",JSONPath=".spec.policyVersion"
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"

// SandboxPolicy holds the egress policy for one Sandbox.
// It is the authoritative policy source for EnvD and the control plane.
// Name and namespace match the Sandbox; the control plane owns writes.
// User-writable Sandbox annotations must not be treated as policy authority.
type SandboxPolicy struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec SandboxPolicySpec `json:"spec"`
}

// SandboxPolicySpec is the egress policy applied to a Sandbox.
type SandboxPolicySpec struct {
	// RuntimePolicy is the preset name, e.g. agent-default or agent-restricted.
	// +kubebuilder:default="agent-default"
	// +optional
	RuntimePolicy string `json:"runtimePolicy,omitempty"`

	// PolicyMode is "enforce" or "audit".
	// +kubebuilder:default="enforce"
	// +kubebuilder:validation:Enum=enforce;audit
	// +optional
	PolicyMode string `json:"policyMode,omitempty"`

	// AllowedEgressHosts lists external domains the sandbox may reach.
	// +optional
	AllowedEgressHosts []string `json:"allowedEgressHosts,omitempty"`

	// AllowedInternalHosts lists internal IPs/CIDRs the sandbox may reach.
	// +optional
	AllowedInternalHosts []string `json:"allowedInternalHosts,omitempty"`

	// PolicyVersion increments on each control-plane policy update.
	// EnvD uses it to detect changes.
	// +kubebuilder:default=1
	// +optional
	PolicyVersion int64 `json:"policyVersion,omitempty"`
}

// +kubebuilder:object:root=true

// SandboxPolicyList contains a list of SandboxPolicy.
type SandboxPolicyList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []SandboxPolicy `json:"items"`
}

func init() {
	SchemeBuilder.Register(&SandboxPolicy{}, &SandboxPolicyList{})
}
