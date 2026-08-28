// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package egress

import (
	"net"
	"testing"
)

func TestSSRFChecker_PublicIPAllowed(t *testing.T) {
	c, err := NewSSRFChecker(nil)
	if err != nil {
		t.Fatal(err)
	}

	publicIPs := []string{
		"8.8.8.8",
		"1.1.1.1",
		"93.184.216.34",        // example.com
		"2606:4700::6810:84e5", // Cloudflare IPv6
	}
	for _, ip := range publicIPs {
		res := c.Check(net.ParseIP(ip))
		if res.Blocked {
			t.Errorf("public IP %s should be allowed, got blocked (reason=%s)", ip, res.Reason)
		}
	}
}

func TestSSRFChecker_LoopbackBlocked(t *testing.T) {
	c, err := NewSSRFChecker(nil)
	if err != nil {
		t.Fatal(err)
	}

	loopbacks := []string{"127.0.0.1", "127.0.0.2", "127.255.255.255", "::1"}
	for _, ip := range loopbacks {
		res := c.Check(net.ParseIP(ip))
		if !res.Blocked {
			t.Errorf("loopback %s should be blocked", ip)
		}
		if res.Reason != "always-blocked" {
			t.Errorf("loopback %s reason=%s, want always-blocked", ip, res.Reason)
		}
	}
}

func TestSSRFChecker_PrivateNetworkBlocked(t *testing.T) {
	c, err := NewSSRFChecker(nil)
	if err != nil {
		t.Fatal(err)
	}

	privateIPs := []string{
		"10.0.0.1",
		"10.96.0.1", // K8s API Server
		"172.16.0.1",
		"172.31.255.255",
		"192.168.1.1",
	}
	for _, ip := range privateIPs {
		res := c.Check(net.ParseIP(ip))
		if !res.Blocked {
			t.Errorf("private IP %s should be blocked", ip)
		}
		if res.Reason != "private-network" {
			t.Errorf("private IP %s reason=%s, want private-network", ip, res.Reason)
		}
	}
}

func TestSSRFChecker_IPv6Blocked(t *testing.T) {
	c, err := NewSSRFChecker(nil)
	if err != nil {
		t.Fatal(err)
	}

	blocked := []struct {
		ip     string
		reason string
	}{
		{"fe80::1", "always-blocked"}, // link-local
		{"fd00::1", "always-blocked"}, // unique local (fc00::/7)
		{"fc00::1", "always-blocked"}, // unique local
	}
	for _, tc := range blocked {
		res := c.Check(net.ParseIP(tc.ip))
		if !res.Blocked {
			t.Errorf("IPv6 %s should be blocked", tc.ip)
		}
		if res.Reason != tc.reason {
			t.Errorf("IPv6 %s reason=%s, want %s", tc.ip, res.Reason, tc.reason)
		}
	}
}

func TestSSRFChecker_ExtraCIDRs(t *testing.T) {
	// Use a range that is otherwise allowed (public) so the extra-CIDR path is
	// what blocks it. The cloud-metadata range 169.254.0.0/16 now lives in the
	// always-blocked baseline, so it can no longer exercise the "extra" reason.
	c, err := NewSSRFChecker([]string{"8.8.8.0/24"})
	if err != nil {
		t.Fatal(err)
	}

	res := c.Check(net.ParseIP("8.8.8.8"))
	if !res.Blocked {
		t.Error("IP within extra CIDR 8.8.8.0/24 should be blocked")
	}
	if res.Reason != "extra-blocked" {
		t.Errorf("reason=%s, want extra-blocked", res.Reason)
	}
}

func TestSSRFChecker_InvalidExtraCIDR(t *testing.T) {
	_, err := NewSSRFChecker([]string{"not-a-cidr"})
	if err == nil {
		t.Error("expected error for invalid CIDR")
	}
}

func TestSSRFChecker_NilIP(t *testing.T) {
	c, err := NewSSRFChecker(nil)
	if err != nil {
		t.Fatal(err)
	}
	res := c.Check(nil)
	if !res.Blocked {
		t.Error("nil IP should be blocked")
	}
}

func TestSSRFChecker_AllowedInternalHosts(t *testing.T) {
	c, err := NewSSRFChecker(nil)
	if err != nil {
		t.Fatal(err)
	}

	// Without allow-list: 10.0.1.100 blocked
	res := c.Check(net.ParseIP("10.0.1.100"))
	if !res.Blocked {
		t.Fatal("10.0.1.100 should be blocked before allow-list is set")
	}

	// Set allow-list
	if err := c.SetAllowedInternal([]string{"10.0.1.100/32"}); err != nil {
		t.Fatal(err)
	}

	// Now 10.0.1.100 allowed
	res = c.Check(net.ParseIP("10.0.1.100"))
	if res.Blocked {
		t.Error("10.0.1.100 should be allowed after SetAllowedInternal")
	}

	// But 10.0.1.101 still blocked
	res = c.Check(net.ParseIP("10.0.1.101"))
	if !res.Blocked {
		t.Error("10.0.1.101 should still be blocked")
	}

	// Loopback can never be overridden
	res = c.Check(net.ParseIP("127.0.0.1"))
	if !res.Blocked {
		t.Error("127.0.0.1 should be blocked even with allow-list")
	}
}

func TestSSRFChecker_AllowedInternalHosts_SingleIP(t *testing.T) {
	c, err := NewSSRFChecker(nil)
	if err != nil {
		t.Fatal(err)
	}

	if err := c.SetAllowedInternal([]string{"10.0.1.100"}); err != nil {
		t.Fatalf("SetAllowedInternal(single IP) returned error: %v", err)
	}

	res := c.Check(net.ParseIP("10.0.1.100"))
	if res.Blocked {
		t.Fatalf("10.0.1.100 should be allowed after single-IP allow-list, got: %+v", res)
	}

	res = c.Check(net.ParseIP("10.0.1.101"))
	if !res.Blocked {
		t.Fatal("10.0.1.101 should still be blocked")
	}
}

func TestSSRFChecker_LoopbackCannotBeAllowed(t *testing.T) {
	c, err := NewSSRFChecker(nil)
	if err != nil {
		t.Fatal(err)
	}

	_ = c.SetAllowedInternal([]string{"127.0.0.0/8"})
	res := c.Check(net.ParseIP("127.0.0.1"))
	if !res.Blocked {
		t.Error("loopback must always be blocked, even with allow-list covering 127.0.0.0/8")
	}
}
