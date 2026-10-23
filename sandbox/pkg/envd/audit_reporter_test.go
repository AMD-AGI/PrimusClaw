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
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"sigs.k8s.io/agent-sandbox/pkg/envd/egress"
)

// TestEgressAuditReporterHoldsEventsUntilWMAcceptsAToken drives the reporter the
// way Run does: each step is "deny D" (an egress decision) or "token T" (a
// proxied request brings T, the first one also the session ID, and wakes the
// reporter). WM answers 401 to tokens named "expired*" and 500 to "broken*",
// and drops the connection of requests with "dropped*".
func TestEgressAuditReporterHoldsEventsUntilWMAcceptsAToken(t *testing.T) {
	overflow := []string{"token expired"}
	for i := range maxHeldAuditEvents + 1 {
		overflow = append(overflow, fmt.Sprintf("deny d%d", i))
	}
	overflow = append(overflow, "token fresh")

	tests := []struct {
		name          string
		steps         []string
		wantDelivered []string
		wantHeld      int
		wantCalls     int // requests WM received
	}{
		{name: "token at hand", steps: []string{"token a", "deny x"}, wantDelivered: []string{"x"}, wantCalls: 1},
		{name: "before the first request", steps: []string{"deny x", "deny y"}, wantHeld: 2},
		{name: "first request delivers what was held", steps: []string{"deny x", "deny y", "token a"}, wantDelivered: []string{"x", "y"}, wantCalls: 2},
		{name: "expired token holds events in order", steps: []string{"token expired", "deny x", "deny y"}, wantHeld: 2, wantCalls: 1},
		{name: "refused token is not retried", steps: []string{"token expired", "deny x", "token expired"}, wantHeld: 1, wantCalls: 1},
		{name: "fresh token after idle delivers in order", steps: []string{"token expired", "deny x", "deny y", "token b", "deny z"}, wantDelivered: []string{"x", "y", "z"}, wantCalls: 4},
		{name: "server error keeps the event", steps: []string{"token broken", "deny x", "token broken2"}, wantHeld: 1, wantCalls: 2},
		{name: "server error is retried", steps: []string{"token broken", "deny x", "token b"}, wantDelivered: []string{"x"}, wantCalls: 2},
		{name: "dropped connection is retried", steps: []string{"token dropped", "deny x", "deny y", "token b"}, wantDelivered: []string{"x", "y"}, wantCalls: 4},
		{name: "full hold drops the oldest", steps: overflow, wantCalls: maxHeldAuditEvents + 1, wantDelivered: func() []string {
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
			observed := map[string]string{}
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				calls++
				mu.Unlock()
				assert.Equal(t, "/v1/internal/audit/sess-a", r.URL.Path)
				token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
				switch {
				case strings.HasPrefix(token, "expired"):
					w.WriteHeader(http.StatusUnauthorized)
					return
				case strings.HasPrefix(token, "broken"):
					w.WriteHeader(http.StatusInternalServerError)
					return
				case strings.HasPrefix(token, "dropped"):
					conn, _, err := http.NewResponseController(w).Hijack()
					if assert.NoError(t, err) {
						conn.Close()
					}
					return
				}
				var body internalAuditRequest
				if !assert.NoError(t, json.NewDecoder(r.Body).Decode(&body)) {
					return
				}
				mu.Lock()
				delivered = append(delivered, body.Egress.Domain)
				observed[body.Egress.Domain] = body.Metadata["observedAt"]
				mu.Unlock()
				w.WriteHeader(http.StatusAccepted)
			}))
			defer server.Close()

			session := &sessionContext{wmURL: server.URL, ready: make(chan struct{})}
			r := newEgressAuditReporter(session)
			ctx := context.Background()
			base := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
			at := map[string]time.Time{}
			for i, step := range tc.steps {
				verb, arg, _ := strings.Cut(step, " ")
				switch verb {
				case "deny":
					at[arg] = base.Add(time.Duration(i) * time.Minute)
					r.hold(egress.DecisionEvent{Action: "deny", Stage: "policy", Domain: arg}, at[arg])
					r.flush(ctx)
				case "token":
					session.setJWTToken(arg)
					session.setSessionID("sess-a")
					r.flush(ctx)
				}
			}
			mu.Lock()
			defer mu.Unlock()
			require.Equal(t, tc.wantDelivered, delivered)
			require.Equal(t, tc.wantHeld, r.heldCount())
			require.Equal(t, tc.wantCalls, calls)
			for _, domain := range delivered {
				require.Equal(t, at[domain].Format(time.RFC3339Nano), observed[domain], domain)
			}
		})
	}
}
