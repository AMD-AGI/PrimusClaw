// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package policy

import (
	"context"
	"testing"
)

func TestEvaluateDefault_ExternalAllowed(t *testing.T) {
	e := New(&PolicyConfig{RuntimePolicy: "agent-default", Mode: "enforce"})
	d := e.Evaluate(context.Background(), EgressRequest{
		OriginalIP: "93.184.216.34", OriginalPort: 443, Domain: "example.com", ResolvedIP: "93.184.216.34",
	})
	if d.Action != "allow" {
		t.Fatalf("expected allow, got %s: %s", d.Action, d.Reason)
	}
}

func TestEvaluateDefault_InternalBlocked(t *testing.T) {
	e := New(&PolicyConfig{RuntimePolicy: "agent-default", Mode: "enforce"})
	d := e.Evaluate(context.Background(), EgressRequest{
		OriginalIP: "10.0.0.1", OriginalPort: 6443, ResolvedIP: "10.0.0.1",
	})
	if d.Action != "deny" {
		t.Fatalf("expected deny, got %s: %s", d.Action, d.Reason)
	}
}

func TestEvaluateDefault_InternalWhitelisted(t *testing.T) {
	e := New(&PolicyConfig{
		RuntimePolicy:        "agent-default",
		Mode:                 "enforce",
		AllowedInternalHosts: []string{"10.0.1.100/32"},
	})
	d := e.Evaluate(context.Background(), EgressRequest{
		OriginalIP: "10.0.1.100", OriginalPort: 8080, ResolvedIP: "10.0.1.100",
	})
	if d.Action != "allow" {
		t.Fatalf("expected allow for whitelisted internal, got %s: %s", d.Action, d.Reason)
	}
}

func TestEvaluateRestricted_DomainAllowed(t *testing.T) {
	e := New(&PolicyConfig{
		RuntimePolicy:      "agent-restricted",
		Mode:               "enforce",
		AllowedEgressHosts: []string{"api.openai.com", "github.com"},
	})
	d := e.Evaluate(context.Background(), EgressRequest{
		OriginalIP: "104.18.7.192", OriginalPort: 443, Domain: "api.openai.com", ResolvedIP: "104.18.7.192",
	})
	if d.Action != "allow" {
		t.Fatalf("expected allow, got %s: %s", d.Action, d.Reason)
	}
}

func TestEvaluateRestricted_DomainBlocked(t *testing.T) {
	e := New(&PolicyConfig{
		RuntimePolicy:      "agent-restricted",
		Mode:               "enforce",
		AllowedEgressHosts: []string{"api.openai.com"},
	})
	d := e.Evaluate(context.Background(), EgressRequest{
		OriginalIP: "93.184.216.34", OriginalPort: 443, Domain: "evil.com", ResolvedIP: "93.184.216.34",
	})
	if d.Action != "deny" {
		t.Fatalf("expected deny, got %s: %s", d.Action, d.Reason)
	}
}

func TestEvaluateRestricted_WildcardMatch(t *testing.T) {
	e := New(&PolicyConfig{
		RuntimePolicy:      "agent-restricted",
		Mode:               "enforce",
		AllowedEgressHosts: []string{"*.openai.com"},
	})
	d := e.Evaluate(context.Background(), EgressRequest{
		OriginalIP: "104.18.7.192", OriginalPort: 443, Domain: "api.openai.com", ResolvedIP: "104.18.7.192",
	})
	if d.Action != "allow" {
		t.Fatalf("expected allow via wildcard, got %s: %s", d.Action, d.Reason)
	}
}

func TestAuditMode(t *testing.T) {
	e := New(&PolicyConfig{RuntimePolicy: "agent-default", Mode: "audit"})
	d := e.Evaluate(context.Background(), EgressRequest{
		OriginalIP: "10.0.0.1", OriginalPort: 6443, ResolvedIP: "10.0.0.1",
	})
	if d.Action != "audit" {
		t.Fatalf("expected audit, got %s: %s", d.Action, d.Reason)
	}
}

func TestValidateInternalCIDR(t *testing.T) {
	tests := []struct {
		cidr    string
		wantErr bool
	}{
		{"10.0.1.100/32", false},
		{"10.0.0.0/16", false},
		{"10.0.0.0/8", true},  // too broad
		{"10.0.1.100", false}, // single IP, valid
		{"invalid", true},
	}
	for _, tt := range tests {
		err := ValidateInternalCIDR(tt.cidr)
		if (err != nil) != tt.wantErr {
			t.Errorf("ValidateInternalCIDR(%q) err=%v, wantErr=%v", tt.cidr, err, tt.wantErr)
		}
	}
}

func TestMergePolicy(t *testing.T) {
	cfg := MergePolicy(
		"agent-restricted",
		[]string{"api.openai.com"},
		[]string{"10.0.1.100/32"},
		[]string{"github.com", "api.openai.com"}, // duplicate should be deduped
		[]string{"10.0.2.0/24"},
	)
	if cfg.RuntimePolicy != "agent-restricted" {
		t.Fatalf("expected agent-restricted, got %s", cfg.RuntimePolicy)
	}
	if len(cfg.AllowedEgressHosts) != 2 {
		t.Fatalf("expected 2 egress hosts (deduped), got %d: %v", len(cfg.AllowedEgressHosts), cfg.AllowedEgressHosts)
	}
	if len(cfg.AllowedInternalHosts) != 2 {
		t.Fatalf("expected 2 internal hosts, got %d: %v", len(cfg.AllowedInternalHosts), cfg.AllowedInternalHosts)
	}
}

func TestUpdateConfig(t *testing.T) {
	e := New(&PolicyConfig{RuntimePolicy: "agent-default", Mode: "enforce"})

	d := e.Evaluate(context.Background(), EgressRequest{
		OriginalIP: "10.0.0.1", ResolvedIP: "10.0.0.1",
	})
	if d.Action != "deny" {
		t.Fatalf("before update: expected deny, got %s", d.Action)
	}

	e.UpdateConfig(&PolicyConfig{
		RuntimePolicy:        "agent-default",
		Mode:                 "enforce",
		AllowedInternalHosts: []string{"10.0.0.0/16"},
		Version:              2,
	})

	d = e.Evaluate(context.Background(), EgressRequest{
		OriginalIP: "10.0.0.1", ResolvedIP: "10.0.0.1",
	})
	if d.Action != "allow" {
		t.Fatalf("after update: expected allow, got %s: %s", d.Action, d.Reason)
	}
	if e.GetVersion() != 2 {
		t.Fatalf("expected version 2, got %d", e.GetVersion())
	}
}
