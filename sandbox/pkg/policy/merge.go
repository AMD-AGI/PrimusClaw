// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package policy

// Presets defines the built-in ClusterSandboxPolicy configurations.
var Presets = map[string]*PolicyConfig{
	"agent-default": {
		RuntimePolicy: "agent-default",
		Mode:          "enforce",
	},
	"agent-restricted": {
		RuntimePolicy:      "agent-restricted",
		Mode:               "enforce",
		AllowedEgressHosts: nil, // must be provided by template or create-time override
	},
}

// MergePolicy builds the final PolicyConfig by layering:
//  1. ClusterSandboxPolicy preset (base)
//  2. Template-level whitelist (from CodeInterpreter spec)
//  3. Create-time override (from sandbox creation request)
//
// Later layers append to (not replace) earlier ones.
func MergePolicy(
	presetName string,
	templateEgressHosts []string,
	templateInternalHosts []string,
	overrideEgressHosts []string,
	overrideInternalHosts []string,
) *PolicyConfig {
	preset, ok := Presets[presetName]
	if !ok {
		preset = Presets["agent-default"]
	}

	cfg := &PolicyConfig{
		RuntimePolicy: preset.RuntimePolicy,
		Mode:          preset.Mode,
		Version:       1,
	}

	// Merge egress hosts: preset + template + override
	seen := make(map[string]bool)
	for _, h := range preset.AllowedEgressHosts {
		if !seen[h] {
			cfg.AllowedEgressHosts = append(cfg.AllowedEgressHosts, h)
			seen[h] = true
		}
	}
	for _, h := range templateEgressHosts {
		if !seen[h] {
			cfg.AllowedEgressHosts = append(cfg.AllowedEgressHosts, h)
			seen[h] = true
		}
	}
	for _, h := range overrideEgressHosts {
		if !seen[h] {
			cfg.AllowedEgressHosts = append(cfg.AllowedEgressHosts, h)
			seen[h] = true
		}
	}

	// Merge internal hosts: preset + template + override
	seenInt := make(map[string]bool)
	for _, h := range preset.AllowedInternalHosts {
		if !seenInt[h] {
			cfg.AllowedInternalHosts = append(cfg.AllowedInternalHosts, h)
			seenInt[h] = true
		}
	}
	for _, h := range templateInternalHosts {
		if !seenInt[h] {
			cfg.AllowedInternalHosts = append(cfg.AllowedInternalHosts, h)
			seenInt[h] = true
		}
	}
	for _, h := range overrideInternalHosts {
		if !seenInt[h] {
			cfg.AllowedInternalHosts = append(cfg.AllowedInternalHosts, h)
			seenInt[h] = true
		}
	}

	return cfg
}
