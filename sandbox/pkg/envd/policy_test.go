// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestCallWMSendsTheNewestTokenWMHasNotRefused walks a session's token through
// capture, refusal and replacement. Steps: "set X" captures X as a proxied
// request would; "call X,Y" expects WM to receive X then Y; "call -" expects no
// WM call. WM refuses tokens named "expired*" with 401 and "foreign*" with 403.
// On "expired-race" a newer request lands while WM is still answering; on
// "expired-overlap" it lands and has its own token refused first.
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
		{name: "late refusal of an older token keeps the newer refusal", steps: []string{"set expired-overlap", "call expired-overlap,expired-newer", "call -"}, wantErr: errAwaitingToken},
		{name: "same token captured again stays refused", steps: []string{"set expired-a", "call expired-a", "set expired-a", "call -"}, wantErr: errAwaitingToken},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var mu sync.Mutex
			var seen []string
			c := &inferenceKeyCache{sessionID: "sess-a", ready: make(chan struct{}), fetchStarted: true}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				assert.Equal(t, "/v1/internal/policy/sess-a", r.URL.Path)
				token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
				mu.Lock()
				seen = append(seen, token)
				mu.Unlock()
				switch {
				case token == "expired-race":
					c.setJWTToken("newer")
					w.WriteHeader(http.StatusUnauthorized)
				case token == "expired-overlap":
					c.setJWTToken("expired-newer")
					if resp, err := c.callWM(r.Context(), http.DefaultClient, http.MethodGet, "policy", nil); assert.NoError(t, err) {
						resp.Body.Close()
					}
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
				require.Equal(t, strings.Split(token, ","), got, step)
			}
		})
	}
}

// TestInferenceKeyFetchSurvivesARefusedToken: WM refuses the token the first
// fetch is made with -- its key cache has not caught up with a rotated Router
// key, or an audit upload had the same token refused first. The next proxied
// request brings a fresh token, and the exec it carries gets the API key.
func TestInferenceKeyFetchSurvivesARefusedToken(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		mu.Lock()
		seen = append(seen, token)
		mu.Unlock()
		if strings.HasPrefix(token, "refused") {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"policyVersion":1,"inference":{"apiKey":"sk-session"}}`))
	}))
	defer server.Close()

	c := &inferenceKeyCache{wmURL: server.URL, ready: make(chan struct{}), httpClient: server.Client()}
	c.setJWTToken("refused-a")
	c.setSessionID("sess-a")
	select {
	case <-c.ready:
	case <-time.After(time.Minute):
		t.Fatal("the first fetch never finished")
	}

	c.setJWTToken("fresh-b") // the next proxied request
	assert.Equal(t, "sk-session", c.getApiKey())
	mu.Lock()
	defer mu.Unlock()
	assert.Equal(t, []string{"refused-a", "fresh-b"}, seen)
}

// TestWaitForReadySaysItIsStillWaiting: a Pod that never sees a proxied request
// keeps the policy syncer waiting, and says so instead of waiting silently.
func TestWaitForReadySaysItIsStillWaiting(t *testing.T) {
	var buf bytes.Buffer
	var bufMu sync.Mutex
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&lockedWriter{w: &buf, mu: &bufMu}, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	synctest.Test(t, func(t *testing.T) {
		c := &inferenceKeyCache{ready: make(chan struct{})}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		result := make(chan bool, 1)
		go func() { result <- c.waitForReady(ctx) }()

		time.Sleep(readyWarnAfter + time.Second)
		synctest.Wait()
		bufMu.Lock()
		logged := buf.String()
		bufMu.Unlock()
		assert.Contains(t, logged, "policy sync is waiting")

		close(c.ready) // the first request finally arrives
		assert.True(t, <-result)
	})
}

type lockedWriter struct {
	w  io.Writer
	mu *sync.Mutex
}

func (l *lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}

// TestInferenceKeyWaitsForTheFetchARefusalHandsOverTo: the next proxied request
// brings a fresh token while the refused fetch is still waiting for WM. Its
// command must wait for the fetch made with the fresh token, not return when
// the refused one ends.
func TestInferenceKeyWaitsForTheFetchARefusalHandsOverTo(t *testing.T) {
	release := make(chan struct{})
	arrived := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ") == "refused-a" {
			arrived <- struct{}{}
			<-release
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		time.Sleep(50 * time.Millisecond) // the fresh fetch takes a moment too
		_, _ = w.Write([]byte(`{"policyVersion":1,"inference":{"apiKey":"sk-session"}}`))
	}))
	defer server.Close()

	c := &inferenceKeyCache{wmURL: server.URL, ready: make(chan struct{}), httpClient: server.Client()}
	c.setJWTToken("refused-a")
	c.setSessionID("sess-a")
	<-arrived

	c.setJWTToken("fresh-b") // the next proxied request, while WM still holds the first
	got := make(chan string, 1)
	go func() { got <- c.getApiKey() }()
	time.Sleep(50 * time.Millisecond)
	close(release)
	select {
	case key := <-got:
		assert.Equal(t, "sk-session", key)
	case <-time.After(time.Minute):
		t.Fatal("getApiKey never returned")
	}
}

// TestInferenceKeyWithoutWorkloadManagerDoesNotWait: with no WM URL the session
// ID closes ready without any fetch, and getApiKey returns at once.
func TestInferenceKeyWithoutWorkloadManagerDoesNotWait(t *testing.T) {
	c := &inferenceKeyCache{ready: make(chan struct{})}
	c.setSessionID("sess-a")
	got := make(chan string, 1)
	go func() { got <- c.getApiKey() }()
	select {
	case key := <-got:
		assert.Empty(t, key)
	case <-time.After(5 * time.Second):
		t.Fatal("getApiKey kept waiting with no fetch to wait for")
	}
}
