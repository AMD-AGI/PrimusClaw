// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"encoding/json"
	"strconv"
	"strings"

	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/policy"
)

const (
	runtimePolicyAnnotationKey        = "runtime.agent-sandbox.io/runtime-policy"
	policyModeAnnotationKey           = "runtime.agent-sandbox.io/policy-mode"
	allowedEgressHostsAnnotationKey   = "runtime.agent-sandbox.io/allowed-egress-hosts"
	allowedInternalHostsAnnotationKey = "runtime.agent-sandbox.io/allowed-internal-hosts"
	policyVersionAnnotationKey        = "runtime.agent-sandbox.io/policy-version"
)

// sandboxPolicy is the egress policy stored on a Sandbox CR.
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

func writePolicyAnnotations(dst map[string]string, p sandboxPolicy) {
	if dst == nil {
		return
	}
	if p.RuntimePolicy == "" {
		p.RuntimePolicy = "agent-default"
	}
	if p.PolicyMode == "" {
		p.PolicyMode = "enforce"
	}
	if p.PolicyVersion <= 0 {
		p.PolicyVersion = 1
	}
	dst[runtimePolicyAnnotationKey] = p.RuntimePolicy
	dst[policyModeAnnotationKey] = p.PolicyMode
	dst[policyVersionAnnotationKey] = strconv.FormatInt(p.PolicyVersion, 10)
	dst[allowedEgressHostsAnnotationKey] = encodeStringList(p.AllowedEgressHosts)
	dst[allowedInternalHostsAnnotationKey] = encodeStringList(p.AllowedInternalHosts)
}

func readPolicyAnnotations(sb *sandboxv1alpha1.Sandbox) sandboxPolicy {
	p := defaultSandboxPolicy()
	if sb == nil || sb.Annotations == nil {
		return p
	}
	if v := strings.TrimSpace(sb.Annotations[runtimePolicyAnnotationKey]); v != "" {
		p.RuntimePolicy = v
	}
	if v := strings.TrimSpace(sb.Annotations[policyModeAnnotationKey]); v != "" {
		p.PolicyMode = v
	}
	if v := strings.TrimSpace(sb.Annotations[policyVersionAnnotationKey]); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			p.PolicyVersion = n
		}
	}
	if hosts, ok := decodeStringList(sb.Annotations[allowedEgressHostsAnnotationKey]); ok {
		p.AllowedEgressHosts = hosts
	}
	if hosts, ok := decodeStringList(sb.Annotations[allowedInternalHostsAnnotationKey]); ok {
		p.AllowedInternalHosts = hosts
	}
	return p
}

func encodeStringList(values []string) string {
	if len(values) == 0 {
		return "[]"
	}
	data, err := json.Marshal(values)
	if err != nil {
		return "[]"
	}
	return string(data)
}

func decodeStringList(raw string) ([]string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, false
	}
	var values []string
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return nil, false
	}
	return values, true
}
