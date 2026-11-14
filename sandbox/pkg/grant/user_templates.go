// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"context"
	"net/http"
	"strconv"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
)

// Labels on a CodeInterpreter that a user created through the template API.
const (
	// TemplateWorkspaceLabel names the SaFE workspace a user template runs in.
	TemplateWorkspaceLabel = "runtime.agent-sandbox.io/workspace"
	// TemplateUserLabel is the user id of the template creator.
	TemplateUserLabel = "runtime.agent-sandbox.io/user.id"
	// TemplatePublicLabel is "true" on a template every user may use.
	TemplatePublicLabel = "runtime.agent-sandbox.io/public"
	// ReservedTemplatePrefix starts the names of owner policy templates.
	ReservedTemplatePrefix = "e2b-"
)

// UserTemplate is a workspace template created through the template API.
type UserTemplate struct {
	Name      string
	Workspace string
	UserID    string
	Public    bool
	GPUs      int32
}

// TemplateNotFound is the 404 error for a template id that names no usable template.
func TemplateNotFound(name string) error {
	return opErr(http.StatusNotFound, "template_not_found", "template "+strconv.Quote(name)+" not found")
}

// UserTemplate reads the user template name from the grant namespace. A missing
// template, one without a workspace label, and one a grant owns are 404.
func (s *Service) UserTemplate(ctx context.Context, name string) (UserTemplate, error) {
	ci := &runtimev1alpha1.CodeInterpreter{}
	err := s.reader.Get(ctx, types.NamespacedName{Namespace: s.namespace, Name: name}, ci)
	if apierrors.IsNotFound(err) {
		return UserTemplate{}, TemplateNotFound(name)
	}
	if err != nil {
		return UserTemplate{}, opWrap(http.StatusServiceUnavailable, "template_unavailable", "template is temporarily unreadable", err)
	}
	workspace := ci.Labels[TemplateWorkspaceLabel]
	if workspace == "" || ci.Labels[grantIDKey] != "" {
		return UserTemplate{}, TemplateNotFound(name)
	}
	out := UserTemplate{
		Name:      ci.Name,
		Workspace: workspace,
		UserID:    ci.Labels[TemplateUserLabel],
		Public:    ci.Labels[TemplatePublicLabel] == "true",
	}
	if ci.Spec.GPU != nil && ci.Spec.GPU.Count > 0 {
		out.GPUs = int32(ci.Spec.GPU.Count)
	}
	return out, nil
}
