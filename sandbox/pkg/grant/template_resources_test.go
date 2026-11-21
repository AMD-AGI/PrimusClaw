// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/apimachinery/pkg/types"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
)

const resourcesImage = "example@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

// issueTemplates issues one grant whose measurement role lists every template.
// Each spec is written as Claw sends it: the manifest template less name and
// per_gpu_count, with image and workspace filled in.
func issueTemplates(t *testing.T, templates []TemplateRequest) (*Service, error) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Second)
	svc, priv, _, _ := testService(t, now)
	req := sampleRequest(now.Add(time.Hour))
	names := make([]string, 0, len(templates))
	for _, tpl := range templates {
		names = append(names, tpl.Name)
	}
	req.Roles = map[string]RoleRequest{"measurement": {Templates: names, MaxSandboxes: 16, MaxGPUs: 128}}
	req.Templates = templates
	req.Attestation = signGrant(t, priv, req)
	_, _, err := svc.Issue(context.Background(), req)
	return svc, err
}

func clawSpec(resources string) json.RawMessage {
	body := `{"fromImage":"` + resourcesImage + `","image":"` + resourcesImage + `","workspace":"lab"`
	if resources != "" {
		body += `,` + resources
	}
	return json.RawMessage(body + `}`)
}

func getCI(t *testing.T, svc *Service, name string) *runtimev1alpha1.CodeInterpreter {
	t.Helper()
	ci := &runtimev1alpha1.CodeInterpreter{}
	if err := svc.client.Get(context.Background(), types.NamespacedName{Name: name, Namespace: svc.namespace}, ci); err != nil {
		t.Fatal(name, err)
	}
	return ci
}

// wantShape is the exact size of one expansion; every value is compared with Cmp.
type wantShape struct {
	gpus                   int
	cpuReq, cpuLim         string
	memReq, memLim         string
	storageReq, storageLim string
	shm                    string
}

func assertShape(t *testing.T, ci *runtimev1alpha1.CodeInterpreter, want wantShape) {
	t.Helper()
	r := ci.Spec.Template.Resources
	check := func(kind string, list corev1.ResourceList, name corev1.ResourceName, value string) {
		got, ok := list[name]
		if !ok {
			t.Fatalf("%s: %s has no %s: %v", ci.Name, kind, name, list)
		}
		if got.Cmp(resource.MustParse(value)) != 0 {
			t.Errorf("%s: %s.%s = %s, want %s", ci.Name, kind, name, got.String(), value)
		}
	}
	check("requests", r.Requests, corev1.ResourceCPU, want.cpuReq)
	check("limits", r.Limits, corev1.ResourceCPU, want.cpuLim)
	check("requests", r.Requests, corev1.ResourceMemory, want.memReq)
	check("limits", r.Limits, corev1.ResourceMemory, want.memLim)
	check("requests", r.Requests, corev1.ResourceEphemeralStorage, want.storageReq)
	check("limits", r.Limits, corev1.ResourceEphemeralStorage, want.storageLim)
	if len(r.Requests) != 3 || len(r.Limits) != 3 {
		t.Errorf("%s: resources carry other names: %v", ci.Name, r)
	}
	if ci.Spec.GPU == nil || ci.Spec.GPU.Count != want.gpus || ci.Spec.GPU.ResourceName != gpuResourceName {
		t.Fatalf("%s: gpu=%+v, want %d cards", ci.Name, ci.Spec.GPU, want.gpus)
	}
	if got := resource.MustParse(ci.Spec.GPU.SharedMemory); got.Cmp(resource.MustParse(want.shm)) != 0 {
		t.Errorf("%s: sharedMemory = %s, want %s", ci.Name, ci.Spec.GPU.SharedMemory, want.shm)
	}
}

// Top-model measurement templates size CPU and memory to what each
// model needs, not to a share of the node. Each rule is used once: requests
// only, limits only, and both.
func TestTemplateResourcesTopModelShapes(t *testing.T) {
	svc, err := issueTemplates(t, []TemplateRequest{
		{Name: "ds-tp2", PerGPUCount: []int32{2}, Spec: clawSpec(`"resources":{"requests":{"cpu":"16","memory":"448Gi"}}`)},
		{Name: "glm-tp4", PerGPUCount: []int32{4}, Spec: clawSpec(`"resources":{"limits":{"cpu":"24","memory":"1200Gi"}}`)},
		{Name: "minimax-tp4", PerGPUCount: []int32{4}, Spec: clawSpec(`"resources":{"requests":{"cpu":"24","memory":"1400Gi"},"limits":{"cpu":"24","memory":"1400Gi"}}`)},
		{Name: "kimi-tp8", PerGPUCount: []int32{8}, Spec: json.RawMessage(`{"template":{"fromImage":"` + resourcesImage + `","resources":{"requests":{"cpu":"32","memory":"1792Gi"},"limits":{"memory":"1792Gi"}}}}`)},
	})
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]wantShape{
		"ar-01ja-ds-tp2-g2":      {2, "16", "16", "448Gi", "448Gi", "375Gi", "375Gi", "250Gi"},
		"ar-01ja-glm-tp4-g4":     {4, "24", "24", "1200Gi", "1200Gi", "750Gi", "750Gi", "500Gi"},
		"ar-01ja-minimax-tp4-g4": {4, "24", "24", "1400Gi", "1400Gi", "750Gi", "750Gi", "500Gi"},
		"ar-01ja-kimi-tp8-g8":    {8, "32", "32", "1792Gi", "1792Gi", "1500Gi", "1500Gi", "1000Gi"},
	} {
		assertShape(t, getCI(t, svc, name), want)
	}
}

// A template with no resources keeps the per-card linear size, exactly as before.
func TestTemplateResourcesDefaultIsPerCardLinear(t *testing.T) {
	svc, err := issueTemplates(t, []TemplateRequest{
		{Name: "runner", PerGPUCount: []int32{1, 2, 4, 8}, Spec: clawSpec("")},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []wantShape{
		{1, "24", "24", "224Gi", "224Gi", "187.5Gi", "187.5Gi", "125Gi"},
		{2, "48", "48", "448Gi", "448Gi", "375Gi", "375Gi", "250Gi"},
		{4, "96", "96", "896Gi", "896Gi", "750Gi", "750Gi", "500Gi"},
		{8, "192", "192", "1792Gi", "1792Gi", "1500Gi", "1500Gi", "1000Gi"},
	} {
		ci := getCI(t, svc, fmt.Sprintf("ar-01ja-runner-g%d", want.gpus))
		assertShape(t, ci, want)
		if ci.Spec.GPU.SharedMemory != fmt.Sprintf("%dGi", 125*want.gpus) {
			t.Errorf("g%d sharedMemory spelled %q", want.gpus, ci.Spec.GPU.SharedMemory)
		}
	}
}

// Only what the template leaves out falls back to the per-card size, per field
// and per resource, and every expansion of a template takes the same values.
func TestTemplateResourcesPartialOverride(t *testing.T) {
	svc, err := issueTemplates(t, []TemplateRequest{
		{Name: "cpu-only", PerGPUCount: []int32{1, 4}, Spec: clawSpec(`"resources":{"requests":{"cpu":"8"},"limits":{"cpu":"16"}}`)},
		{Name: "mem-only", PerGPUCount: []int32{2}, Spec: clawSpec(`"resources":{"requests":{"memory":"300Gi"}}`)},
		{Name: "shm-storage", PerGPUCount: []int32{2}, Spec: clawSpec(`"resources":{"limits":{"ephemeral-storage":"500Gi"}},"gpu":{"sharedMemory":"64Gi"}`)},
		{Name: "small", PerGPUCount: []int32{2}, Spec: clawSpec(`"resources":{"limits":{"memory":"100Gi"}}`)},
	})
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]wantShape{
		"ar-01ja-cpu-only-g1":    {1, "8", "16", "224Gi", "224Gi", "187.5Gi", "187.5Gi", "125Gi"},
		"ar-01ja-cpu-only-g4":    {4, "8", "16", "896Gi", "896Gi", "750Gi", "750Gi", "500Gi"},
		"ar-01ja-mem-only-g2":    {2, "48", "48", "300Gi", "300Gi", "375Gi", "375Gi", "250Gi"},
		"ar-01ja-shm-storage-g2": {2, "48", "48", "448Gi", "448Gi", "500Gi", "500Gi", "64Gi"},
		// The default shared memory (250Gi) is lowered to the 100Gi memory limit.
		"ar-01ja-small-g2": {2, "48", "48", "100Gi", "100Gi", "375Gi", "375Gi", "100Gi"},
	} {
		assertShape(t, getCI(t, svc, name), want)
	}
}

// A template without cards keeps its resources as written, as before.
func TestTemplateResourcesCPUTemplateUnchanged(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	svc, priv, _, _ := testService(t, now)
	req := sampleRequest(now.Add(time.Hour))
	req.Templates = []TemplateRequest{{Name: "runner", Spec: clawSpec(`"resources":{"requests":{"cpu":"2"},"limits":{"memory":"8Gi"}}`)}}
	req.Attestation = signGrant(t, priv, req)
	if _, _, err := svc.Issue(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	ci := getCI(t, svc, "ar-01ja-runner")
	if ci.Spec.GPU != nil {
		t.Fatalf("gpu=%+v", ci.Spec.GPU)
	}
	r := ci.Spec.Template.Resources
	if len(r.Requests) != 1 || len(r.Limits) != 1 {
		t.Fatalf("resources=%v", r)
	}
	if q := r.Requests[corev1.ResourceCPU]; q.Cmp(resource.MustParse("2")) != 0 {
		t.Fatalf("cpu=%s", q.String())
	}
	if q := r.Limits[corev1.ResourceMemory]; q.Cmp(resource.MustParse("8Gi")) != 0 {
		t.Fatalf("memory=%s", q.String())
	}
}

// Nonsense is refused with 400 at issue, names what is wrong, and registers nothing.
func TestTemplateResourcesRejected(t *testing.T) {
	for _, tc := range []struct {
		name, spec, want string
		cards            []int32
	}{
		{"zero cpu", `"resources":{"requests":{"cpu":"0"}}`, "resources.requests.cpu must be positive", nil},
		{"negative memory", `"resources":{"limits":{"memory":"-1Gi"}}`, "resources.limits.memory must be positive", nil},
		{"zero storage", `"resources":{"limits":{"ephemeral-storage":"0"}}`, "resources.limits.ephemeral-storage must be positive", nil},
		{"request above limit", `"resources":{"requests":{"cpu":"32"},"limits":{"cpu":"16"}}`, "resources.requests.cpu 32 exceeds resources.limits.cpu 16", nil},
		{"memory request above limit", `"resources":{"requests":{"memory":"2Ti"},"limits":{"memory":"1Ti"}}`, "resources.requests.memory 2Ti exceeds", nil},
		{"gpu resource", `"resources":{"limits":{"amd.com/gpu":"4"}}`, "not amd.com/gpu", nil},
		{"not a quantity", `"resources":{"requests":{"cpu":"lots"}}`, "spec is invalid", nil},
		{"shm above memory", `"resources":{"limits":{"memory":"64Gi"}},"gpu":{"sharedMemory":"128Gi"}`, "gpu.sharedMemory 128Gi exceeds the memory limit 64Gi", nil},
		{"zero shm", `"gpu":{"sharedMemory":"0"}`, "gpu.sharedMemory must be positive", nil},
		{"gpu count in spec", `"gpu":{"count":2}`, "gpu may set only sharedMemory", nil},
		{"shm without cards", `"gpu":{"sharedMemory":"8Gi"}`, "without GPUs", []int32{}},
		{"cpu template request above limit", `"resources":{"requests":{"memory":"16Gi"},"limits":{"memory":"8Gi"}}`, "resources.requests.memory 16Gi exceeds", []int32{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cards := []int32{1, 8}
			if tc.cards != nil {
				cards = tc.cards
			}
			svc, err := issueTemplates(t, []TemplateRequest{{Name: "runner", PerGPUCount: cards, Spec: clawSpec(tc.spec)}})
			var op *OpError
			if !errors.As(err, &op) || op.Status != http.StatusBadRequest || op.Reason != "invalid_grant" {
				t.Fatalf("err = %v", err)
			}
			if !strings.Contains(op.Error(), tc.want) {
				t.Fatalf("error %q does not say %q", op.Error(), tc.want)
			}
			list := &runtimev1alpha1.CodeInterpreterList{}
			if err := svc.client.List(context.Background(), list); err != nil {
				t.Fatal(err)
			}
			if len(list.Items) != 0 {
				t.Fatalf("registered %d templates", len(list.Items))
			}
		})
	}
}

// The owner policy registers its templates through the same rule and refuses
// the same nonsense before anything is stored.
func TestOwnerPolicyTemplateResources(t *testing.T) {
	ctx := context.Background()
	r := newStoreRig(t, storePolicy, nil)
	if err := r.store.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	spec := `{"fromImage":"harbor.example/runner@sha256:0123456789abcdef","resources":{"requests":{"cpu":"16","memory":"448Gi"}}}`
	if _, err := r.store.PutTemplate(ctx, TemplateRequest{Name: "ds", PerGPUCount: []int32{2}, Spec: json.RawMessage(spec)}); err != nil {
		t.Fatal(err)
	}
	ci := &runtimev1alpha1.CodeInterpreter{}
	if err := r.cl.Get(ctx, types.NamespacedName{Namespace: storeNS, Name: "e2b-ds-g2"}, ci); err != nil {
		t.Fatal(err)
	}
	assertShape(t, ci, wantShape{2, "16", "16", "448Gi", "448Gi", "375Gi", "375Gi", "250Gi"})

	before := r.stored(t)
	bad := `{"fromImage":"harbor.example/runner@sha256:0123456789abcdef","resources":{"requests":{"cpu":"32"},"limits":{"cpu":"16"}}}`
	_, err := r.store.PutTemplate(ctx, TemplateRequest{Name: "bad", PerGPUCount: []int32{2}, Spec: json.RawMessage(bad)})
	var op *OpError
	if !errors.As(err, &op) || op.Status != http.StatusBadRequest || op.Reason != "invalid_owner_policy" || !strings.Contains(op.Error(), "exceeds resources.limits.cpu") {
		t.Fatalf("err = %v", err)
	}
	if r.stored(t) != before || r.ciExists(t, "e2b-bad-g2") {
		t.Fatal("a refused template was stored or registered")
	}
}
