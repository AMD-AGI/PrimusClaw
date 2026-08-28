// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced,shortName=ci
// +kubebuilder:printcolumn:name="Ready",type="boolean",JSONPath=".status.ready"
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"

// CodeInterpreter defines a sandbox template for running (potentially untrusted) user code.
// Platform admins or users create CodeInterpreter resources; users request sandboxes via the API.
//
// Inspired by the sandbox project's TemplateConfig design:
//   - fromImage: any Docker base image (like the sandbox project's from_image)
//   - steps: initialization steps run at Pod startup (like sandbox's TemplateConfig.steps)
//   - sidecars: additional containers sharing the same Pod network (e.g. Redis, MCP servers)
//
// EnvD is automatically injected via initContainer — no need to build a custom EnvD image.
type CodeInterpreter struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   CodeInterpreterSpec   `json:"spec"`
	Status CodeInterpreterStatus `json:"status,omitempty"`
}

// CodeInterpreterSpec describes the sandbox template configuration.
type CodeInterpreterSpec struct {
	// Template describes the container image and runtime configuration.
	// +kubebuilder:validation:Required
	Template *CodeInterpreterSandboxTemplate `json:"template"`

	// GPU configures AMD GPU allocation for this sandbox type.
	// +optional
	GPU *GPUConfig `json:"gpu,omitempty"`

	// SessionTimeout is the idle duration after which a sandbox is GC'd.
	// +kubebuilder:default="15m"
	// +optional
	SessionTimeout *metav1.Duration `json:"sessionTimeout,omitempty"`

	// MaxSessionDuration is the maximum lifetime of a sandbox, regardless of activity.
	// +kubebuilder:default="24h"
	// +optional
	MaxSessionDuration *metav1.Duration `json:"maxSessionDuration,omitempty"`

	// WarmPoolSize is the number of pre-warmed sandbox Pods to maintain.
	// Set to 0 to disable warm pool. Requires SandboxTemplate/SandboxWarmPool CRDs.
	// +optional
	WarmPoolSize *int32 `json:"warmPoolSize,omitempty"`

	// AuthMode controls how the Router's public key is injected.
	// - "envd" (default): inject ENVD_AUTH_PUBLIC_KEY env var
	// - "none": no injection (custom images)
	// +kubebuilder:default="envd"
	// +kubebuilder:validation:Enum=envd;none
	// +optional
	AuthMode AuthModeType `json:"authMode,omitempty"`

	// Ports defines the ports exposed by the sandbox Pod (used by Router for proxying).
	// +optional
	Ports []TargetPort `json:"ports,omitempty"`

	// RuntimePolicy references a ClusterSandboxPolicy by name.
	// Defaults to "agent-default" if not specified.
	// +kubebuilder:default="agent-default"
	// +optional
	RuntimePolicy string `json:"runtimePolicy,omitempty"`

	// AllowedEgressHosts is a list of external domain names that the sandbox is
	// allowed to access. Only effective when runtimePolicy is "agent-restricted".
	// +optional
	AllowedEgressHosts []string `json:"allowedEgressHosts,omitempty"`

	// AllowedInternalHosts is a list of internal IP/CIDR addresses that the sandbox
	// is allowed to access (bypasses SSRF blocking). CIDR mask must be >= /16.
	// +optional
	AllowedInternalHosts []string `json:"allowedInternalHosts,omitempty"`
}

// SandboxBuildStep defines a single initialization step executed at Pod startup.
// Corresponds to sandbox project's TemplateStep.
type SandboxBuildStep struct {
	// Type is the step type:
	//   run     — execute a shell command (e.g. "pip install numpy")
	//   env     — set an environment variable (format "KEY=VALUE")
	//   workdir — set the working directory
	// +kubebuilder:validation:Enum=run;env;workdir
	Type string `json:"type"`

	// Args are the step arguments.
	//   run:     ["pip install numpy pandas -q"]
	//   env:     ["PYTHONPATH=/home/sandbox"]
	//   workdir: ["/home/sandbox"]
	Args []string `json:"args"`
}

// CodeInterpreterSandboxTemplate describes the container configuration.
// Inspired by sandbox project's TemplateConfig.
type CodeInterpreterSandboxTemplate struct {
	// FromImage is any Docker base image for the sandbox (e.g. "python:3.11-slim", "ubuntu:22.04").
	// Corresponds to sandbox project's from_image field.
	// EnvD is automatically injected via initContainer — no need to provide a EnvD image.
	// +kubebuilder:validation:Required
	FromImage string `json:"fromImage"`

	// Steps are initialization steps executed at Pod startup, before EnvD starts.
	// Corresponds to sandbox project's TemplateConfig.steps.
	//   run:     executes shell commands (e.g. pip install, apt-get install)
	//   env:     sets environment variables
	//   workdir: sets the working directory
	// +optional
	Steps []SandboxBuildStep `json:"steps,omitempty"`

	// Sidecars are additional containers running in the same Pod as the main sandbox container.
	// All containers share the same network namespace — access sidecar services via localhost.
	// Typical use cases: local database (Redis, Postgres), MCP server, proxy.
	// +optional
	Sidecars []corev1.Container `json:"sidecars,omitempty"`

	// RuntimeClassName selects the container runtime (e.g., "kata-qemu" for VM isolation).
	// Leave empty for the default runc runtime.
	// +optional
	RuntimeClassName *string `json:"runtimeClassName,omitempty"`

	// ImagePullPolicy for the container image.
	// +optional
	ImagePullPolicy corev1.PullPolicy `json:"imagePullPolicy,omitempty"`

	// ImagePullSecrets for pulling the container image.
	// +optional
	ImagePullSecrets []corev1.LocalObjectReference `json:"imagePullSecrets,omitempty"`

	// Environment variables injected into the main container (in addition to steps env).
	// +optional
	Environment []corev1.EnvVar `json:"environment,omitempty"`

	// Resources sets CPU/memory/GPU resource requests and limits for the main container.
	// +optional
	Resources corev1.ResourceRequirements `json:"resources,omitempty"`

	// Labels to apply to the sandbox Pod.
	// +optional
	Labels map[string]string `json:"labels,omitempty"`

	// Annotations to apply to the sandbox Pod.
	// +optional
	Annotations map[string]string `json:"annotations,omitempty"`

	// Volumes to attach to the sandbox Pod (e.g. hostPath, NFS, PVC).
	// +optional
	Volumes []corev1.Volume `json:"volumes,omitempty"`

	// VolumeMounts for the main container. When readOnly is omitted, the mount defaults to
	// read-only. Writable mounts must set readOnly explicitly to false.
	// +optional
	VolumeMounts []CodeInterpreterVolumeMount `json:"volumeMounts,omitempty"`
}

// CodeInterpreterVolumeMount defines a volume mount on the main sandbox container.
// Omitting readOnly defaults to read-only (safe default); set readOnly to false explicitly for writable mounts.
type CodeInterpreterVolumeMount struct {
	// +kubebuilder:validation:Required
	Name string `json:"name"`
	// +kubebuilder:validation:Required
	MountPath string `json:"mountPath"`
	// +optional
	SubPath string `json:"subPath,omitempty"`
	// ReadOnly defaults to true when omitted. Set explicitly to false for writable mounts.
	// +optional
	ReadOnly *bool `json:"readOnly,omitempty"`
}

// GPUConfig configures AMD GPU allocation for a GPU sandbox.
type GPUConfig struct {
	// Product is the GPU product name (e.g., "MI300X").
	// +optional
	Product string `json:"product,omitempty"`

	// Count is the number of GPUs to allocate per sandbox.
	// +kubebuilder:default=1
	Count int `json:"count"`

	// ResourceName is the K8s extended resource name.
	// +kubebuilder:default="amd.com/gpu"
	ResourceName string `json:"resourceName"`

	// SharedMemory is the /dev/shm size for GPU IPC (e.g., "64Gi").
	// +optional
	SharedMemory string `json:"sharedMemory,omitempty"`
}

// CodeInterpreterStatus is the observed state.
type CodeInterpreterStatus struct {
	// Ready indicates the CodeInterpreter is ready to serve requests.
	// +optional
	Ready bool `json:"ready,omitempty"`

	// Conditions reports detailed status conditions.
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// AuthModeType defines how the Router public key is injected.
type AuthModeType string

const (
	// AuthModeEnvD injects ENVD_AUTH_PUBLIC_KEY from the Router identity Secret.
	AuthModeEnvD AuthModeType = "envd"
	// AuthModeNone disables injection for custom images.
	AuthModeNone AuthModeType = "none"
)

// TargetPort defines a port exposed by the sandbox Pod.
type TargetPort struct {
	// Name is an optional label for the port.
	// +optional
	Name string `json:"name,omitempty"`
	// Port number.
	Port uint32 `json:"port"`
	// PathPrefix routes requests with this prefix to this port.
	// +optional
	PathPrefix string `json:"pathPrefix,omitempty"`
	// Protocol is HTTP or HTTPS.
	// +kubebuilder:default=HTTP
	// +kubebuilder:validation:Enum=HTTP;HTTPS
	Protocol ProtocolType `json:"protocol"`
}

// ProtocolType defines the protocol for a TargetPort.
type ProtocolType string

const (
	ProtocolHTTP  ProtocolType = "HTTP"
	ProtocolHTTPS ProtocolType = "HTTPS"
)

// +kubebuilder:object:root=true

// CodeInterpreterList contains a list of CodeInterpreter.
type CodeInterpreterList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []CodeInterpreter `json:"items"`
}

func init() {
	SchemeBuilder.Register(&CodeInterpreter{}, &CodeInterpreterList{})
}
