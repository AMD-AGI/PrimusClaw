// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
)

// grantIDKey labels and annotates a CodeInterpreter created for one grant.
const grantIDKey = "agent-sandbox.io/grant-id"

// gpuResourceName is the extended resource set on a per-GPU template.
const gpuResourceName = "amd.com/gpu"

// Per-card size applied to every GPU expansion. Card count scales these linearly.
const (
	cpuPerGPU      = 27
	memoryGiPerGPU = 250
	shmGiPerGPU    = 125
	imageDigestEnv = "HYPERLOOM_ACTIVE_IMAGE_DIGEST"
)

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
		for _, name := range expandOne(appRunID, TemplateRequest{Name: tpl.Name, PerGPUCount: tpl.PerGPUCount}) {
			ci := codeInterpreter(grantID, name, base, gpusFromName(name), s.namespace)
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

// deleteTemplates removes CodeInterpreters this grant registered.
func (s *Service) deleteTemplates(ctx context.Context, g *runtimev1alpha1.SandboxGrant) error {
	s.deleteNamedTemplates(ctx, g.Name, expandedNames(g))
	return nil
}

func (s *Service) deleteNamedTemplates(ctx context.Context, grantID string, names []string) {
	for _, name := range names {
		ci := &runtimev1alpha1.CodeInterpreter{}
		err := s.client.Get(ctx, types.NamespacedName{Name: name, Namespace: s.namespace}, ci)
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
		tmpl.Resources.Requests = corev1.ResourceList{
			corev1.ResourceCPU:    cpu,
			corev1.ResourceMemory: mem,
		}
		tmpl.Resources.Limits = corev1.ResourceList{
			corev1.ResourceCPU:    cpu,
			corev1.ResourceMemory: mem,
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
	return ci
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

// gpusFromName reads the -gN suffix of an expanded template name.
func gpusFromName(name string) int32 {
	i := strings.LastIndex(name, "-g")
	if i < 0 || i+2 >= len(name) {
		return 0
	}
	n, err := strconv.Atoi(name[i+2:])
	if err != nil || n < 0 {
		return 0
	}
	return int32(n)
}
