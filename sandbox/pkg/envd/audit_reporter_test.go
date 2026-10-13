// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"sigs.k8s.io/agent-sandbox/pkg/envd/egress"
)

// TestEgressAuditReporterHoldsEventsUntilWMAcceptsAToken drives the reporter the
// way Run does: each step is "deny D" (an egress decision), "token T" (a proxied
// request brings T, and the first one the session ID) or "tick" (the retry
// timer). WM answers 401 to tokens named "expired*" and 500 to "broken*".
func TestEgressAuditReporterHoldsEventsUntilWMAcceptsAToken(t *testing.T) {
	overflow := []string{"token expired"}
	for i := range maxHeldAuditEvents + 1 {
		overflow = append(overflow, fmt.Sprintf("deny d%d", i))
	}
	overflow = append(overflow, "token fresh", "tick")

	tests := []struct {
		name          string
		steps         []string
		wantDelivered []string
		wantHeld      int
	}{
		{name: "token at hand", steps: []string{"token a", "deny x"}, wantDelivered: []string{"x"}},
		{name: "before the first request", steps: []string{"deny x", "deny y"}, wantHeld: 2},
		{name: "first request delivers what was held", steps: []string{"deny x", "deny y", "token a", "tick"}, wantDelivered: []string{"x", "y"}},
		{name: "expired token holds events in order", steps: []string{"token expired", "deny x", "deny y", "tick"}, wantHeld: 2},
		{name: "fresh token after idle delivers in order", steps: []string{"token expired", "deny x", "deny y", "token b", "tick", "deny z"}, wantDelivered: []string{"x", "y", "z"}},
		{name: "new event after a fresh token flushes the held ones first", steps: []string{"token expired", "deny x", "token b", "deny y"}, wantDelivered: []string{"x", "y"}},
		{name: "server error is not retried", steps: []string{"token broken", "deny x", "tick"}},
		{name: "full hold drops the oldest", steps: overflow, wantDelivered: func() []string {
			var want []string
			for i := 1; i <= maxHeldAuditEvents; i++ {
				want = append(want, fmt.Sprintf("d%d", i))
			}
			return want
		}()},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var mu sync.Mutex
			var delivered []string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, "/v1/internal/audit/sess-a", r.URL.Path)
				token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
				switch {
				case strings.HasPrefix(token, "expired"):
					w.WriteHeader(http.StatusUnauthorized)
					return
				case strings.HasPrefix(token, "broken"):
					w.WriteHeader(http.StatusInternalServerError)
					return
				}
				var body internalAuditRequest
				require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
				mu.Lock()
				delivered = append(delivered, body.Egress.Domain)
				mu.Unlock()
				w.WriteHeader(http.StatusAccepted)
			}))
			defer server.Close()

			cache := &inferenceKeyCache{wmURL: server.URL, ready: make(chan struct{}), fetchStarted: true}
			r := newEgressAuditReporter(cache)
			ctx := context.Background()
			for _, step := range tc.steps {
				verb, arg, _ := strings.Cut(step, " ")
				switch verb {
				case "deny":
					r.hold(egress.DecisionEvent{Action: "deny", Stage: "policy", Domain: arg})
					r.flush(ctx)
				case "token":
					cache.setJWTToken(arg)
					cache.setSessionID("sess-a")
				case "tick":
					r.flush(ctx)
				}
			}
			mu.Lock()
			defer mu.Unlock()
			require.Equal(t, tc.wantDelivered, delivered)
			require.Len(t, r.held, tc.wantHeld)
		})
	}
}
