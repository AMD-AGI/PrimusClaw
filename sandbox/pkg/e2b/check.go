// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package e2b

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/grant"
)

const (
	defaultTimeoutSec  int64 = 300
	defaultPendingWait       = 15 * time.Minute
	envdVersion              = "0.1.0"
	defaultListLimit         = 100
)

const metadataPrefix = "agent-sandbox.io/"

// idempotencyMetadataKey is the caller key that replays one create.
const idempotencyMetadataKey = metadataPrefix + "idempotency-key"

// signingPublicKeyMetadata is the Ed25519 public key of this sandbox, PKIX PEM.
const signingPublicKeyMetadata = metadataPrefix + "signing-public-key"

// nodeNameMetadata is the node the sandbox pod was scheduled onto.
const nodeNameMetadata = metadataPrefix + "node-name"

// callerMetadataKeys may be set by the SDK under agent-sandbox.io/.
var callerMetadataKeys = map[string]struct{}{
	"idempotency-key": {},
	"avoid-nodes":     {},
	"priority":        {},
}

// reservedMetadataKeys are assigned by the platform and rejected from callers.
var reservedMetadataKeys = map[string]struct{}{
	"node-name":          {},
	"signing-public-key": {},
	"same-node":          {},
	"nodes":              {},
}

// checkMetadata accepts agent-sandbox.io/ keys, including the caller keys above.
// The same names without that prefix are rejected. Reserved names are rejected
// with or without the prefix.
func checkMetadata(md map[string]string) error {
	for key := range md {
		name := key
		prefixed := false
		if rest, ok := strings.CutPrefix(key, metadataPrefix); ok {
			prefixed = true
			name = rest
		}
		if _, ok := reservedMetadataKeys[name]; ok {
			return grant.Op(http.StatusForbidden, "metadata_reserved", key)
		}
		if prefixed || strings.HasPrefix(key, "claw.io/") || strings.HasPrefix(key, "hyperloom.") {
			continue
		}
		return grant.Op(http.StatusForbidden, "metadata_not_allowed", key)
	}
	return nil
}

type resolvedTemplate struct {
	ID           string
	Alias        string
	GPUs         int32
	Sealed       bool
	Inputs       []string
	Outputs      []string
	AcceptedEnvs []string
	Pending      time.Duration
}

// resolveTemplate matches an expanded name, or a short name with one expansion.
func resolveTemplate(snap grant.Snapshot, role, requested string) (resolvedTemplate, error) {
	if requested == "" {
		return resolvedTemplate{}, grant.Op(http.StatusBadRequest, "invalid_sandbox", "templateID is required")
	}
	cap, ok := snap.Roles[role]
	if !ok {
		return resolvedTemplate{}, grant.Op(http.StatusForbidden, "role_not_allowed", role)
	}
	if contains(cap.Templates, requested) {
		tpl, spec, gpus := templateForExpansion(snap, requested)
		body, err := parseSpec(spec)
		if err != nil {
			return resolvedTemplate{}, err
		}
		alias := requested
		if tpl.Name != "" {
			alias = tpl.Name
		}
		return resolvedFrom(requested, alias, gpus, body), nil
	}
	var matches []string
	var spec string
	var gpus int32
	for _, tpl := range snap.Templates {
		if tpl.Name != requested {
			continue
		}
		for i, name := range expandNames(snap.AppRunID, tpl) {
			if contains(cap.Templates, name) {
				matches = append(matches, name)
				spec = tpl.Spec
				gpus = templateGPUCount(tpl, i)
			}
		}
	}
	if len(matches) == 1 {
		body, err := parseSpec(spec)
		if err != nil {
			return resolvedTemplate{}, err
		}
		return resolvedFrom(matches[0], requested, gpus, body), nil
	}
	if len(matches) > 1 {
		return resolvedTemplate{}, grant.Op(http.StatusForbidden, "template_not_allowed", requested+" matches more than one gpu size")
	}
	return resolvedTemplate{}, grant.Op(http.StatusForbidden, "template_not_allowed", requested)
}

func resolvedFrom(id, alias string, gpus int32, body specBody) resolvedTemplate {
	pending := defaultPendingWait
	if body.PendingTimeoutSec > 0 {
		pending = time.Duration(body.PendingTimeoutSec) * time.Second
	}
	return resolvedTemplate{
		ID:           id,
		Alias:        alias,
		GPUs:         gpus,
		Sealed:       body.Sealed,
		Inputs:       body.Inputs,
		Outputs:      body.Outputs,
		AcceptedEnvs: body.AcceptedEnvs,
		Pending:      pending,
	}
}

func templateForExpansion(snap grant.Snapshot, expanded string) (runtimev1alpha1.GrantTemplate, string, int32) {
	for _, tpl := range snap.Templates {
		for i, name := range expandNames(snap.AppRunID, tpl) {
			if name == expanded {
				return tpl, tpl.Spec, templateGPUCount(tpl, i)
			}
		}
	}
	return runtimev1alpha1.GrantTemplate{}, "", 0
}

func expandNames(appRunID string, tpl runtimev1alpha1.GrantTemplate) []string {
	return grant.TemplateNames(appRunID, tpl.Name, tpl.PerGPUCount)
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

type specBody struct {
	Sealed            bool     `json:"sealed"`
	AcceptedEnvs      []string `json:"acceptedEnvs"`
	Inputs            []string `json:"inputs"`
	Outputs           []string `json:"outputs"`
	PendingTimeoutSec int64    `json:"pendingTimeoutSec"`
}

func parseSpec(spec string) (specBody, error) {
	if spec == "" {
		return specBody{}, nil
	}
	var body specBody
	if err := json.Unmarshal([]byte(spec), &body); err != nil {
		return specBody{}, grant.Op(http.StatusInternalServerError, "template_spec_invalid", "template spec is not JSON")
	}
	return body, nil
}

// checkEnv rejects every env var when acceptedEnvs is empty, and any key outside the list.
func checkEnv(accepted []string, env map[string]string) error {
	if len(env) == 0 {
		return nil
	}
	if len(accepted) == 0 {
		return grant.Op(http.StatusForbidden, "env_not_allowed", "template accepts no env vars")
	}
	for key := range env {
		if !contains(accepted, key) {
			return grant.Op(http.StatusForbidden, "env_not_allowed", key)
		}
	}
	return nil
}

func contains(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}

// parseMetadataQuery reads a metadata query string.
// The HTTP server has already decoded the parameter once.
func parseMetadataQuery(raw string) (map[string]string, error) {
	if raw == "" {
		return nil, nil
	}
	values, err := url.ParseQuery(raw)
	if err != nil {
		return nil, grant.Op(http.StatusBadRequest, "invalid_metadata_query", "metadata query is not encoded")
	}
	out := make(map[string]string, len(values))
	for key, vals := range values {
		if len(vals) > 0 {
			out[key] = vals[0]
		}
	}
	return out, nil
}

func metadataMatch(md, want map[string]string) bool {
	for key, val := range want {
		if md[key] != val {
			return false
		}
	}
	return true
}
