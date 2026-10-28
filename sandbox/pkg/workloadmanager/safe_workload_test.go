// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynfake "k8s.io/client-go/dynamic/fake"
	k8stesting "k8s.io/client-go/testing"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/e2b"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

func TestWorkloadObjectUsesTemplateResources(t *testing.T) {
	ci := testCodeInterpreter()
	const sandboxID = "sbx-7a9b9b693452f613877992145c818d29"
	obj, err := workloadObject(sandboxID, e2b.CreateRequest{
		SandboxID:     sandboxID,
		TemplateID:    "ar-run-dev-g2",
		Role:          "dev",
		SessionID:     "s-8f2a",
		Workspace:     "top-models",
		UserID:        "u-123",
		UserName:      "alice",
		GrantID:       "gr-01jb7m9k2x",
		Attestation:   "eyJ.test",
		SigningKeyPEM: "test-private-key",
		AvoidNodes:    "node-a node-b",
		Timeout:       60 * time.Second,
		Env:           map[string]string{"FOO": "1", platformInferenceKey: "secret"},
	}, ci)
	if err != nil {
		t.Fatal(err)
	}
	if _, found, _ := unstructured.NestedFieldNoCopy(obj.Object, "spec", "entryPoints"); found {
		t.Fatal("entryPoints must stay unset")
	}
	if obj.GetLabels()[safeDisplayNameLabel] != "dev" || obj.GetLabels()[ownerSessionIDLabel] != "s-8f2a" || obj.GetLabels()["primus-claw/session-id"] != "" || obj.GetLabels()[safeUserIDLabel] != "u-123" || obj.GetLabels()[grantIDLabel] != "gr-01jb7m9k2x" || obj.GetLabels()[sandboxIDLabel] != sandboxID {
		t.Fatalf("labels=%v", obj.GetLabels())
	}
	if obj.GetAnnotations()[safeUserNameAnnotation] != "alice" || obj.GetAnnotations()[grantAttestationAnnotation] != "eyJ.test" {
		t.Fatalf("annotations=%v", obj.GetAnnotations())
	}
	if _, ok := obj.GetAnnotations()["primus-safe.workload.use.workspace.storage"]; ok {
		t.Fatal("useWorkspaceStorage must stay unset")
	}
	gvk, _, _ := unstructured.NestedMap(obj.Object, "spec", "groupVersionKind")
	if gvk["kind"] != "Sandbox" || gvk["version"] != "v1" {
		t.Fatalf("gvk=%v", gvk)
	}
	priority, _, _ := unstructured.NestedInt64(obj.Object, "spec", "priority")
	ttl, _, _ := unstructured.NestedInt64(obj.Object, "spec", "ttlSecondsAfterFinished")
	retry, _, _ := unstructured.NestedInt64(obj.Object, "spec", "maxRetry")
	if priority != workloadPriority || ttl != workloadTTLSeconds || retry != 0 {
		t.Fatalf("priority=%d ttl=%d retry=%d", priority, ttl, retry)
	}
	resources, _, _ := unstructured.NestedSlice(obj.Object, "spec", "resources")
	res, _ := resources[0].(map[string]any)
	if res["cpu"] != "54" || res["memory"] != "500Gi" || res["gpu"] != "2" || res["sharedMemory"] != "250Gi" || res["ephemeralStorage"] != "50Gi" || res["replica"] != int64(1) {
		t.Fatalf("resources=%v", res)
	}
	env, _, _ := unstructured.NestedMap(obj.Object, "spec", "env")
	if env["FOO"] != "1" || env["HYPERLOOM_ACTIVE_IMAGE_DIGEST"] != "sha256:aa" || env["E2B_SANDBOX_ID"] != sandboxID || env["HYPERLOOM_SIGNING_KEY_FILE"] != "/app/signing-key.pem" || env["HYPERLOOM_SIGNING_KEY_PEM"] != "test-private-key" || env["ROCR_VISIBLE_DEVICES"] != "0,1" {
		t.Fatalf("env=%v", env)
	}
	if _, ok := env[platformInferenceKey]; ok {
		t.Fatal("platform inference key was copied")
	}
	images, _, _ := unstructured.NestedStringSlice(obj.Object, "spec", "images")
	if len(images) != 1 || images[0] != "example@sha256:aa" {
		t.Fatalf("images=%v", images)
	}
	if _, found, _ := unstructured.NestedFieldNoCopy(obj.Object, "spec", "timeout"); found {
		t.Fatal("timeout must wait until the workload is running")
	}
	labels, _, _ := unstructured.NestedMap(obj.Object, "spec", "customerLabels")
	if labels["excluded-nodes"] != "node-a node-b" {
		t.Fatalf("customerLabels=%v", labels)
	}
}

func TestCreateWorkloadWaitsForPod(t *testing.T) {
	const sandboxID = "sbx-7a9b9b693452f613877992145c818d29"
	prev := workloadPollInterval
	workloadPollInterval = time.Millisecond
	t.Cleanup(func() { workloadPollInterval = prev })

	ci := testCodeInterpreter()
	scheme := k8sruntime.NewScheme()
	if err := runtimev1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "sandbox-pod",
			Namespace: "top-models",
			Labels:    map[string]string{safeWorkloadIDLabel: sandboxID},
		},
		Spec:   corev1.PodSpec{NodeName: "node-b"},
		Status: corev1.PodStatus{PodIP: "10.2.0.4", Phase: corev1.PodRunning},
	}
	cl := fake.NewClientBuilder().WithScheme(scheme).WithObjects(ci, pod).Build()
	dc := dynfake.NewSimpleDynamicClientWithCustomListKinds(k8sruntime.NewScheme(), map[schema.GroupVersionResource]string{
		workloadGVR: "WorkloadList",
	})
	dc.PrependReactor("get", "workloads", func(action k8stesting.Action) (bool, k8sruntime.Object, error) {
		get := action.(k8stesting.GetAction)
		stored, err := dc.Tracker().Get(workloadGVR, get.GetNamespace(), get.GetName())
		if err != nil {
			return true, nil, err
		}
		obj := stored.(*unstructured.Unstructured).DeepCopy()
		_ = unstructured.SetNestedField(obj.Object, "Running", "status", "phase")
		return true, obj, nil
	})
	creator := NewSafeWorkloadCreator(dc, cl)
	result, err := creator.Create(context.Background(), e2b.CreateRequest{
		SandboxID:   sandboxID,
		TemplateID:  ci.Name,
		Namespace:   ci.Namespace,
		Role:        "dev",
		SessionID:   "s-8f2a",
		Workspace:   "top-models",
		UserID:      "u-123",
		UserName:    "alice",
		GrantID:     "gr-01jb7m9k2x",
		Attestation: "eyJ.test",
		Timeout:     time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.SandboxName != sandboxID || result.Namespace != "top-models" || result.PodIP != "10.2.0.4" ||
		result.PodPort != envdPort || result.NodeName != "node-b" || result.Kind != store.WorkloadKind {
		t.Fatalf("result=%+v", result)
	}
	stored, err := dc.Tracker().Get(workloadGVR, "", sandboxID)
	if err != nil {
		t.Fatal(err)
	}
	timeout, _, _ := unstructured.NestedInt64(stored.(*unstructured.Unstructured).Object, "spec", "timeout")
	if timeout != 60 {
		t.Fatalf("timeout=%d", timeout)
	}
	if err := creator.Delete(context.Background(), result.SandboxName); err != nil {
		t.Fatal(err)
	}
	if _, err := dc.Tracker().Get(workloadGVR, "", result.SandboxName); err == nil {
		t.Fatal("workload still exists")
	}
}

func TestCreateDeletesFailedWorkload(t *testing.T) {
	const sandboxID = "sbx-7a9b9b693452f613877992145c818d29"
	prev := workloadPollInterval
	workloadPollInterval = time.Millisecond
	t.Cleanup(func() { workloadPollInterval = prev })

	scheme := k8sruntime.NewScheme()
	if err := runtimev1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	cl := fake.NewClientBuilder().WithScheme(scheme).WithObjects(testCodeInterpreter()).Build()
	dc := dynfake.NewSimpleDynamicClientWithCustomListKinds(k8sruntime.NewScheme(), map[schema.GroupVersionResource]string{
		workloadGVR: "WorkloadList",
	})
	dc.PrependReactor("get", "workloads", func(action k8stesting.Action) (bool, k8sruntime.Object, error) {
		get := action.(k8stesting.GetAction)
		stored, err := dc.Tracker().Get(workloadGVR, get.GetNamespace(), get.GetName())
		if err != nil {
			return true, nil, err
		}
		obj := stored.(*unstructured.Unstructured).DeepCopy()
		_ = unstructured.SetNestedField(obj.Object, "Failed", "status", "phase")
		return true, obj, nil
	})
	_, err := NewSafeWorkloadCreator(dc, cl).Create(context.Background(), e2b.CreateRequest{
		SandboxID:   sandboxID,
		TemplateID:  "ar-run-dev-g2",
		Namespace:   "agent-sandbox-system",
		Role:        "dev",
		SessionID:   "s-8f2a",
		Workspace:   "top-models",
		UserID:      "u-123",
		GrantID:     "gr-01jb7m9k2x",
		Attestation: "eyJ.test",
		Timeout:     time.Minute,
	})
	if err == nil {
		t.Fatal("expected failure")
	}
	if _, getErr := dc.Tracker().Get(workloadGVR, "", sandboxID); getErr == nil {
		t.Fatal("failed workload was not deleted")
	}
}

func TestWorkloadNameMatchesSandboxID(t *testing.T) {
	const sandboxID = "sbx-7a9b9b693452f613877992145c818d29"
	if len(sandboxID) > safeGeneratedNameLength {
		t.Fatalf("sandbox id length %d exceeds %d", len(sandboxID), safeGeneratedNameLength)
	}
	req := e2b.CreateRequest{
		SandboxID: sandboxID, TemplateID: "tpl", Namespace: "ns",
		Role: "dev", SessionID: "s-8f2a", Workspace: "top-models",
		GrantID: "gr-01jb7m9k2x", Attestation: "eyJ.test",
	}
	if err := validateWorkloadRequest(req); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{
		"SBX-7a9b9b693452f613877992145c818d29",
		"sbx_7a9b9b693452f613877992145c818d29",
		"sbx-" + strings.Repeat("a", safeGeneratedNameLength),
	} {
		req.SandboxID = id
		if err := validateWorkloadRequest(req); err == nil {
			t.Fatalf("accepted %q", id)
		}
	}
}

func TestAlignTimeoutAddsElapsed(t *testing.T) {
	dc := dynfake.NewSimpleDynamicClientWithCustomListKinds(k8sruntime.NewScheme(), map[schema.GroupVersionResource]string{
		workloadGVR: "WorkloadList",
	})
	now := time.Date(2026, 10, 23, 9, 0, 0, 0, time.UTC)
	started := now.Add(-90 * time.Second)
	obj := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "amd.com/v1",
		"kind":       "Workload",
		"metadata": map[string]any{
			"name": "measurement-1",
			"labels": map[string]any{
				safeUserIDLabel: "u-123",
				grantIDLabel:    "gr-01jb7m9k2x",
			},
			"annotations": map[string]any{
				grantAttestationAnnotation: "eyJ.test",
			},
		},
		"spec":   map[string]any{"timeout": int64(120)},
		"status": map[string]any{"startTime": started.Format(time.RFC3339)},
	}}
	if _, err := dc.Resource(workloadGVR).Create(context.Background(), obj, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := NewSafeWorkloadCreator(dc, nil).AlignTimeout(context.Background(), "measurement-1", 300*time.Second, now); err != nil {
		t.Fatal(err)
	}
	got, err := dc.Resource(workloadGVR).Get(context.Background(), "measurement-1", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	timeout, _, _ := unstructured.NestedInt64(got.Object, "spec", "timeout")
	if timeout != 390 {
		t.Fatalf("timeout=%d", timeout)
	}
	if got.GetLabels()[safeUserIDLabel] != "u-123" || got.GetLabels()[grantIDLabel] != "gr-01jb7m9k2x" || got.GetAnnotations()[grantAttestationAnnotation] != "eyJ.test" {
		t.Fatalf("metadata=%v %v", got.GetLabels(), got.GetAnnotations())
	}
}

func TestWorkloadTimeoutSeconds(t *testing.T) {
	now := time.Date(2026, 10, 23, 9, 0, 0, 0, time.UTC)
	if got := workloadTimeoutSeconds(time.Time{}, now, 300*time.Second); got != 300 {
		t.Fatalf("unset start=%d", got)
	}
	if got := workloadTimeoutSeconds(now.Add(-90*time.Second), now, 300*time.Second); got != 390 {
		t.Fatalf("elapsed=%d", got)
	}
	if got := workloadTimeoutSeconds(now.Add(-1500*time.Millisecond), now, 2*time.Second); got != 4 {
		t.Fatalf("rounded=%d", got)
	}
}

func TestWorkloadObjectCarriesStepsAndHostPaths(t *testing.T) {
	ci := testCodeInterpreter()
	ci.Spec.Template.Steps = []runtimev1alpha1.SandboxBuildStep{
		{Type: "env", Args: []string{"RUNNER_CACHE=1"}},
		{Type: "workdir", Args: []string{"/opt/runner"}},
		{Type: "run", Args: []string{"install-runner"}},
	}
	ci.Spec.Template.Volumes = []corev1.Volume{{
		Name:         "cache",
		VolumeSource: corev1.VolumeSource{HostPath: &corev1.HostPathVolumeSource{Path: "/data/runner-cache"}},
	}}
	const sandboxID = "sbx-7a9b9b693452f613877992145c818d29"
	obj, err := workloadObject(sandboxID, e2b.CreateRequest{
		SandboxID: sandboxID, TemplateID: ci.Name, Role: "dev", SessionID: "s-8f2a",
		Workspace: "top-models", GrantID: "gr-01jb7m9k2x", Attestation: "eyJ.test",
	}, ci)
	if err != nil {
		t.Fatal(err)
	}
	env, _, _ := unstructured.NestedMap(obj.Object, "spec", "env")
	if env["RUNNER_CACHE"] != "1" || env[startupEnv] != "cd '/opt/runner' && install-runner" {
		t.Fatalf("env=%v", env)
	}
	paths, _, _ := unstructured.NestedStringSlice(obj.Object, "spec", "hostpath")
	if len(paths) != 1 || paths[0] != "/data/runner-cache" {
		t.Fatalf("hostpath=%v", paths)
	}
}

func TestROCRVisibleDevices(t *testing.T) {
	if rocrVisibleDevices(0) != "" || rocrVisibleDevices(1) != "0" || rocrVisibleDevices(2) != "0,1" {
		t.Fatalf("0=%q 1=%q 2=%q", rocrVisibleDevices(0), rocrVisibleDevices(1), rocrVisibleDevices(2))
	}
}

func testCodeInterpreter() *runtimev1alpha1.CodeInterpreter {
	return &runtimev1alpha1.CodeInterpreter{
		ObjectMeta: metav1.ObjectMeta{Name: "ar-run-dev-g2", Namespace: "agent-sandbox-system"},
		Spec: runtimev1alpha1.CodeInterpreterSpec{
			Template: &runtimev1alpha1.CodeInterpreterSandboxTemplate{
				FromImage: "example@sha256:aa",
				Environment: []corev1.EnvVar{
					{Name: "HYPERLOOM_ACTIVE_IMAGE_DIGEST", Value: "sha256:aa"},
					{Name: platformInferenceKey, Value: "secret"},
				},
				Resources: corev1.ResourceRequirements{
					Limits: corev1.ResourceList{
						corev1.ResourceCPU:    resource.MustParse("54"),
						corev1.ResourceMemory: resource.MustParse("500Gi"),
					},
				},
			},
			GPU: &runtimev1alpha1.GPUConfig{Count: 2, SharedMemory: "250Gi", ResourceName: "amd.com/gpu"},
		},
	}
}
