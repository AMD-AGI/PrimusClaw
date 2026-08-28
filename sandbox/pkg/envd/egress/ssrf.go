// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package egress

import (
	"fmt"
	"net"
	"strings"
	"sync"
)

// SSRFChecker validates IP addresses against blocked CIDR ranges to prevent
// Server-Side Request Forgery attacks from sandbox processes.
type SSRFChecker struct {
	mu       sync.RWMutex
	blocked  []*net.IPNet
	reasons  []string // parallel to blocked, one reason per CIDR
	allowSet []*net.IPNet
}

// Default CIDR blocks: always-block ranges form the security baseline.
var (
	alwaysBlockedCIDRs = []string{
		"127.0.0.0/8",    // IPv4 loopback
		"::1/128",        // IPv6 loopback
		"fe80::/10",      // IPv6 link-local
		"fc00::/7",       // IPv6 unique local
		"169.254.0.0/16", // IPv4 link-local — cloud metadata (AWS/GCP/Azure/OCI)
	}
	defaultBlockedCIDRs = []string{
		"10.0.0.0/8",     // RFC 1918
		"172.16.0.0/12",  // RFC 1918
		"192.168.0.0/16", // RFC 1918
		"100.64.0.0/10",  // RFC 6598 CGN (carrier-grade NAT)
	}
)

// NewSSRFChecker creates a checker with baseline + default private CIDR blocks.
// extraCIDRs adds deployment-specific ranges (e.g. 169.254.0.0/16 for cloud metadata).
func NewSSRFChecker(extraCIDRs []string) (*SSRFChecker, error) {
	c := &SSRFChecker{}

	for _, cidr := range alwaysBlockedCIDRs {
		if err := c.addBlocked(cidr, "always-blocked"); err != nil {
			return nil, fmt.Errorf("parsing always-blocked CIDR %s: %w", cidr, err)
		}
	}
	for _, cidr := range defaultBlockedCIDRs {
		if err := c.addBlocked(cidr, "private-network"); err != nil {
			return nil, fmt.Errorf("parsing default-blocked CIDR %s: %w", cidr, err)
		}
	}
	for _, cidr := range extraCIDRs {
		if err := c.addBlocked(cidr, "extra-blocked"); err != nil {
			return nil, fmt.Errorf("parsing extra CIDR %s: %w", cidr, err)
		}
	}

	return c, nil
}

func (c *SSRFChecker) addBlocked(cidr, reason string) error {
	_, ipNet, err := net.ParseCIDR(cidr)
	if err != nil {
		return err
	}
	c.blocked = append(c.blocked, ipNet)
	c.reasons = append(c.reasons, reason)
	return nil
}

// SetAllowedInternal replaces the internal-hosts allow list.
// Allowed IPs bypass the default-blocked (private-network) check but
// cannot bypass always-blocked ranges (loopback, link-local).
func (c *SSRFChecker) SetAllowedInternal(cidrs []string) error {
	var nets []*net.IPNet
	for _, cidr := range cidrs {
		ipNet, err := normalizeAllowedInternalCIDR(cidr)
		if err != nil {
			return fmt.Errorf("parsing allowed CIDR %s: %w", cidr, err)
		}
		if ipNet == nil {
			continue
		}
		nets = append(nets, ipNet)
	}
	c.mu.Lock()
	c.allowSet = nets
	c.mu.Unlock()
	return nil
}

// CheckResult holds the outcome of an SSRF validation.
type CheckResult struct {
	Blocked bool
	Reason  string // e.g. "always-blocked", "private-network", "extra-blocked"
	CIDR    string // the matched CIDR range
}

// Check returns whether the given IP should be blocked.
func (c *SSRFChecker) Check(ip net.IP) CheckResult {
	if ip == nil {
		return CheckResult{Blocked: true, Reason: "nil-ip"}
	}

	c.mu.RLock()
	allowSet := c.allowSet
	c.mu.RUnlock()

	for i, ipNet := range c.blocked {
		if !ipNet.Contains(ip) {
			continue
		}
		reason := c.reasons[i]

		// Always-blocked ranges (loopback, link-local) cannot be overridden.
		if reason == "always-blocked" {
			return CheckResult{Blocked: true, Reason: reason, CIDR: ipNet.String()}
		}

		// Check if IP is explicitly allowed (allowedInternalHosts).
		if isAllowed(ip, allowSet) {
			continue
		}

		return CheckResult{Blocked: true, Reason: reason, CIDR: ipNet.String()}
	}

	return CheckResult{Blocked: false}
}

func isAllowed(ip net.IP, nets []*net.IPNet) bool {
	for _, n := range nets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

func normalizeAllowedInternalCIDR(raw string) (*net.IPNet, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	if strings.Contains(raw, "/") {
		_, ipNet, err := net.ParseCIDR(raw)
		return ipNet, err
	}
	ip := net.ParseIP(raw)
	if ip == nil {
		return nil, fmt.Errorf("invalid IP address %q", raw)
	}
	maskBits := 128
	if ip.To4() != nil {
		maskBits = 32
	}
	_, ipNet, err := net.ParseCIDR(fmt.Sprintf("%s/%d", ip.String(), maskBits))
	return ipNet, err
}
