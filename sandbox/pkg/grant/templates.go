// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/sandboxlayer"
)

// grantIDKey labels and annotates a CodeInterpreter created for one grant.
const grantIDKey = "agent-sandbox.io/grant-id"

// gpuResourceName is the extended resource set on a per-GPU template.
const gpuResourceName = "amd.com/gpu"

// Per-card size applied to every GPU expansion. Card count scales these linearly.
// Eight cards are 192 CPU, 2048Gi memory, and 1500Gi pod storage.
const (
	cpuPerGPU      = 24
	memoryGiPerGPU = 256
	shmGiPerGPU    = 125
	imageDigestEnv = "HYPERLOOM_ACTIVE_IMAGE_DIGEST"
)

// storagePerGPU is the pod ephemeral storage for one GPU.
var storagePerGPU = resource.MustParse("187.5Gi")

// scaledStorage returns pod storage for the given card count.
func scaledStorage(gpus int32) resource.Quantity {
	q := storagePerGPU.DeepCopy()
	q.Mul(int64(gpus))
	return q
}

// registerTemplates creates a CodeInterpreter for each expansion whose spec
// names a fromImage. Specs without fromImage are skipped.
func (s *Service) registerTemplates(ctx context.Context, grantID, appRunID string, templates []runtimev1alpha1.GrantTemplate) error {
	var created []string
	for _, tpl := range templates {
		base, ok, err := templateFromSpec(tpl.Spec)
		if err != nil {
			s.deleteNamedTemplates(ctx, grantID, created)
			return opWrap(http.StatusBadRequest, "invalid_grant", "template spec is not JSON", err)
		}
		if !ok {
			continue
		}
		for i, name := range expandOne(appRunID, TemplateRequest{Name: tpl.Name, PerGPUCount: tpl.PerGPUCount}) {
			ci := codeInterpreter(grantID, name, base, templateGPUCount(tpl, i), s.namespace)
			if err := s.client.Create(ctx, ci); err != nil {
				s.deleteNamedTemplates(ctx, grantID, created)
				if apierrors.IsAlreadyExists(err) {
					return opErr(http.StatusConflict, "template_exists", name)
				}
				return opWrap(http.StatusInternalServerError, "template_register_failed", name, err)
			}
			created = append(created, name)
		}
	}
	return nil
}

// validateTemplateLayers rejects a grant whose template spec declares invalid layers.
func validateTemplateLayers(templates []runtimev1alpha1.GrantTemplate) error {
	for _, tpl := range templates {
		base, ok, err := templateFromSpec(tpl.Spec)
		if err != nil {
			return opWrap(http.StatusBadRequest, "invalid_grant", "template spec is not JSON", err)
		}
		if !ok {
			continue
		}
		if err := sandboxlayer.Validate(base.Layers, sandboxlayer.TemplateMounts(base)); err != nil {
			return opWrap(http.StatusBadRequest, "invalid_grant", "template "+tpl.Name+" layers are invalid", err)
		}
	}
	return nil
}

// resolveTemplateGPUCounts records quota counts independently of template names.
func (s *Service) resolveTemplateGPUCounts(ctx context.Context, appRunID string, templates []runtimev1alpha1.GrantTemplate) error {
	for i := range templates {
		tpl := &templates[i]
		if len(tpl.PerGPUCount) > 0 {
			tpl.GPUCounts = append([]int32(nil), tpl.PerGPUCount...)
			continue
		}
		_, generated, err := templateFromSpec(tpl.Spec)
		if err != nil {
			return opWrap(http.StatusBadRequest, "invalid_grant", "template spec is not JSON", err)
		}
		if generated {
			tpl.GPUCounts = []int32{0}
			continue
		}
		name := expandOne(appRunID, TemplateRequest{Name: tpl.Name})[0]
		ci := &runtimev1alpha1.CodeInterpreter{}
		if err := s.reader.Get(ctx, types.NamespacedName{Name: name, Namespace: s.namespace}, ci); err != nil {
			if apierrors.IsNotFound(err) {
				return opErr(http.StatusBadRequest, "invalid_grant", "template "+name+" does not exist")
			}
			return opWrap(http.StatusInternalServerError, "template_get_failed", name, err)
		}
		count := int32(0)
		if ci.Spec.GPU != nil {
			count = int32(ci.Spec.GPU.Count)
		}
		tpl.GPUCounts = []int32{count}
	}
	return nil
}

// checkResolvedGPUs rejects a template whose card count exceeds the attestation.
func (s *Service) checkResolvedGPUs(token string, templates []runtimev1alpha1.GrantTemplate) error {
	limit, err := s.attest.GPULimit(token)
	if err != nil {
		return err
	}
	for _, tpl := range templates {
		for _, n := range tpl.GPUCounts {
			if int(n) > limit {
				return opErr(http.StatusBadRequest, "attestation_invalid", "maxGpusPerSandbox is below a template card count")
			}
		}
	}
	return nil
}

func templateGPUCount(tpl runtimev1alpha1.GrantTemplate, index int) int32 {
	if index >= 0 && index < len(tpl.GPUCounts) {
		return tpl.GPUCounts[index]
	}
	if index >= 0 && index < len(tpl.PerGPUCount) {
		return tpl.PerGPUCount[index]
	}
	return 0
}

// deleteTemplates removes CodeInterpreters this grant registered.
func (s *Service) deleteTemplates(ctx context.Context, g *runtimev1alpha1.SandboxGrant) error {
	s.deleteNamedTemplates(ctx, g.Name, expandedNames(g))
	return nil
}

func (s *Service) deleteNamedTemplates(ctx context.Context, grantID string, names []string) {
	for _, name := range names {
		ci := &runtimev1alpha1.CodeInterpreter{}
		err := s.reader.Get(ctx, types.NamespacedName{Name: name, Namespace: s.namespace}, ci)
		if apierrors.IsNotFound(err) {
			continue
		}
		if err != nil {
			continue
		}
		if !ownedByGrant(ci, grantID) {
			continue
		}
		_ = s.client.Delete(ctx, ci)
	}
}

func expandedNames(g *runtimev1alpha1.SandboxGrant) []string {
	var names []string
	for _, tpl := range g.Spec.Templates {
		names = append(names, expandOne(g.Spec.Issuer.AppRunID, TemplateRequest{Name: tpl.Name, PerGPUCount: tpl.PerGPUCount})...)
	}
	return names
}

func codeInterpreter(grantID, name string, base *runtimev1alpha1.CodeInterpreterSandboxTemplate, gpus int32, namespace string) *runtimev1alpha1.CodeInterpreter {
	tmpl := &runtimev1alpha1.CodeInterpreterSandboxTemplate{}
	base.DeepCopyInto(tmpl)
	if gpus > 0 {
		cpu := resource.MustParse(fmt.Sprintf("%d", cpuPerGPU*gpus))
		mem := resource.MustParse(fmt.Sprintf("%dGi", memoryGiPerGPU*gpus))
		storage := scaledStorage(gpus)
		tmpl.Resources.Requests = corev1.ResourceList{
			corev1.ResourceCPU:              cpu,
			corev1.ResourceMemory:           mem,
			corev1.ResourceEphemeralStorage: storage,
		}
		tmpl.Resources.Limits = corev1.ResourceList{
			corev1.ResourceCPU:              cpu,
			corev1.ResourceMemory:           mem,
			corev1.ResourceEphemeralStorage: storage.DeepCopy(),
		}
	}
	if digest := digestOf(tmpl.FromImage); digest != "" {
		tmpl.Environment = append(tmpl.Environment, corev1.EnvVar{Name: imageDigestEnv, Value: digest})
	}
	ci := &runtimev1alpha1.CodeInterpreter{
		ObjectMeta: metav1.ObjectMeta{
			Name:        name,
			Namespace:   namespace,
			Annotations: map[string]string{grantIDKey: grantID},
		},
		Spec: runtimev1alpha1.CodeInterpreterSpec{Template: tmpl},
	}
	if len(grantID) <= 63 {
		ci.Labels = map[string]string{grantIDKey: grantID}
	}
	if gpus > 0 {
		ci.Spec.GPU = &runtimev1alpha1.GPUConfig{
			Count:        int(gpus),
			ResourceName: gpuResourceName,
			SharedMemory: fmt.Sprintf("%dGi", shmGiPerGPU*gpus),
		}
	}
	if measurementTemplate(name) {
		ci.Spec.RuntimePolicy = "agent-restricted"
	}
	return ci
}

// measurementTemplate reports whether name is the measurement template or one
// of its per-GPU expansions, such as ar-01ja-measurement-g8.
func measurementTemplate(name string) bool {
	base := name
	if i := strings.LastIndex(name, "-g"); i > 0 && digitsOnly(name[i+2:]) {
		base = name[:i]
	}
	return base == "measurement" || strings.HasSuffix(base, "-measurement")
}

func digitsOnly(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func ownedByGrant(ci *runtimev1alpha1.CodeInterpreter, grantID string) bool {
	if ci.Labels != nil && ci.Labels[grantIDKey] == grantID {
		return true
	}
	return ci.Annotations != nil && ci.Annotations[grantIDKey] == grantID
}

func templateFromSpec(spec string) (*runtimev1alpha1.CodeInterpreterSandboxTemplate, bool, error) {
	if spec == "" {
		return nil, false, nil
	}
	var body struct {
		FromImage string                                          `json:"fromImage"`
		Template  *runtimev1alpha1.CodeInterpreterSandboxTemplate `json:"template"`
	}
	if err := json.Unmarshal([]byte(spec), &body); err != nil {
		return nil, false, err
	}
	if body.Template != nil && body.Template.FromImage != "" {
		return body.Template, true, nil
	}
	if body.FromImage == "" {
		return nil, false, nil
	}
	var flat runtimev1alpha1.CodeInterpreterSandboxTemplate
	if err := json.Unmarshal([]byte(spec), &flat); err != nil {
		return nil, false, err
	}
	return &flat, true, nil
}

func digestOf(image string) string {
	const marker = "@sha256:"
	i := strings.Index(image, marker)
	if i < 0 {
		return ""
	}
	digest := image[i+1:]
	if len(digest) <= len("sha256:") {
		return ""
	}
	return digest
}
