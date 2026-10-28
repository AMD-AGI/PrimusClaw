// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"encoding/base64"
	"encoding/json"
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
	workloadAPIVersion     = "amd.com/v1"
	workloadKind           = "Workload"
	safeDisplayNameLabel   = "primus-safe.display.name"
	safeUserIDLabel        = "primus-safe.user.id"
	safeUserNameAnnotation = "primus-safe.user.name"
	safeWorkloadIDLabel    = "primus-safe.workload.id"
	// ownerSessionIDLabel records the issuing Claw session. Pulse reads
	// primus-claw/session-id as the session's own sandbox, so a grant workload
	// must not use that key.
	ownerSessionIDLabel        = "primus-claw/owner-session-id"
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
	// startupEnv is a shell snippet the Sandbox template evals before exec envd.
	startupEnv = "SANDBOX_STARTUP"
	// safeGeneratedNameLength is SaFE MaxGeneratedNameLength: a 63-character
	// DNS label minus a 5-character suffix and the separating hyphen.
	// The Workload name is copied onto the Sandbox, its Pod, its Service, and a label.
	safeGeneratedNameLength = 63 - 5 - 1
	// signingSecretKey is the data key mounted from the per-sandbox Secret.
	signingSecretKey = "signing-key.pem"
	// signingSecretMountRoot is the SaFE path for a general Secret volume.
	signingSecretMountRoot = "/etc/secrets"
	// signingSecretNamespace is where SaFE stores a Secret before mirroring it.
	signingSecretNamespace = "primus-safe"
	// signingSecretWorkspaceAnnotation binds the Secret to the sandbox workspace.
	signingSecretWorkspaceAnnotation = "primus-safe.workspace.ids"
	// signingSecretTypeLabel marks a general Secret, the type SaFE mounts as a volume.
	signingSecretTypeLabel   = "primus-safe.secret.type"
	signingSecretTypeGeneral = "general"
	// signingSecretFinalizer makes deletion wait until the mirrored copy is removed.
	signingSecretFinalizer = "primus-safe/secret.finalizer"
)

// secretGVR is a namespace-scoped Secret. The signing key lives in primus-safe.
var secretGVR = schema.GroupVersionResource{Version: "v1", Resource: "secrets"}

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
	secretName := ""
	if req.SigningKeyPEM != "" {
		secretName = signingSecretName(name)
		if err := c.createSigningSecret(ctx, req.Workspace, secretName, req.SigningKeyPEM); err != nil {
			return nil, fmt.Errorf("create signing secret: %w", err)
		}
	}
	created, err := c.dynamic.Resource(workloadGVR).Create(ctx, obj, metav1.CreateOptions{})
	if err != nil {
		if secretName != "" {
			_ = c.deleteSigningSecret(context.WithoutCancel(ctx), secretName)
		}
		return nil, fmt.Errorf("create workload: %w", err)
	}
	name = created.GetName()
	if secretName != "" {
		if err := c.adoptSigningSecret(ctx, secretName, created); err != nil {
			_ = c.Delete(context.WithoutCancel(ctx), name)
			_ = c.deleteSigningSecret(context.WithoutCancel(ctx), secretName)
			return nil, fmt.Errorf("adopt signing secret: %w", err)
		}
	}
	var (
		podIP, nodeName string
		waitErr         error
	)
	defer func() {
		if waitErr != nil {
			_ = c.Delete(context.WithoutCancel(ctx), name)
			if secretName != "" {
				_ = c.deleteSigningSecret(context.WithoutCancel(ctx), secretName)
			}
		}
	}()
	podIP, nodeName, waitErr = c.waitRunning(ctx, name, req.Workspace)
	if waitErr != nil {
		return nil, waitErr
	}
	// The Workload timeout is measured from dispatch. Set it only after Running
	// so the E2B lifetime starts once the sandbox is up.
	if req.Timeout > 0 {
		waitErr = c.AlignTimeout(ctx, name, req.Timeout, time.Now())
		if waitErr != nil {
			return nil, waitErr
		}
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

// Observe reports whether a sandbox Workload is running, still pending, finished, or gone.
func (c *SafeWorkloadCreator) Observe(ctx context.Context, sandboxID string) (e2b.CreateResult, string, error) {
	if c == nil || c.dynamic == nil || !strings.HasPrefix(sandboxID, e2bSandboxPrefix) {
		return e2b.CreateResult{}, e2b.WorkloadMissing, nil
	}
	obj, err := c.dynamic.Resource(workloadGVR).Get(ctx, sandboxID, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return e2b.CreateResult{}, e2b.WorkloadMissing, nil
	}
	if err != nil {
		return e2b.CreateResult{}, "", err
	}
	if obj.GetDeletionTimestamp() != nil {
		return e2b.CreateResult{}, e2b.WorkloadFinished, nil
	}
	phase, _, _ := unstructured.NestedString(obj.Object, "status", "phase")
	switch phase {
	case "Failed", "Succeeded", "Stopped":
		return e2b.CreateResult{}, e2b.WorkloadFinished, nil
	case "Running":
		workspace, _, _ := unstructured.NestedString(obj.Object, "spec", "workspace")
		ip, node, ok := c.address(ctx, obj, workspace, sandboxID)
		if !ok {
			return e2b.CreateResult{}, e2b.WorkloadPending, nil
		}
		return e2b.CreateResult{
			SandboxName: sandboxID,
			Namespace:   workspace,
			PodIP:       ip,
			PodPort:     envdPort,
			NodeName:    node,
		}, e2b.WorkloadRunning, nil
	default:
		return e2b.CreateResult{}, e2b.WorkloadPending, nil
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
	if _, ok := labels[ownerSessionIDLabel]; !ok || obj.GetDeletionTimestamp() != nil {
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

// signingSecretName is one Secret per sandbox. SaFE copies this name into the workspace.
func signingSecretName(sandboxID string) string {
	return sandboxID
}

// signingKeyFile is the private key after the init container copies it onto a writable emptyDir.
// The Secret mount itself stays on the init container.
const signingKeyFilePath = "/run/signing-key/" + signingSecretKey

func signingKeyFile(string) string {
	return signingKeyFilePath
}

// createSigningSecret writes the private key where SaFE mirrors workspace secrets.
func (c *SafeWorkloadCreator) createSigningSecret(ctx context.Context, workspace, name, pem string) error {
	bound, err := json.Marshal([]string{workspace})
	if err != nil {
		return err
	}
	obj := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1",
		"kind":       "Secret",
		"metadata": map[string]any{
			"name":      name,
			"namespace": signingSecretNamespace,
			"labels": map[string]any{
				signingSecretTypeLabel: signingSecretTypeGeneral,
			},
			"annotations": map[string]any{
				signingSecretWorkspaceAnnotation: string(bound),
			},
			"finalizers": []any{signingSecretFinalizer},
		},
		"type": "Opaque",
		"data": map[string]any{
			signingSecretKey: base64.StdEncoding.EncodeToString([]byte(pem)),
		},
	}}
	_, err = c.dynamic.Resource(secretGVR).Namespace(signingSecretNamespace).Create(ctx, obj, metav1.CreateOptions{})
	return err
}

// adoptSigningSecret makes the Workload the Secret owner so deleting the Workload deletes the key.
func (c *SafeWorkloadCreator) adoptSigningSecret(ctx context.Context, name string, owner *unstructured.Unstructured) error {
	secret, err := c.dynamic.Resource(secretGVR).Namespace(signingSecretNamespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return err
	}
	refs := []any{map[string]any{
		"apiVersion":         workloadAPIVersion,
		"kind":               workloadKind,
		"name":               owner.GetName(),
		"uid":                string(owner.GetUID()),
		"controller":         true,
		"blockOwnerDeletion": true,
	}}
	if err := unstructured.SetNestedSlice(secret.Object, refs, "metadata", "ownerReferences"); err != nil {
		return err
	}
	_, err = c.dynamic.Resource(secretGVR).Namespace(signingSecretNamespace).Update(ctx, secret, metav1.UpdateOptions{})
	return err
}

// deleteSigningSecret removes the key. A missing Secret is already gone.
func (c *SafeWorkloadCreator) deleteSigningSecret(ctx context.Context, name string) error {
	err := c.dynamic.Resource(secretGVR).Namespace(signingSecretNamespace).Delete(ctx, name, metav1.DeleteOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	return err
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
			return false, terminalWorkloadError(name, phase, obj)
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

const workloadFailureLimit = 480

// terminalWorkloadError names the finished phase and the failure text SaFE stored.
func terminalWorkloadError(name, phase string, obj *unstructured.Unstructured) error {
	text := workloadFailureText(obj)
	if text == "" {
		return fmt.Errorf("workload %s phase %s", name, phase)
	}
	return fmt.Errorf("workload %s phase %s: %s", name, phase, text)
}

// workloadFailureText is status.message, else the failed condition, plus the first pod detail.
func workloadFailureText(obj *unstructured.Unstructured) string {
	if obj == nil {
		return ""
	}
	message, _, _ := unstructured.NestedString(obj.Object, "status", "message")
	head, detail := splitFailureDetails(strings.TrimSpace(message))
	if head == "" && detail == "" {
		head, detail = splitFailureDetails(conditionFailureMessage(obj))
	}
	if detail == "" {
		detail = firstPodFailure(obj)
	}
	text := head
	if detail != "" {
		if text != "" {
			text += "; " + detail
		} else {
			text = detail
		}
	}
	text = strings.Join(strings.Fields(text), " ")
	if len(text) > workloadFailureLimit {
		return text[:workloadFailureLimit]
	}
	return text
}

func splitFailureDetails(message string) (string, string) {
	const marker = ", details: "
	head, raw, ok := strings.Cut(message, marker)
	if !ok {
		return strings.TrimSpace(message), ""
	}
	var items []map[string]any
	if err := json.Unmarshal([]byte(raw), &items); err != nil || len(items) == 0 {
		return strings.TrimSpace(message), ""
	}
	return strings.TrimSpace(head), formatFailureDetail(items[0])
}

func formatFailureDetail(item map[string]any) string {
	var parts []string
	if pod, _ := item["pod"].(string); pod != "" {
		parts = append(parts, "pod "+pod)
	}
	if node, _ := item["node"].(string); node != "" {
		parts = append(parts, "node "+node)
	}
	if message, _ := item["message"].(string); message != "" {
		parts = append(parts, message)
	}
	if container, ok := item["container"].(map[string]any); ok {
		if name, _ := container["name"].(string); name != "" {
			parts = append(parts, "container "+name)
		}
		if reason, _ := container["reason"].(string); reason != "" {
			parts = append(parts, "reason "+reason)
		}
		if exit, ok := jsonNumber(container["exitCode"]); ok {
			parts = append(parts, fmt.Sprintf("exit %d", exit))
		}
	}
	return strings.Join(parts, " ")
}

func jsonNumber(value any) (int64, bool) {
	switch n := value.(type) {
	case float64:
		return int64(n), true
	case int64:
		return n, true
	case json.Number:
		v, err := n.Int64()
		return v, err == nil
	default:
		return 0, false
	}
}

func conditionFailureMessage(obj *unstructured.Unstructured) string {
	conditions, _, _ := unstructured.NestedSlice(obj.Object, "status", "conditions")
	var found string
	for _, item := range conditions {
		condition, ok := item.(map[string]any)
		if !ok || condition["status"] != "True" {
			continue
		}
		kind, _ := condition["type"].(string)
		if kind != "K8sFailed" && kind != "AdminFailed" {
			continue
		}
		message, _ := condition["message"].(string)
		if strings.TrimSpace(message) != "" {
			found = strings.TrimSpace(message)
		}
	}
	return found
}

func firstPodFailure(obj *unstructured.Unstructured) string {
	pods, _, _ := unstructured.NestedSlice(obj.Object, "status", "pods")
	for _, item := range pods {
		pod, ok := item.(map[string]any)
		if !ok {
			continue
		}
		phase, _ := pod["phase"].(string)
		if phase != "" && phase != "Failed" {
			continue
		}
		detail := map[string]any{
			"pod":     pod["podId"],
			"node":    pod["adminNodeName"],
			"message": pod["failedMessage"],
		}
		if containers, ok := pod["containers"].([]any); ok {
			for _, raw := range containers {
				container, ok := raw.(map[string]any)
				if !ok {
					continue
				}
				exit, hasExit := jsonNumber(container["exitCode"])
				reason, _ := container["reason"].(string)
				if reason == "" && (!hasExit || exit == 0) {
					continue
				}
				detail["container"] = container
				break
			}
		}
		if text := formatFailureDetail(detail); text != "" {
			return text
		}
	}
	return ""
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
		"maxRetry":                int64(0),
		"groupVersionKind": map[string]any{
			"kind":    "Sandbox",
			"version": "v1",
		},
		"resources": []any{resource},
	}
	env := sandboxEnv(ci.Spec.Template.Environment, req.Env)
	applyTemplateRuntime(ci.Spec.Template, env)
	for key, value := range platformSandboxEnv(req, gpuCount(ci)) {
		env[key] = value
	}
	if len(env) > 0 {
		spec["env"] = env
	}
	if paths := templateHostPaths(ci.Spec.Template); len(paths) > 0 {
		spec["hostpath"] = paths
	}
	if nodes := strings.TrimSpace(req.AvoidNodes); nodes != "" {
		spec["customerLabels"] = map[string]any{"excluded-nodes": nodes}
	}
	if req.SigningKeyPEM != "" {
		spec["secrets"] = []any{map[string]any{"id": signingSecretName(req.SandboxID), "type": "general"}}
	}
	labels := map[string]any{
		safeDisplayNameLabel: req.Role,
		ownerSessionIDLabel:  req.SessionID,
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

// gpuCount is the number of GPUs the template requests.
func gpuCount(ci *runtimev1alpha1.CodeInterpreter) int {
	if ci == nil || ci.Spec.GPU == nil || ci.Spec.GPU.Count < 1 {
		return 0
	}
	return ci.Spec.GPU.Count
}

// rocrVisibleDevices lists GPU indexes from zero. One GPU is "0".
func rocrVisibleDevices(count int) string {
	if count < 1 {
		return ""
	}
	parts := make([]string, count)
	for i := range parts {
		parts[i] = strconv.Itoa(i)
	}
	return strings.Join(parts, ",")
}

// platformSandboxEnv sets the sandbox id, the signing key, and visible GPUs.
// These win over template and caller env.
func platformSandboxEnv(req e2b.CreateRequest, gpus int) map[string]string {
	env := map[string]string{}
	if req.SandboxID != "" {
		env["E2B_SANDBOX_ID"] = req.SandboxID
	}
	if req.SigningKeyPEM != "" {
		env["HYPERLOOM_SIGNING_KEY_FILE"] = signingKeyFile(req.SandboxID)
	}
	if devices := rocrVisibleDevices(gpus); devices != "" {
		env["ROCR_VISIBLE_DEVICES"] = devices
	}
	return env
}

func sandboxEnv(template []corev1.EnvVar, extra map[string]string) map[string]any {
	env := map[string]any{}
	for _, item := range template {
		if item.Name == "" || item.Name == platformInferenceKey || item.Name == startupEnv || item.Value == "" {
			continue
		}
		env[item.Name] = item.Value
	}
	for key, value := range extra {
		if key == "" || key == platformInferenceKey || key == startupEnv {
			continue
		}
		env[key] = value
	}
	return env
}

// applyTemplateRuntime copies env and workdir/run steps onto the Workload.
// SaFE has no steps field. Env steps become spec.env. Run and workdir steps
// become SANDBOX_STARTUP, which the Sandbox template evals before exec envd.
func applyTemplateRuntime(tmpl *runtimev1alpha1.CodeInterpreterSandboxTemplate, env map[string]any) {
	if tmpl == nil {
		return
	}
	var steps []string
	for _, step := range tmpl.Steps {
		if len(step.Args) == 0 || step.Args[0] == "" {
			continue
		}
		switch step.Type {
		case "env":
			key, value, ok := strings.Cut(step.Args[0], "=")
			if ok && key != "" && key != platformInferenceKey && key != startupEnv {
				env[key] = value
			}
		case "workdir":
			steps = append(steps, "cd "+shellSingleQuote(step.Args[0]))
		case "run":
			steps = append(steps, step.Args[0])
		}
	}
	if script := strings.Join(steps, " && "); script != "" {
		env[startupEnv] = script
	}
}

// templateHostPaths returns host paths SaFE mounts at the same path.
// A Sandbox host path is read-only. Volumes that are not hostPath have no
// Workload field.
func templateHostPaths(tmpl *runtimev1alpha1.CodeInterpreterSandboxTemplate) []any {
	if tmpl == nil {
		return nil
	}
	var out []any
	seen := map[string]struct{}{}
	for _, vol := range tmpl.Volumes {
		if vol.HostPath == nil || vol.HostPath.Path == "" {
			continue
		}
		if _, ok := seen[vol.HostPath.Path]; ok {
			continue
		}
		seen[vol.HostPath.Path] = struct{}{}
		out = append(out, vol.HostPath.Path)
	}
	return out
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
