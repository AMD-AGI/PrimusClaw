// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/wait"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/util/retry"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/e2b"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

const (
	workloadAPIVersion         = "amd.com/v1"
	workloadKind               = "Workload"
	safeDisplayNameLabel       = "primus-safe.display.name"
	safeUserIDLabel            = "primus-safe.user.id"
	safeUserNameAnnotation     = "primus-safe.user.name"
	safeWorkloadIDLabel        = "primus-safe.workload.id"
	sessionIDLabel             = "primus-claw/session-id"
	grantIDLabel               = "agent-sandbox.io/grant-id"
	sandboxIDLabel             = "agent-sandbox.io/sandbox-id"
	grantAttestationAnnotation = "agent-sandbox.io/grant-attestation"
	workloadEphemeralStorage   = "50Gi"
	workloadPriority           = int64(2)
	workloadTTLSeconds         = int64(10)
	envdPort                   = 8080
	e2bSandboxPrefix           = "sbx-"
	// platformInferenceKey is not copied onto a grant sandbox.
	platformInferenceKey = "OPENAI_API_KEY"
	// safeGeneratedNameLength is SaFE MaxGeneratedNameLength: a 63-character
	// DNS label minus a 5-character suffix and the separating hyphen.
	// The Workload name is copied onto the Sandbox, its Pod, its Service, and a label.
	safeGeneratedNameLength = 63 - 5 - 1
)

// workloadGVR is the cluster-scoped SaFE Workload.
var workloadGVR = schema.GroupVersionResource{Group: "amd.com", Version: "v1", Resource: "workloads"}

// workloadPollInterval is how often Create re-reads a Workload until it is Running.
var workloadPollInterval = time.Second

// SafeWorkloadCreator writes a SaFE Workload for an E2B sandbox and deletes it with the sandbox.
type SafeWorkloadCreator struct {
	dynamic dynamic.Interface
	client  ctrlclient.Client
}

// NewSafeWorkloadCreator uses the dynamic client for Workloads and the controller client for templates and pods.
func NewSafeWorkloadCreator(dyn dynamic.Interface, client ctrlclient.Client) *SafeWorkloadCreator {
	return &SafeWorkloadCreator{dynamic: dyn, client: client}
}

// Create writes one Sandbox Workload from the CodeInterpreter and waits until it is Running
// and a pod address is visible. It does not set entryPoints; the Sandbox template starts envd.
func (c *SafeWorkloadCreator) Create(ctx context.Context, req e2b.CreateRequest) (*SandboxResult, error) {
	if c == nil || c.dynamic == nil || c.client == nil {
		return nil, fmt.Errorf("safe workload client is not configured")
	}
	if err := validateWorkloadRequest(req); err != nil {
		return nil, err
	}
	ci := &runtimev1alpha1.CodeInterpreter{}
	if err := c.client.Get(ctx, types.NamespacedName{Name: req.TemplateID, Namespace: req.Namespace}, ci); err != nil {
		if apierrors.IsNotFound(err) {
			return nil, fmt.Errorf("%w: CodeInterpreter %q not found in namespace %q", ErrTemplateNotFound, req.TemplateID, req.Namespace)
		}
		return nil, fmt.Errorf("get CodeInterpreter: %w", err)
	}
	// SaFE copies the Workload name into the session-id annotation. EnvD accepts
	// a token only when that annotation equals the E2B sandbox id.
	name := req.SandboxID
	obj, err := workloadObject(name, req, ci)
	if err != nil {
		return nil, err
	}
	created, err := c.dynamic.Resource(workloadGVR).Create(ctx, obj, metav1.CreateOptions{})
	if err != nil {
		return nil, fmt.Errorf("create workload: %w", err)
	}
	name = created.GetName()
	var (
		podIP, nodeName string
		waitErr         error
	)
	defer func() {
		if waitErr != nil {
			_ = c.Delete(context.WithoutCancel(ctx), name)
		}
	}()
	podIP, nodeName, waitErr = c.waitRunning(ctx, name, req.Workspace)
	if waitErr != nil {
		return nil, waitErr
	}
	result := &SandboxResult{
		SandboxName:          name,
		Namespace:            req.Workspace,
		PodIP:                podIP,
		PodPort:              envdPort,
		NodeName:             nodeName,
		Kind:                 store.WorkloadKind,
		MaxSessionDuration:   req.Timeout,
		RuntimePolicy:        ci.Spec.RuntimePolicy,
		AllowedEgressHosts:   append([]string(nil), ci.Spec.AllowedEgressHosts...),
		AllowedInternalHosts: append([]string(nil), ci.Spec.AllowedInternalHosts...),
	}
	if result.RuntimePolicy == "" {
		result.RuntimePolicy = "agent-default"
	}
	return result, nil
}

// AlignTimeout stores the sandbox timeout on the Workload.
// The sandbox timeout is a duration from now. The Workload timeout is a
// duration from status.startTime, so the stored value is the time already
// running plus the sandbox timeout.
func (c *SafeWorkloadCreator) AlignTimeout(ctx context.Context, name string, timeout time.Duration, now time.Time) error {
	if c == nil || c.dynamic == nil || name == "" {
		return fmt.Errorf("safe workload client is not configured")
	}
	if timeout <= 0 {
		return fmt.Errorf("timeout must be > 0")
	}
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		obj, err := c.dynamic.Resource(workloadGVR).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return err
		}
		seconds := workloadTimeoutSeconds(workloadStartTime(obj), now, timeout)
		if err := unstructured.SetNestedField(obj.Object, seconds, "spec", "timeout"); err != nil {
			return err
		}
		_, err = c.dynamic.Resource(workloadGVR).Update(ctx, obj, metav1.UpdateOptions{})
		return err
	})
}

// workloadTimeoutSeconds converts a sandbox timeout into a Workload timeout.
// A zero start means the Workload has not reported one yet, so the sandbox
// timeout is stored as-is.
func workloadTimeoutSeconds(started, now time.Time, timeout time.Duration) int64 {
	elapsed := time.Duration(0)
	if !started.IsZero() && now.After(started) {
		elapsed = now.Sub(started)
	}
	total := elapsed + timeout
	seconds := int64(total / time.Second)
	if total%time.Second != 0 {
		seconds++
	}
	if seconds < 1 {
		return 1
	}
	return seconds
}

func workloadStartTime(obj *unstructured.Unstructured) time.Time {
	raw, _, _ := unstructured.NestedString(obj.Object, "status", "startTime")
	if raw == "" {
		return time.Time{}
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if started, err := time.Parse(layout, raw); err == nil {
			return started
		}
	}
	return time.Time{}
}

// Present reports whether an E2B Workload still occupies its grant.
// A missing object or a finished phase does not. Pending and empty phases
// still count: status may not be written in the first seconds after create.
func (c *SafeWorkloadCreator) Present(ctx context.Context, name string) (bool, error) {
	if c == nil || c.dynamic == nil || name == "" {
		return false, nil
	}
	obj, err := c.dynamic.Resource(workloadGVR).Get(ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	phase, _, _ := unstructured.NestedString(obj.Object, "status", "phase")
	switch phase {
	case "Failed", "Succeeded", "Stopped":
		return false, nil
	default:
		return true, nil
	}
}

// Session rebuilds the session record of an E2B Workload named by the sandbox id.
// A missing Workload, a finished phase, or a Workload not created for E2B is store.ErrNotFound.
func (c *SafeWorkloadCreator) Session(ctx context.Context, name string) (*store.SandboxInfo, error) {
	if c == nil || c.dynamic == nil || !strings.HasPrefix(name, e2bSandboxPrefix) || !dnsLabel(name, safeGeneratedNameLength) {
		return nil, store.ErrNotFound
	}
	obj, err := c.dynamic.Resource(workloadGVR).Get(ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return nil, store.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	labels := obj.GetLabels()
	if _, ok := labels[sessionIDLabel]; !ok || obj.GetDeletionTimestamp() != nil {
		return nil, store.ErrNotFound
	}
	phase, _, _ := unstructured.NestedString(obj.Object, "status", "phase")
	switch phase {
	case "Failed", "Succeeded", "Stopped":
		return nil, store.ErrNotFound
	}
	workspace, _, _ := unstructured.NestedString(obj.Object, "spec", "workspace")
	info := &store.SandboxInfo{
		Kind:        store.WorkloadKind,
		SessionID:   name,
		SandboxName: name,
		Namespace:   workspace,
		PodPort:     envdPort,
		CreatedAt:   obj.GetCreationTimestamp().Time,
		Status:      "creating",
		UserID:      labels[safeUserIDLabel],
		UserName:    obj.GetAnnotations()[safeUserNameAnnotation],
	}
	started := workloadStartTime(obj)
	if seconds, _, _ := unstructured.NestedInt64(obj.Object, "spec", "timeout"); seconds > 0 && !started.IsZero() {
		info.ExpiresAt = started.Add(time.Duration(seconds) * time.Second)
	}
	if phase == "Running" {
		ip, _, ok := addressFromStatus(obj)
		if !ok && c.client != nil {
			ip, _, ok = c.address(ctx, obj, workspace, name)
		}
		if ok {
			info.PodIP = ip
			info.Status = "running"
		}
	}
	return info, nil
}

// Delete removes the Workload. A missing object is already gone.
func (c *SafeWorkloadCreator) Delete(ctx context.Context, name string) error {
	if c == nil || c.dynamic == nil || name == "" {
		return nil
	}
	err := c.dynamic.Resource(workloadGVR).Delete(ctx, name, metav1.DeleteOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	return err
}

func (c *SafeWorkloadCreator) waitRunning(ctx context.Context, name, workspace string) (string, string, error) {
	var podIP, nodeName string
	err := wait.PollUntilContextCancel(ctx, workloadPollInterval, true, func(ctx context.Context) (bool, error) {
		obj, err := c.dynamic.Resource(workloadGVR).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return false, err
		}
		phase, _, _ := unstructured.NestedString(obj.Object, "status", "phase")
		switch phase {
		case "Failed", "Succeeded", "Stopped":
			return false, fmt.Errorf("workload %s phase %s", name, phase)
		case "Running":
			ip, node, ok := c.address(ctx, obj, workspace, name)
			if !ok {
				return false, nil
			}
			podIP, nodeName = ip, node
			return true, nil
		default:
			return false, nil
		}
	})
	if err != nil {
		return "", "", err
	}
	return podIP, nodeName, nil
}

// address reads the pod IP from workload status, then from a pod labeled with the workload id.
func (c *SafeWorkloadCreator) address(ctx context.Context, obj *unstructured.Unstructured, workspace, name string) (string, string, bool) {
	if ip, node, ok := addressFromStatus(obj); ok {
		return ip, node, true
	}
	var pods corev1.PodList
	err := c.client.List(ctx, &pods,
		ctrlclient.InNamespace(workspace),
		ctrlclient.MatchingLabels{safeWorkloadIDLabel: name},
	)
	if err != nil {
		return "", "", false
	}
	for i := range pods.Items {
		pod := &pods.Items[i]
		if pod.Status.PodIP == "" {
			continue
		}
		return pod.Status.PodIP, pod.Spec.NodeName, true
	}
	return "", "", false
}

func addressFromStatus(obj *unstructured.Unstructured) (string, string, bool) {
	pods, found, err := unstructured.NestedSlice(obj.Object, "status", "pods")
	if err != nil || !found {
		return "", "", false
	}
	for _, item := range pods {
		raw, ok := item.(map[string]any)
		if !ok {
			continue
		}
		ip, _, _ := unstructured.NestedString(raw, "podIP")
		node, _, _ := unstructured.NestedString(raw, "adminNodeName")
		if ip != "" {
			return ip, node, true
		}
	}
	return "", "", false
}

func validateWorkloadRequest(req e2b.CreateRequest) error {
	if req.TemplateID == "" || req.Namespace == "" {
		return fmt.Errorf("template and namespace are required")
	}
	if !dnsLabel(req.SandboxID, safeGeneratedNameLength) {
		return fmt.Errorf("sandbox id %q is not a workload name", req.SandboxID)
	}
	if !dnsLabel(req.Role, 40) {
		return fmt.Errorf("role %q is not a workload display name", req.Role)
	}
	if !dnsLabel(req.Workspace, 63) {
		return fmt.Errorf("workspace %q is not a namespace name", req.Workspace)
	}
	if !labelValue(req.SessionID) {
		return fmt.Errorf("session id %q is not a label value", req.SessionID)
	}
	if req.UserID != "" && !labelValue(req.UserID) {
		return fmt.Errorf("user id %q is not a label value", req.UserID)
	}
	if !labelValue(req.GrantID) {
		return fmt.Errorf("grant id %q is not a label value", req.GrantID)
	}
	if req.Attestation == "" {
		return fmt.Errorf("grant attestation is required")
	}
	return nil
}

func workloadObject(name string, req e2b.CreateRequest, ci *runtimev1alpha1.CodeInterpreter) (*unstructured.Unstructured, error) {
	if ci.Spec.Template == nil || ci.Spec.Template.FromImage == "" {
		return nil, fmt.Errorf("template %s has no image", req.TemplateID)
	}
	cpu, memory := resourcePair(ci.Spec.Template.Resources)
	if cpu == "" || memory == "" {
		return nil, fmt.Errorf("template %s has no cpu or memory", req.TemplateID)
	}
	resource := map[string]any{
		"replica":          int64(1),
		"cpu":              cpu,
		"memory":           memory,
		"ephemeralStorage": ephemeralStorage(ci.Spec.Template.Resources),
	}
	if ci.Spec.GPU != nil && ci.Spec.GPU.Count > 0 {
		resource["gpu"] = strconv.Itoa(ci.Spec.GPU.Count)
		if ci.Spec.GPU.SharedMemory != "" {
			resource["sharedMemory"] = ci.Spec.GPU.SharedMemory
		}
	}
	spec := map[string]any{
		"workspace":               req.Workspace,
		"images":                  []any{ci.Spec.Template.FromImage},
		"priority":                workloadPriority,
		"ttlSecondsAfterFinished": workloadTTLSeconds,
		"groupVersionKind": map[string]any{
			"kind":    "Sandbox",
			"version": "v1",
		},
		"resources": []any{resource},
	}
	if req.Timeout > 0 {
		spec["timeout"] = int64(req.Timeout / time.Second)
	}
	if env := sandboxEnv(ci.Spec.Template.Environment, req.Env); len(env) > 0 {
		spec["env"] = env
	}
	labels := map[string]any{
		safeDisplayNameLabel: req.Role,
		sessionIDLabel:       req.SessionID,
		sandboxIDLabel:       name,
	}
	if req.UserID != "" {
		labels[safeUserIDLabel] = req.UserID
	}
	if req.GrantID != "" {
		labels[grantIDLabel] = req.GrantID
	}
	annotations := map[string]any{}
	if req.UserName != "" {
		annotations[safeUserNameAnnotation] = req.UserName
	}
	if req.Attestation != "" {
		annotations[grantAttestationAnnotation] = req.Attestation
	}
	obj := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": workloadAPIVersion,
		"kind":       workloadKind,
		"metadata": map[string]any{
			"name":        name,
			"labels":      labels,
			"annotations": annotations,
		},
		"spec": spec,
	}}
	return obj, nil
}

// ephemeralStorage returns the template pod storage, or the default when unset.
func ephemeralStorage(req corev1.ResourceRequirements) string {
	if s := quantityString(req.Limits, corev1.ResourceEphemeralStorage); s != "" {
		return s
	}
	if s := quantityString(req.Requests, corev1.ResourceEphemeralStorage); s != "" {
		return s
	}
	return workloadEphemeralStorage
}

func resourcePair(req corev1.ResourceRequirements) (string, string) {
	cpu := quantityString(req.Limits, corev1.ResourceCPU)
	memory := quantityString(req.Limits, corev1.ResourceMemory)
	if cpu == "" {
		cpu = quantityString(req.Requests, corev1.ResourceCPU)
	}
	if memory == "" {
		memory = quantityString(req.Requests, corev1.ResourceMemory)
	}
	return cpu, memory
}

func quantityString(list corev1.ResourceList, name corev1.ResourceName) string {
	q, ok := list[name]
	if !ok {
		return ""
	}
	return q.String()
}

func sandboxEnv(template []corev1.EnvVar, extra map[string]string) map[string]any {
	env := map[string]any{}
	for _, item := range template {
		if item.Name == "" || item.Name == platformInferenceKey || item.Value == "" {
			continue
		}
		env[item.Name] = item.Value
	}
	for key, value := range extra {
		if key == "" || key == platformInferenceKey {
			continue
		}
		env[key] = value
	}
	return env
}

func dnsLabel(value string, max int) bool {
	if value == "" || len(value) > max {
		return false
	}
	for i, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
		case r == '-' && i > 0 && i < len(value)-1:
		default:
			return false
		}
	}
	return true
}

func labelValue(value string) bool {
	if value == "" || len(value) > 63 {
		return false
	}
	for i, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case (r == '-' || r == '_' || r == '.') && i > 0 && i < len(value)-1:
		default:
			return false
		}
	}
	return true
}
