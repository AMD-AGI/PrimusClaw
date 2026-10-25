// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	log "sigs.k8s.io/agent-sandbox/pkg/logx"
)

// sessionContext holds the identity EnvD learns from proxied requests: the
// sandbox id and the newest Router-signed JWT. The egress policy syncer and the
// egress audit reporter both authenticate to Workload Manager with these.
type sessionContext struct {
	mu sync.RWMutex

	wmURL     string // Workload Manager base URL, from the Pod environment
	jwtToken  string // newest Router-signed JWT; Router signs one per proxied request
	refused   string // a token Workload Manager refused, never sent again
	sessionID string // namespace/name, set once from the first request

	ready      chan struct{} // closed once the identity is usable
	closeReady sync.Once
}

func newSessionContext() *sessionContext {
	wmURL := os.Getenv("WORKLOAD_MANAGER_URL")
	if wmURL != "" {
		wmURL = strings.TrimRight(wmURL, "/")
	}
	return &sessionContext{wmURL: wmURL, ready: make(chan struct{})}
}

// setJWTToken records the newest Router-signed JWT. Each token expires five
// minutes after the Router signed it, so envd keeps calling Workload Manager
// on the latest one.
func (c *sessionContext) setJWTToken(token string) {
	if token == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.jwtToken = token
	c.signalReadyLocked()
}

// setSessionID records the sandbox id (first write wins).
func (c *sessionContext) setSessionID(id string) {
	if id == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sessionID == "" {
		c.sessionID = id
	}
	c.signalReadyLocked()
}

// signalReadyLocked releases the waiters once the identity can actually be used.
// A sandbox id alone is not enough while a Workload Manager is configured: every
// call to it is authenticated with the JWT, so releasing before the token lands
// starts a syncer whose every request is rejected. Must be called with mu held.
func (c *sessionContext) signalReadyLocked() {
	if c.sessionID == "" {
		return
	}
	if c.wmURL != "" && c.jwtToken == "" {
		return
	}
	c.closeReady.Do(func() { close(c.ready) })
}

func (c *sessionContext) getSessionID() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.sessionID
}

func (c *sessionContext) getJWTToken() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.jwtToken
}

func (c *sessionContext) getWMURL() string {
	return c.wmURL
}

// readyWarnAfter is how long waitForReady waits before saying so.
const readyWarnAfter = 30 * time.Second

var (
	errNoWM          = errors.New("workload manager URL is not set")
	errAwaitingToken = errors.New("awaiting a Router token workload manager accepts")
)

// waitForReady blocks until the first proxied request supplies the identity,
// or ctx ends. The fetch follows the first proxied request, which a warm-pool
// Pod sees only once it is claimed.
func (c *sessionContext) waitForReady(ctx context.Context) bool {
	warn := time.NewTimer(readyWarnAfter)
	defer warn.Stop()
	for {
		select {
		case <-c.ready:
			return true
		case <-ctx.Done():
			return false
		case <-warn.C:
			log.Warn("sessionContext: no proxied request with a session ID and Router token yet; policy sync is waiting for one",
				"waited", readyWarnAfter)
		}
	}
}

// callWM calls Workload Manager's internal API for this sandbox's session with
// the newest Router token. A token WM refuses has expired or is otherwise
// unusable, so it is not sent again: until the next proxied request brings a
// fresh one -- the first one also brings the session ID -- callWM returns
// errAwaitingToken without calling WM.
func (c *sessionContext) callWM(ctx context.Context, client *http.Client, method, api string, body io.Reader) (*http.Response, error) {
	c.mu.RLock()
	wmURL, sessionID, token, refused := c.wmURL, c.sessionID, c.jwtToken, c.refused
	c.mu.RUnlock()
	if wmURL == "" {
		return nil, errNoWM
	}
	if sessionID == "" || token == "" || token == refused {
		return nil, errAwaitingToken
	}

	req, err := http.NewRequestWithContext(ctx, method, fmt.Sprintf("%s/v1/internal/%s/%s", wmURL, api, sessionID), body)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request: %w", err)
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		c.mu.Lock()
		if c.jwtToken == token { // a newer request may have replaced it meanwhile
			c.refused = token
		}
		c.mu.Unlock()
	}
	return resp, nil
}
