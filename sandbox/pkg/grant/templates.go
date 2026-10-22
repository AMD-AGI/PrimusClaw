// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
)

// grantIDKey labels and annotates a CodeInterpreter created for one grant.
const grantIDKey = "agent-sandbox.io/grant-id"

// gpuResourceName is the extended resource set on a per-GPU template.
const gpuResourceName = "amd.com/gpu"

// registerTemplates creates a CodeInterpreter for each expansion whose spec
// names a fromImage. Specs without fromImage are skipped.
func (s *Service) registerTemplates(ctx context.Context, grantID, appRunID string, templates []runtimev1alpha1.GrantTemplate) error {
	var created []string
	for _, tpl := range templates {
		image, ok, err := fromImage(tpl.Spec)
		if err != nil {
			s.deleteNamedTemplates(ctx, grantID, created)
			return opWrap(http.StatusBadRequest, "invalid_grant", "template spec is not JSON", err)
		}
		if !ok {
			continue
		}
		for _, name := range expandOne(appRunID, TemplateRequest{Name: tpl.Name, PerGPUCount: tpl.PerGPUCount}) {
			ci := codeInterpreter(grantID, name, image, gpusFromName(name), s.namespace)
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

func codeInterpreter(grantID, name, image string, gpus int32, namespace string) *runtimev1alpha1.CodeInterpreter {
	ci := &runtimev1alpha1.CodeInterpreter{
		ObjectMeta: metav1.ObjectMeta{
			Name:        name,
			Namespace:   namespace,
			Annotations: map[string]string{grantIDKey: grantID},
		},
		Spec: runtimev1alpha1.CodeInterpreterSpec{
			Template: &runtimev1alpha1.CodeInterpreterSandboxTemplate{FromImage: image},
		},
	}
	if len(grantID) <= 63 {
		ci.Labels = map[string]string{grantIDKey: grantID}
	}
	if gpus > 0 {
		ci.Spec.GPU = &runtimev1alpha1.GPUConfig{Count: int(gpus), ResourceName: gpuResourceName}
	}
	return ci
}

func ownedByGrant(ci *runtimev1alpha1.CodeInterpreter, grantID string) bool {
	if ci.Labels != nil && ci.Labels[grantIDKey] == grantID {
		return true
	}
	return ci.Annotations != nil && ci.Annotations[grantIDKey] == grantID
}

func fromImage(spec string) (string, bool, error) {
	if spec == "" {
		return "", false, nil
	}
	var body struct {
		FromImage string `json:"fromImage"`
		Template  *struct {
			FromImage string `json:"fromImage"`
		} `json:"template"`
	}
	if err := json.Unmarshal([]byte(spec), &body); err != nil {
		return "", false, err
	}
	if body.Template != nil && body.Template.FromImage != "" {
		return body.Template.FromImage, true, nil
	}
	if body.FromImage != "" {
		return body.FromImage, true, nil
	}
	return "", false, nil
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
