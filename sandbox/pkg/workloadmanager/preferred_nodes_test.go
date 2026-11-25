// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynfake "k8s.io/client-go/dynamic/fake"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/e2b"
)

// A template's preferredNodes become SaFE's specified-nodes next to the
// create's excluded-nodes, a node in both is only avoided, and either list
// makes the node affinity preferred.
func TestWorkloadObjectNodePreferences(t *testing.T) {
	cases := []struct {
		name      string
		preferred []string
		avoid     string
		labels    map[string]any
	}{
		{name: "none"},
		{
			name:      "specified only",
			preferred: []string{"node-a", "node-b"},
			labels:    map[string]any{"specified-nodes": "node-a node-b"},
		},
		{
			name:   "avoid only",
			avoid:  "node-c node-d",
			labels: map[string]any{"excluded-nodes": "node-c node-d"},
		},
		{
			name:      "specified and avoid",
			preferred: []string{"node-a", "node-b"},
			avoid:     "node-c",
			labels:    map[string]any{"specified-nodes": "node-a node-b", "excluded-nodes": "node-c"},
		},
		{
			name:      "avoid wins on overlap",
			preferred: []string{"node-a", "node-b", "node-c"},
			avoid:     "node-b node-d",
			labels:    map[string]any{"specified-nodes": "node-a node-c", "excluded-nodes": "node-b node-d"},
		},
		{
			name:      "every preferred node avoided",
			preferred: []string{"node-a"},
			avoid:     "node-a",
			labels:    map[string]any{"excluded-nodes": "node-a"},
		},
	}
	const sandboxID = "sbx-7a9b9b693452f613877992145c818d29"
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ci := testCodeInterpreter()
			ci.Spec.Template.PreferredNodes = tc.preferred
			req := e2b.CreateRequest{SandboxID: sandboxID, TemplateID: "ar-run-dev-g2", Role: "dev", SessionID: "s-8f2a", Workspace: "top-models", GrantID: "gr-1", Attestation: "eyJ.test", AvoidNodes: tc.avoid}
			obj, err := workloadObject(sandboxID, req, ci)
			if err != nil {
				t.Fatal(err)
			}
			labels, found, _ := unstructured.NestedMap(obj.Object, "spec", "customerLabels")
			if tc.labels == nil {
				if found {
					t.Fatalf("customerLabels=%v, want none", labels)
				}
			} else if len(labels) != len(tc.labels) {
				t.Fatalf("customerLabels=%v, want %v", labels, tc.labels)
			}
			for key, want := range tc.labels {
				if labels[key] != want {
					t.Fatalf("customerLabels=%v, want %v", labels, tc.labels)
				}
			}
			affinity, ok := obj.GetAnnotations()[nodesAffinityAnnotation]
			if tc.labels == nil {
				if ok {
					t.Fatalf("annotations=%v, want no node affinity", obj.GetAnnotations())
				}
			} else if affinity != nodesAffinityPreferred {
				t.Fatalf("annotations=%v, want preferred", obj.GetAnnotations())
			}
			if got := workloadPreferredNodes(obj); got != stringOr(tc.labels["specified-nodes"]) {
				t.Fatalf("workloadPreferredNodes=%q", got)
			}
		})
	}
}

func stringOr(v any) string {
	s, _ := v.(string)
	return s
}

// A template stored with invalid preferredNodes (outside the API) makes no Workload.
func TestWorkloadObjectRefusesInvalidPreferredNodes(t *testing.T) {
	const sandboxID = "sbx-7a9b9b693452f613877992145c818d29"
	for name, nodes := range map[string][]string{
		"blank":  {"node-a node-b"},
		"twice":  {"node-a", "node-a"},
		"upper":  {"Node-A"},
		"nine":   {"n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9"},
		"spaces": {" node-a"},
	} {
		t.Run(name, func(t *testing.T) {
			ci := testCodeInterpreter()
			ci.Spec.Template.PreferredNodes = nodes
			req := e2b.CreateRequest{SandboxID: sandboxID, TemplateID: "ar-run-dev-g2", Role: "dev", SessionID: "s-8f2a", Workspace: "top-models", GrantID: "gr-1", Attestation: "eyJ.test"}
			if _, err := workloadObject(sandboxID, req, ci); err == nil || !strings.Contains(err.Error(), "preferredNodes") {
				t.Fatalf("err=%v", err)
			}
		})
	}
}

// The template API refuses invalid preferredNodes and accepts valid ones.
func TestValidateTemplateRequestPreferredNodes(t *testing.T) {
	spec := func(nodes ...string) runtimev1alpha1.CodeInterpreterSpec {
		return runtimev1alpha1.CodeInterpreterSpec{Template: &runtimev1alpha1.CodeInterpreterSandboxTemplate{FromImage: "example", PreferredNodes: nodes}}
	}
	if err := validateTemplateRequest(spec("gpu-node-1", "gpu-node-2")); err != nil {
		t.Fatal(err)
	}
	if err := validateTemplateRequest(runtimev1alpha1.CodeInterpreterSpec{}); err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][]string{{"gpu-node-1", "gpu-node-1"}, {"Gpu-Node"}, {"n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9"}} {
		if err := validateTemplateRequest(spec(bad...)); err == nil || !strings.Contains(err.Error(), "preferredNodes") {
			t.Fatalf("%v: err=%v", bad, err)
		}
	}
}

// Observe reports the specified-nodes of a running Workload, so a sandbox
// adopted after a restart is marked like one created in this process.
func TestObserveReportsPreferredNodes(t *testing.T) {
	const name = "sbx-remote"
	dc := dynfake.NewSimpleDynamicClientWithCustomListKinds(k8sruntime.NewScheme(), map[schema.GroupVersionResource]string{
		workloadGVR: "WorkloadList",
	})
	obj := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "amd.com/v1",
		"kind":       "Workload",
		"metadata": map[string]any{
			"name":   name,
			"labels": map[string]any{safeClusterIDLabel: "cluster-a"},
		},
		"spec": map[string]any{
			"workspace":      "ws-a",
			"customerLabels": map[string]any{"specified-nodes": "node-a node-b", "excluded-nodes": "node-c"},
		},
		"status": map[string]any{
			"phase":     "Running",
			"nodeUsage": []any{map[string]any{"node": "node-b"}},
		},
	}}
	if _, err := dc.Resource(workloadGVR).Create(context.Background(), obj, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	creator := NewSafeWorkloadCreator(dc, nil)
	creator.SetRemoteClusters([]string{"cluster-a"})
	result, phase, err := creator.Observe(context.Background(), name)
	if err != nil || phase != e2b.WorkloadRunning || result.NodeName != "node-b" || result.PreferredNodes != "node-a node-b" {
		t.Fatalf("result=%+v phase=%q err=%v", result, phase, err)
	}
}
