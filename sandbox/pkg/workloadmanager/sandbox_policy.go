// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"fmt"

	k8serrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/policy"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

// sandboxPolicy is the egress policy for a Sandbox.
// Authoritative storage is the SandboxPolicy CR (same name/namespace as the Sandbox).
// Sandbox annotations are not policy authority.
type sandboxPolicy struct {
	RuntimePolicy        string
	PolicyMode           string
	AllowedEgressHosts   []string
	AllowedInternalHosts []string
	PolicyVersion        int64
}

func defaultSandboxPolicy() sandboxPolicy {
	return sandboxPolicy{
		RuntimePolicy: "agent-default",
		PolicyMode:    "enforce",
		PolicyVersion: 1,
	}
}

func sandboxPolicyFromTemplate(ci *runtimev1alpha1.CodeInterpreter) sandboxPolicy {
	p := defaultSandboxPolicy()
	if ci == nil {
		return p
	}
	preset := ci.Spec.RuntimePolicy
	if preset == "" {
		preset = "agent-default"
	}
	merged := policy.MergePolicy(preset, ci.Spec.AllowedEgressHosts, ci.Spec.AllowedInternalHosts, nil, nil)
	p.RuntimePolicy = merged.RuntimePolicy
	p.PolicyMode = merged.Mode
	p.AllowedEgressHosts = merged.AllowedEgressHosts
	p.AllowedInternalHosts = merged.AllowedInternalHosts
	p.PolicyVersion = 1
	return p
}

func normalizeSandboxPolicy(p sandboxPolicy) sandboxPolicy {
	if p.RuntimePolicy == "" {
		p.RuntimePolicy = "agent-default"
	}
	if p.PolicyMode == "" {
		p.PolicyMode = "enforce"
	}
	if p.PolicyVersion <= 0 {
		p.PolicyVersion = 1
	}
	return p
}

func policyToSpec(p sandboxPolicy) runtimev1alpha1.SandboxPolicySpec {
	p = normalizeSandboxPolicy(p)
	return runtimev1alpha1.SandboxPolicySpec{
		RuntimePolicy:        p.RuntimePolicy,
		PolicyMode:           p.PolicyMode,
		AllowedEgressHosts:   p.AllowedEgressHosts,
		AllowedInternalHosts: p.AllowedInternalHosts,
		PolicyVersion:        p.PolicyVersion,
	}
}

func policyFromSpec(spec runtimev1alpha1.SandboxPolicySpec) sandboxPolicy {
	return normalizeSandboxPolicy(sandboxPolicy{
		RuntimePolicy:        spec.RuntimePolicy,
		PolicyMode:           spec.PolicyMode,
		AllowedEgressHosts:   spec.AllowedEgressHosts,
		AllowedInternalHosts: spec.AllowedInternalHosts,
		PolicyVersion:        spec.PolicyVersion,
	})
}

// policyFromInfo maps store.SandboxInfo policy fields onto sandboxPolicy.
func policyFromInfo(info *store.SandboxInfo) sandboxPolicy {
	pol := defaultSandboxPolicy()
	if info == nil {
		return pol
	}
	if info.RuntimePolicy != "" {
		pol.RuntimePolicy = info.RuntimePolicy
	}
	if info.PolicyMode != "" {
		pol.PolicyMode = info.PolicyMode
	}
	pol.AllowedEgressHosts = info.AllowedEgressHosts
	pol.AllowedInternalHosts = info.AllowedInternalHosts
	if info.PolicyVersion > 0 {
		pol.PolicyVersion = info.PolicyVersion
	}
	return pol
}

func applyPolicyToInfo(info *store.SandboxInfo, pol sandboxPolicy) {
	if info == nil {
		return
	}
	pol = normalizeSandboxPolicy(pol)
	info.RuntimePolicy = pol.RuntimePolicy
	info.PolicyMode = pol.PolicyMode
	info.AllowedEgressHosts = pol.AllowedEgressHosts
	info.AllowedInternalHosts = pol.AllowedInternalHosts
	info.PolicyVersion = pol.PolicyVersion
}

// GetSandboxPolicy loads the authoritative SandboxPolicy CR.
// Missing CR returns defaultSandboxPolicy and false.
func (c *K8sSandboxCreator) GetSandboxPolicy(ctx context.Context, namespace, name string) (sandboxPolicy, bool, error) {
	pol := &runtimev1alpha1.SandboxPolicy{}
	key := types.NamespacedName{Namespace: namespace, Name: name}
	var err error
	if c.cachedReader != nil {
		err = c.cachedReader.Get(ctx, key, pol)
		if k8serrors.IsNotFound(err) {
			err = c.client.Get(ctx, key, pol)
		}
	} else {
		err = c.client.Get(ctx, key, pol)
	}
	if err != nil {
		if k8serrors.IsNotFound(err) {
			return defaultSandboxPolicy(), false, nil
		}
		return sandboxPolicy{}, false, err
	}
	return policyFromSpec(pol.Spec), true, nil
}

// UpsertSandboxPolicy creates or updates the SandboxPolicy CR for sb.
// The CR is owned by the Sandbox so it is garbage-collected with it.
func (c *K8sSandboxCreator) UpsertSandboxPolicy(ctx context.Context, sb *sandboxv1alpha1.Sandbox, p sandboxPolicy) error {
	if sb == nil {
		return fmt.Errorf("sandbox is nil")
	}
	p = normalizeSandboxPolicy(p)
	obj := &runtimev1alpha1.SandboxPolicy{
		ObjectMeta: metav1.ObjectMeta{
			Name:      sb.Name,
			Namespace: sb.Namespace,
		},
	}
	_, err := controllerutil.CreateOrUpdate(ctx, c.client, obj, func() error {
		obj.Spec = policyToSpec(p)
		return controllerutil.SetControllerReference(sb, obj, c.client.Scheme())
	})
	return err
}

// EnsureSandboxPolicy creates a default SandboxPolicy when none exists.
func (c *K8sSandboxCreator) EnsureSandboxPolicy(ctx context.Context, sb *sandboxv1alpha1.Sandbox, p sandboxPolicy) error {
	_, found, err := c.GetSandboxPolicy(ctx, sb.Namespace, sb.Name)
	if err != nil {
		return err
	}
	if found {
		return nil
	}
	return c.UpsertSandboxPolicy(ctx, sb, p)
}

// PatchSandboxPolicy applies mutate to the SandboxPolicy CR and writes it back.
// Each attempt re-reads the live CR so concurrent PATCHes merge instead of
// clobbering, and PolicyVersion always advances from the latest value.
func (c *K8sSandboxCreator) PatchSandboxPolicy(
	ctx context.Context, namespace, name string, mutate func(*sandboxPolicy) error,
) (sandboxPolicy, error) {
	var empty sandboxPolicy
	const maxAttempts = 5
	for attempt := 0; attempt < maxAttempts; attempt++ {
		obj := &runtimev1alpha1.SandboxPolicy{}
		if err := c.client.Get(ctx, types.NamespacedName{Namespace: namespace, Name: name}, obj); err != nil {
			return empty, err
		}
		pol := policyFromSpec(obj.Spec)
		if err := mutate(&pol); err != nil {
			return empty, err
		}
		pol.PolicyVersion++
		base := obj.DeepCopy()
		obj.Spec = policyToSpec(pol)
		patch := ctrlclient.MergeFromWithOptions(base, ctrlclient.MergeFromWithOptimisticLock{})
		if err := c.client.Patch(ctx, obj, patch); err != nil {
			if k8serrors.IsConflict(err) && attempt+1 < maxAttempts {
				continue
			}
			return empty, err
		}
		return pol, nil
	}
	return empty, fmt.Errorf("patch sandbox policy %s/%s: exhausted retries", namespace, name)
}
