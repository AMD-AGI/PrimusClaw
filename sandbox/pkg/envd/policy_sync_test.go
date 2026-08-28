// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"sigs.k8s.io/agent-sandbox/pkg/envd/egress"
	"sigs.k8s.io/agent-sandbox/pkg/policy"
)

func TestPolicySyncerSyncsAllowedInternalHostsToSSRFChecker(t *testing.T) {
	engine := policy.New(&policy.PolicyConfig{
		RuntimePolicy: "agent-default",
		Mode:          "enforce",
		Version:       0,
	})

	ssrf, err := egress.NewSSRFChecker(nil)
	if err != nil {
		t.Fatalf("NewSSRFChecker: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/internal/policy/sess_test" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(egressPolicyResponse{
			RuntimePolicy:        "agent-default",
			PolicyMode:           "enforce",
			AllowedEgressHosts:   []string{"httpbin.org"},
			AllowedInternalHosts: []string{"10.0.1.100"},
			PolicyVersion:        1,
		})
	}))
	defer server.Close()

	syncer := NewPolicySyncer(engine, ssrf, server.URL, "sess_test", "")
	syncer.syncOnce(context.Background())

	cfg := engine.GetConfig()
	if cfg == nil {
		t.Fatal("expected engine config to be updated")
	}
	if cfg.Version != 1 {
		t.Fatalf("expected version=1, got %d", cfg.Version)
	}
	if len(cfg.AllowedInternalHosts) != 1 || cfg.AllowedInternalHosts[0] != "10.0.1.100" {
		t.Fatalf("unexpected allowedInternalHosts: %#v", cfg.AllowedInternalHosts)
	}

	if res := ssrf.Check(net.ParseIP("10.0.1.100")); res.Blocked {
		t.Fatalf("10.0.1.100 should be allowed after sync, got blocked: %+v", res)
	}
	if res := ssrf.Check(net.ParseIP("10.0.1.101")); !res.Blocked {
		t.Fatalf("10.0.1.101 should still be blocked after sync, got: %+v", res)
	}
}
