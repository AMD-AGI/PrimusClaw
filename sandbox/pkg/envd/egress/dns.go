// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package egress

import (
	"context"
	"fmt"
	"net"
	"time"
)

const defaultDNSTimeout = 5 * time.Second

// SafeResolver performs DNS resolution and validates the result against
// the SSRF checker. The verified IP is returned for direct use in TCP Dial,
// preventing DNS rebinding (TOCTOU) attacks.
type SafeResolver struct {
	ssrf     *SSRFChecker
	resolver *net.Resolver
	timeout  time.Duration
}

// NewSafeResolver creates a resolver backed by the given SSRF checker.
func NewSafeResolver(ssrf *SSRFChecker) *SafeResolver {
	return &SafeResolver{
		ssrf:     ssrf,
		resolver: net.DefaultResolver,
		timeout:  defaultDNSTimeout,
	}
}

// ResolveResult holds the outcome of a safe DNS lookup.
type ResolveResult struct {
	IP      net.IP      // verified safe IP (nil when blocked)
	Blocked bool        // true if all resolved IPs are blocked
	Check   CheckResult // detail of the SSRF check that blocked (valid only when Blocked)
	Domain  string      // original domain resolved
}

// Resolve looks up the domain, validates each resolved IP against the SSRF
// checker, and returns the first safe IP. If all IPs are blocked the result
// is marked Blocked.
func (r *SafeResolver) Resolve(ctx context.Context, domain string) (ResolveResult, error) {
	ctx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()

	ips, err := r.resolver.LookupIPAddr(ctx, domain)
	if err != nil {
		return ResolveResult{Domain: domain}, fmt.Errorf("dns lookup %s: %w", domain, err)
	}
	if len(ips) == 0 {
		return ResolveResult{Domain: domain}, fmt.Errorf("dns lookup %s: no addresses", domain)
	}

	var lastCheck CheckResult
	for _, addr := range ips {
		chk := r.ssrf.Check(addr.IP)
		if !chk.Blocked {
			return ResolveResult{IP: addr.IP, Domain: domain}, nil
		}
		lastCheck = chk
	}

	return ResolveResult{
		Blocked: true,
		Check:   lastCheck,
		Domain:  domain,
	}, nil
}

// ResolveAndDial resolves the domain, validates the IP, and returns the
// verified address string "ip:port" ready for net.Dial. This guarantees the
// dialed IP is the same one that passed SSRF validation (no rebinding window).
func (r *SafeResolver) ResolveAndDial(ctx context.Context, domain string, port int) (string, error) {
	res, err := r.Resolve(ctx, domain)
	if err != nil {
		return "", err
	}
	if res.Blocked {
		return "", fmt.Errorf("dns resolved %s to blocked IP (%s: %s)",
			domain, res.Check.Reason, res.Check.CIDR)
	}
	return net.JoinHostPort(res.IP.String(), fmt.Sprintf("%d", port)), nil
}
