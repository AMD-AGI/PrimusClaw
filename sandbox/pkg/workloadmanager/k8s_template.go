// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"fmt"

	k8serrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
)

// TemplateListResult is the response payload for listing CodeInterpreter templates.
type TemplateListResult struct {
	Items []runtimev1alpha1.CodeInterpreter `json:"items"`
	Total int                               `json:"total"`
}

// CreateTemplateRequest is the request body for POST /v1/templates.
type CreateTemplateRequest struct {
	// Name of the CodeInterpreter resource.
	Name string `json:"name" binding:"required"`
	// Namespace defaults to "default".
	Namespace string `json:"namespace"`
	// Spec is the full CodeInterpreterSpec.
	Spec runtimev1alpha1.CodeInterpreterSpec `json:"spec" binding:"required"`
	// Public marks the template as visible/usable by all users.
	// Only system-admin can set this to true; non-admin requests are silently downgraded to false.
	Public bool `json:"public"`
	// Dockerfile content for image pre-building. If provided, the platform builds
	// the image via kaniko and uses the resulting image as template.fromImage.
	// The original fromImage is used as the base image in the Dockerfile.
	Dockerfile string `json:"dockerfile,omitempty"`
}

// UpdateTemplateRequest is the request body for PUT /v1/templates/:namespace/:name.
type UpdateTemplateRequest struct {
	// Spec is the full CodeInterpreterSpec to replace the existing one.
	Spec runtimev1alpha1.CodeInterpreterSpec `json:"spec" binding:"required"`
	// Public optionally changes the template's public visibility.
	// Only system-admin can change this. nil means no change.
	Public *bool `json:"public,omitempty"`
}

// CreateTemplate creates a new CodeInterpreter CRD object in Kubernetes.
// If user is non-nil, stamps user identity annotations for auditing.
// If public is true, marks the template as publicly visible/usable.
func (c *K8sSandboxCreator) CreateTemplate(ctx context.Context, name, namespace string, spec runtimev1alpha1.CodeInterpreterSpec, user *UserIdentity, public bool) (*runtimev1alpha1.CodeInterpreter, error) {
	if namespace == "" {
		namespace = "default"
	}

	// Build labels + annotations — following SaFE convention:
	// userId → Label (queryable), userName → Annotation (special chars safe)
	ciLabels := map[string]string{}
	ciAnnotations := map[string]string{}
	if user != nil {
		if user.UserID != "" {
			ciLabels[userIDLabelKey] = user.UserID
		}
		if user.UserName != "" {
			ciAnnotations[userNameAnnotationKey] = user.UserName
		}
	}

	// Public visibility label
	if public {
		ciLabels[templatePublicLabelKey] = "true"
	}

	ci := &runtimev1alpha1.CodeInterpreter{
		ObjectMeta: metav1.ObjectMeta{
			Name:        name,
			Namespace:   namespace,
			Labels:      ciLabels,
			Annotations: ciAnnotations,
		},
		Spec: spec,
	}
	if err := c.client.Create(ctx, ci); err != nil {
		if k8serrors.IsAlreadyExists(err) {
			return nil, fmt.Errorf("template %s/%s already exists", namespace, name)
		}
		return nil, fmt.Errorf("create CodeInterpreter: %w", err)
	}
	return ci, nil
}

// GetTemplate fetches a single CodeInterpreter by name and namespace.
func (c *K8sSandboxCreator) GetTemplate(ctx context.Context, name, namespace string) (*runtimev1alpha1.CodeInterpreter, error) {
	if namespace == "" {
		namespace = "default"
	}
	ci := &runtimev1alpha1.CodeInterpreter{}
	key := ctrlclient.ObjectKey{Name: name, Namespace: namespace}
	if err := c.client.Get(ctx, key, ci); err != nil {
		if k8serrors.IsNotFound(err) {
			return nil, fmt.Errorf("template %s/%s not found", namespace, name)
		}
		return nil, fmt.Errorf("get CodeInterpreter: %w", err)
	}
	return ci, nil
}

// ListTemplates returns CodeInterpreter objects, optionally filtered by namespace and/or userID.
// When userID is non-empty, uses K8s Label Selector (server-side filtering, no full scan).
// userName filtering cannot use selectors (it's an Annotation) — done in the handler layer.
func (c *K8sSandboxCreator) ListTemplates(ctx context.Context, namespace, userID string) (*TemplateListResult, error) {
	list := &runtimev1alpha1.CodeInterpreterList{}
	opts := []ctrlclient.ListOption{}
	if namespace != "" {
		opts = append(opts, ctrlclient.InNamespace(namespace))
	}
	// userId is a Label → use K8s MatchingLabels for server-side filtering
	if userID != "" {
		opts = append(opts, ctrlclient.MatchingLabels{userIDLabelKey: userID})
	}
	if err := c.client.List(ctx, list, opts...); err != nil {
		return nil, fmt.Errorf("list CodeInterpreters: %w", err)
	}
	return &TemplateListResult{
		Items: list.Items,
		Total: len(list.Items),
	}, nil
}

// UpdateTemplate replaces the spec of an existing CodeInterpreter.
// If public is non-nil, also updates the public visibility label.
func (c *K8sSandboxCreator) UpdateTemplate(ctx context.Context, name, namespace string, spec runtimev1alpha1.CodeInterpreterSpec, public *bool) (*runtimev1alpha1.CodeInterpreter, error) {
	if namespace == "" {
		namespace = "default"
	}
	// Fetch existing to preserve metadata (resourceVersion is required for updates).
	ci := &runtimev1alpha1.CodeInterpreter{}
	key := ctrlclient.ObjectKey{Name: name, Namespace: namespace}
	if err := c.client.Get(ctx, key, ci); err != nil {
		if k8serrors.IsNotFound(err) {
			return nil, fmt.Errorf("template %s/%s not found", namespace, name)
		}
		return nil, fmt.Errorf("get CodeInterpreter for update: %w", err)
	}
	ci.Spec = spec

	// Update public label if specified
	if public != nil {
		if ci.Labels == nil {
			ci.Labels = make(map[string]string)
		}
		if *public {
			ci.Labels[templatePublicLabelKey] = "true"
		} else {
			delete(ci.Labels, templatePublicLabelKey)
		}
	}

	if err := c.client.Update(ctx, ci); err != nil {
		return nil, fmt.Errorf("update CodeInterpreter: %w", err)
	}
	return ci, nil
}

// DeleteTemplate removes a CodeInterpreter CRD object from Kubernetes.
func (c *K8sSandboxCreator) DeleteTemplate(ctx context.Context, name, namespace string) error {
	if namespace == "" {
		namespace = "default"
	}
	ci := &runtimev1alpha1.CodeInterpreter{}
	key := ctrlclient.ObjectKey{Name: name, Namespace: namespace}
	if err := c.client.Get(ctx, key, ci); err != nil {
		if k8serrors.IsNotFound(err) {
			return nil // idempotent
		}
		return fmt.Errorf("get CodeInterpreter for delete: %w", err)
	}
	if err := c.client.Delete(ctx, ci); err != nil {
		if k8serrors.IsNotFound(err) {
			return nil // already gone
		}
		return fmt.Errorf("delete CodeInterpreter: %w", err)
	}
	return nil
}
