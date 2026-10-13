// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestCallWMSendsTheNewestTokenWMHasNotRefused walks a session's token through
// capture, refusal and replacement. Steps: "set X" captures X as a proxied
// request would; "call X" expects WM to receive X; "call -" expects no WM call.
// WM refuses tokens named "expired*" with 401 and "foreign*" with 403; on
// "expired-race" a newer request lands while WM is still answering.
func TestCallWMSendsTheNewestTokenWMHasNotRefused(t *testing.T) {
	tests := []struct {
		name      string
		sessionID string
		wmURL     string
		steps     []string
		wantErr   error // error of a "call -" step
	}{
		{name: "newest token wins", steps: []string{"set a", "set b", "call b"}},
		{name: "no token yet", steps: []string{"call -"}, wantErr: errAwaitingToken},
		{name: "no session yet", sessionID: "-", steps: []string{"set a", "call -"}, wantErr: errAwaitingToken},
		{name: "no workload manager", wmURL: "-", steps: []string{"set a", "call -"}, wantErr: errNoWM},
		{name: "expired token is not resent", steps: []string{"set expired-a", "call expired-a", "call -", "call -"}, wantErr: errAwaitingToken},
		{name: "fresh token after a refusal is sent", steps: []string{"set expired-a", "call expired-a", "call -", "set b", "call b", "call b"}, wantErr: errAwaitingToken},
		{name: "token for another session is not resent", steps: []string{"set foreign-a", "call foreign-a", "call -"}, wantErr: errAwaitingToken},
		{name: "refusing an older token keeps the newer one", steps: []string{"set expired-race", "call expired-race", "call newer"}},
		{name: "same token captured again stays refused", steps: []string{"set expired-a", "call expired-a", "set expired-a", "call -"}, wantErr: errAwaitingToken},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var mu sync.Mutex
			var seen []string
			c := &inferenceKeyCache{sessionID: "sess-a", ready: make(chan struct{}), fetchStarted: true}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, "/v1/internal/policy/sess-a", r.URL.Path)
				token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
				mu.Lock()
				seen = append(seen, token)
				mu.Unlock()
				switch {
				case token == "expired-race":
					c.setJWTToken("newer")
					w.WriteHeader(http.StatusUnauthorized)
				case strings.HasPrefix(token, "expired"):
					w.WriteHeader(http.StatusUnauthorized)
				case strings.HasPrefix(token, "foreign"):
					w.WriteHeader(http.StatusForbidden)
				default:
					w.WriteHeader(http.StatusOK)
				}
			}))
			defer server.Close()
			c.wmURL = server.URL
			if tc.wmURL == "-" {
				c.wmURL = ""
			}
			if tc.sessionID == "-" {
				c.sessionID = ""
			}

			for _, step := range tc.steps {
				verb, token, _ := strings.Cut(step, " ")
				if verb == "set" {
					c.setJWTToken(token)
					continue
				}
				mu.Lock()
				before := len(seen)
				mu.Unlock()
				resp, err := c.callWM(context.Background(), server.Client(), http.MethodGet, "policy", nil)
				mu.Lock()
				got := seen[before:]
				mu.Unlock()
				if token == "-" {
					require.ErrorIs(t, err, tc.wantErr, step)
					require.Empty(t, got, step)
					continue
				}
				require.NoError(t, err, step)
				resp.Body.Close()
				require.Equal(t, []string{token}, got, step)
			}
		})
	}
}
