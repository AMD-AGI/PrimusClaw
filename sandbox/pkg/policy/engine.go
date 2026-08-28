// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package policy implements the egress policy evaluation engine.
// It evaluates outbound traffic requests against ClusterSandboxPolicy presets
// combined with per-sandbox whitelist overrides.
package policy

import (
	"context"
	"fmt"
	"net"
	"strings"
	"sync"
)

// Decision represents the result of a policy evaluation.
type Decision struct {
	Action string // "allow", "deny", "audit"
	Reason string // human-readable explanation
}

// EgressRequest describes an outbound connection for policy evaluation.
type EgressRequest struct {
	OriginalIP   string
	OriginalPort int
	Domain       string
	ResolvedIP   string
	IsTLS        bool
}

// PolicyConfig holds the effective policy for a sandbox session.
type PolicyConfig struct {
	RuntimePolicy        string   // "agent-default" or "agent-restricted"
	Mode                 string   // "enforce" or "audit"
	AllowedEgressHosts   []string // external domain whitelist (agent-restricted only)
	AllowedInternalHosts []string // internal IP/CIDR whitelist
	Version              int64
}

// Engine evaluates egress requests against a PolicyConfig.
// Thread-safe: the config can be atomically swapped via UpdateConfig.
type Engine struct {
	mu     sync.RWMutex
	config *PolicyConfig

	// pre-computed lookup structures
	egressSet    map[string]bool // lowercase domain → allowed
	internalNets []*net.IPNet    // parsed CIDRs for internal whitelist
}

// New creates a policy engine with the given initial config.
func New(cfg *PolicyConfig) *Engine {
	e := &Engine{}
	e.UpdateConfig(cfg)
	return e
}

// UpdateConfig atomically replaces the policy configuration.
func (e *Engine) UpdateConfig(cfg *PolicyConfig) {
	if cfg == nil {
		cfg = &PolicyConfig{RuntimePolicy: "agent-default", Mode: "enforce"}
	}

	egressSet := make(map[string]bool, len(cfg.AllowedEgressHosts))
	for _, h := range cfg.AllowedEgressHosts {
		egressSet[strings.ToLower(strings.TrimSpace(h))] = true
	}

	var internalNets []*net.IPNet
	for _, cidr := range cfg.AllowedInternalHosts {
		cidr = strings.TrimSpace(cidr)
		if !strings.Contains(cidr, "/") {
			cidr += "/32"
		}
		if _, ipNet, err := net.ParseCIDR(cidr); err == nil {
			internalNets = append(internalNets, ipNet)
		}
	}

	e.mu.Lock()
	e.config = cfg
	e.egressSet = egressSet
	e.internalNets = internalNets
	e.mu.Unlock()
}

// Evaluate checks whether the given egress request should be allowed.
func (e *Engine) Evaluate(_ context.Context, req EgressRequest) Decision {
	e.mu.RLock()
	cfg := e.config
	egressSet := e.egressSet
	internalNets := e.internalNets
	e.mu.RUnlock()

	if cfg == nil {
		return Decision{Action: "allow", Reason: "no policy configured"}
	}

	switch cfg.RuntimePolicy {
	case "agent-restricted":
		return e.evaluateRestricted(req, cfg, egressSet, internalNets)
	default: // "agent-default"
		return e.evaluateDefault(req, cfg, internalNets)
	}
}

// evaluateDefault implements the "agent-default" policy:
// external traffic is allowed; internal traffic is blocked unless whitelisted.
func (e *Engine) evaluateDefault(req EgressRequest, cfg *PolicyConfig, internalNets []*net.IPNet) Decision {
	ip := req.ResolvedIP
	if ip == "" {
		ip = req.OriginalIP
	}

	if isPrivateIP(ip) {
		if isAllowedInternal(ip, internalNets) {
			return Decision{Action: "allow", Reason: "internal IP in allowedInternalHosts"}
		}
		return e.applyMode(cfg.Mode, Decision{
			Action: "deny",
			Reason: fmt.Sprintf("internal IP %s blocked by agent-default policy", ip),
		})
	}

	return Decision{Action: "allow", Reason: "external traffic allowed by agent-default"}
}

// evaluateRestricted implements the "agent-restricted" policy:
// external traffic is only allowed for whitelisted domains; internal is fully blocked unless whitelisted.
func (e *Engine) evaluateRestricted(req EgressRequest, cfg *PolicyConfig, egressSet map[string]bool, internalNets []*net.IPNet) Decision {
	ip := req.ResolvedIP
	if ip == "" {
		ip = req.OriginalIP
	}

	// Internal traffic check
	if isPrivateIP(ip) {
		if isAllowedInternal(ip, internalNets) {
			return Decision{Action: "allow", Reason: "internal IP in allowedInternalHosts"}
		}
		return e.applyMode(cfg.Mode, Decision{
			Action: "deny",
			Reason: fmt.Sprintf("internal IP %s blocked by agent-restricted policy", ip),
		})
	}

	// External traffic: must be in domain whitelist
	domain := strings.ToLower(req.Domain)
	if domain != "" && egressSet[domain] {
		return Decision{Action: "allow", Reason: fmt.Sprintf("domain %s in allowedEgressHosts", domain)}
	}

	// Check wildcard: *.example.com matches sub.example.com
	if domain != "" {
		parts := strings.SplitN(domain, ".", 2)
		if len(parts) == 2 {
			wildcard := "*." + parts[1]
			if egressSet[wildcard] {
				return Decision{Action: "allow", Reason: fmt.Sprintf("domain %s matches wildcard %s", domain, wildcard)}
			}
		}
	}

	return e.applyMode(cfg.Mode, Decision{
		Action: "deny",
		Reason: fmt.Sprintf("domain %q not in allowedEgressHosts (agent-restricted)", domain),
	})
}

// applyMode converts a "deny" into "audit" when mode is "audit".
func (e *Engine) applyMode(mode string, d Decision) Decision {
	if mode == "audit" && d.Action == "deny" {
		d.Action = "audit"
		d.Reason = "[audit] " + d.Reason
	}
	return d
}

// GetConfig returns the current policy config (for API queries).
func (e *Engine) GetConfig() *PolicyConfig {
	e.mu.RLock()
	defer e.mu.RUnlock()
	if e.config == nil {
		return nil
	}
	cp := *e.config
	return &cp
}

// GetVersion returns the current policy version.
func (e *Engine) GetVersion() int64 {
	e.mu.RLock()
	defer e.mu.RUnlock()
	if e.config == nil {
		return 0
	}
	return e.config.Version
}

// isPrivateIP checks if the IP is in RFC1918/RFC4193/loopback/link-local ranges.
func isPrivateIP(ipStr string) bool {
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}
	return ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast()
}

// isAllowedInternal checks if the IP is in any of the allowed internal CIDRs.
func isAllowedInternal(ipStr string, nets []*net.IPNet) bool {
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}
	for _, n := range nets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// ValidateInternalCIDR checks that a CIDR has mask >= /16 (prevents overly broad whitelisting).
func ValidateInternalCIDR(cidr string) error {
	cidr = strings.TrimSpace(cidr)
	if !strings.Contains(cidr, "/") {
		if net.ParseIP(cidr) == nil {
			return fmt.Errorf("invalid IP address %q", cidr)
		}
		return nil // single IP, valid
	}
	_, ipNet, err := net.ParseCIDR(cidr)
	if err != nil {
		return fmt.Errorf("invalid CIDR %q: %w", cidr, err)
	}
	ones, _ := ipNet.Mask.Size()
	if ones < 16 {
		return fmt.Errorf("CIDR %q mask /%d is too broad (minimum /16)", cidr, ones)
	}
	return nil
}
