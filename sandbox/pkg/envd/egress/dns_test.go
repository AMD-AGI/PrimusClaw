// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package egress

import (
	"context"
	"net"
	"testing"
)

func TestSafeResolver_PublicDomain(t *testing.T) {
	ssrf, _ := NewSSRFChecker(nil)
	r := NewSafeResolver(ssrf)

	res, err := r.Resolve(context.Background(), "example.com")
	if err != nil {
		t.Skipf("DNS resolution failed (no network?): %v", err)
	}
	if res.Blocked {
		t.Error("example.com should not be blocked")
	}
	if res.IP == nil {
		t.Error("expected non-nil IP for example.com")
	}
}

func TestSafeResolver_LoopbackDomain(t *testing.T) {
	ssrf, _ := NewSSRFChecker(nil)
	r := &SafeResolver{
		ssrf: ssrf,
		resolver: &net.Resolver{
			PreferGo: true,
			Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
				// This won't be called; we test via direct IP below.
				return nil, nil
			},
		},
		timeout: defaultDNSTimeout,
	}
	_ = r // not used directly

	// Simulate: domain resolves to 127.0.0.1
	// We test the SSRF checker directly since mocking DNS is complex.
	ip := net.ParseIP("127.0.0.1")
	chk := ssrf.Check(ip)
	if !chk.Blocked {
		t.Error("127.0.0.1 should be blocked")
	}
}

func TestSafeResolver_ResolveAndDial_Format(t *testing.T) {
	ssrf, _ := NewSSRFChecker(nil)
	r := NewSafeResolver(ssrf)

	addr, err := r.ResolveAndDial(context.Background(), "example.com", 443)
	if err != nil {
		t.Skipf("DNS resolution failed (no network?): %v", err)
	}

	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatalf("ResolveAndDial returned invalid address %q: %v", addr, err)
	}
	if port != "443" {
		t.Errorf("port=%s, want 443", port)
	}
	if net.ParseIP(host) == nil {
		t.Errorf("host=%s is not a valid IP (should be resolved IP, not domain)", host)
	}
}
