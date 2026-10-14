// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"context"
	"encoding/json"
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

// inferenceKeyCache fetches the user's inference API Key from Workload Manager
// once (on first request) and caches it for the lifetime of the sandbox. It also
// holds the session ID and Router token every envd call to WM is made with.
//
// The API Key is fixed at sandbox creation time (stored in Redis by WM) and
// never changes, so a single fetch is sufficient. No periodic polling needed.
type inferenceKeyCache struct {
	mu sync.RWMutex

	wmURL        string // Workload Manager base URL
	jwtToken     string // newest Router-signed JWT; Router signs one per proxied request
	refused      string // a token Workload Manager refused, never sent again
	sessionID    string // set once, from first request's x-session-id header
	apiKey       string // cached after successful fetch
	fetched      bool   // true after first successful fetch (apiKey may still be empty)
	fetchStarted bool   // true while a fetch goroutine runs

	ready      chan struct{} // closed when the first fetch completes (success or failure)
	closeReady sync.Once
	fetchDone  chan struct{} // closed when the latest fetch completes

	httpClient *http.Client
}

// policyResponse mirrors the WM internal policy JSON.
type policyResponse struct {
	PolicyVersion int             `json:"policyVersion"`
	Inference     *inferenceField `json:"inference,omitempty"`
}

type inferenceField struct {
	ApiKey string `json:"apiKey,omitempty"`
}

func newInferenceKeyCache() *inferenceKeyCache {
	wmURL := os.Getenv("WORKLOAD_MANAGER_URL")
	if wmURL != "" {
		wmURL = strings.TrimRight(wmURL, "/")
	}

	return &inferenceKeyCache{
		wmURL: wmURL,
		ready: make(chan struct{}),
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// setJWTToken records the newest Router-signed JWT and triggers the policy fetch
// when sessionID is also set. Each token expires five minutes after the Router
// signed it, so envd keeps calling Workload Manager on the latest one.
func (c *inferenceKeyCache) setJWTToken(token string) {
	if token == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.jwtToken = token
	c.tryStartFetch()
}

// setSessionID records the session ID (first write wins).
// If both sessionID and jwtToken are now available, triggers the one-time policy fetch.
func (c *inferenceKeyCache) setSessionID(id string) {
	if id == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.sessionID != "" {
		return // already set
	}
	c.sessionID = id

	if c.wmURL == "" {
		log.Debug("inferenceKeyCache: WORKLOAD_MANAGER_URL not set, skipping fetch")
		c.closeReady.Do(func() { close(c.ready) })
		return
	}

	c.tryStartFetch()
}

// tryStartFetch starts the background fetch goroutine if sessionID and a token
// WM has not refused are set, no fetch is running and none has succeeded. A
// fetch that ended without the key is started again by the next proxied request
// that brings a fresh token. Must be called with mu held.
func (c *inferenceKeyCache) tryStartFetch() {
	if c.sessionID == "" || c.jwtToken == "" || c.jwtToken == c.refused || c.wmURL == "" || c.fetchStarted || c.fetched {
		return
	}
	c.fetchStarted = true
	done := make(chan struct{})
	c.fetchDone = done
	go c.fetch(context.Background(), done)
}

// getApiKey returns the cached inference API Key (empty if not yet fetched or disabled).
// It waits, up to 15s in all, for a running fetch -- and any fetch that one
// hands over to with a fresher token -- or, before any fetch has started, for
// the first one; it returns empty on timeout (e.g. when JWT is never captured
// because authMode=none).
func (c *inferenceKeyCache) getApiKey() string {
	timeout := time.NewTimer(15 * time.Second)
	defer timeout.Stop()
	for waitedFirst := false; ; {
		c.mu.RLock()
		hasSession := c.sessionID != ""
		key := c.apiKey
		fetched := c.fetched
		running := c.fetchStarted
		done := c.fetchDone
		c.mu.RUnlock()

		if fetched || !hasSession {
			return key
		}
		wait := done
		switch {
		case running:
			// wait for it, then look again: it may hand over to a new fetch
		case done != nil || waitedFirst:
			return key // the latest fetch ended without a key; the next request retries
		default:
			wait, waitedFirst = c.ready, true // no fetch has started yet
		}

		select {
		case <-wait:
		case <-timeout.C:
			log.Warn("inferenceKeyCache: timed out waiting for policy fetch (JWT may not have been captured)")
			c.mu.RLock()
			defer c.mu.RUnlock()
			return c.apiKey
		}
	}
}

// getSessionID returns the captured session ID.
func (c *inferenceKeyCache) getSessionID() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.sessionID
}

// getWMURL returns the Workload Manager URL.
func (c *inferenceKeyCache) getWMURL() string {
	return c.wmURL
}

// waitForReady blocks until the first policy fetch completes, or ctx ends. The
// fetch follows the first proxied request, which a warm-pool Pod sees only once
// it is claimed.
func (c *inferenceKeyCache) waitForReady(ctx context.Context) bool {
	warn := time.NewTimer(readyWarnAfter)
	defer warn.Stop()
	for {
		select {
		case <-c.ready:
			return true
		case <-ctx.Done():
			return false
		case <-warn.C:
			log.Warn("inferenceKeyCache: no proxied request with a session ID and Router token yet; policy sync is waiting for one",
				"waited", readyWarnAfter)
		}
	}
}

// readyWarnAfter is how long waitForReady waits before saying so.
const readyWarnAfter = 30 * time.Second

var (
	errNoWM          = errors.New("workload manager URL is not set")
	errAwaitingToken = errors.New("awaiting a Router token workload manager accepts")
)

// callWM calls Workload Manager's internal API for this sandbox's session with
// the newest Router token. A token WM refuses has expired or is otherwise
// unusable, so it is not sent again: until the next proxied request brings a
// fresh one -- the first one also brings the session ID -- callWM returns
// errAwaitingToken without calling WM.
func (c *inferenceKeyCache) callWM(ctx context.Context, client *http.Client, method, api string, body io.Reader) (*http.Response, error) {
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

// fetch calls WM to get the inference API Key and caches the result.
// Retries a few times on transient failures (WM may not be ready yet when
// the first request arrives right after Pod startup). Once WM has refused the
// token, retrying cannot help: fetch ends, and the next proxied request starts
// it again with the fresh token it brings.
func (c *inferenceKeyCache) fetch(ctx context.Context, done chan struct{}) {
	awaitingToken := false
	defer func() {
		c.mu.Lock()
		c.fetchStarted = false
		if awaitingToken {
			c.tryStartFetch() // a fresh token may have arrived while this one was refused
		}
		c.mu.Unlock()
		close(done)
		c.closeReady.Do(func() { close(c.ready) })
	}()

	sid := c.getSessionID()

	const maxRetries = 3
	for attempt := 0; attempt < maxRetries; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Duration(attempt) * 2 * time.Second):
			}
		}

		apiKey, err := c.doFetch(ctx)
		if errors.Is(err, errAwaitingToken) {
			awaitingToken = true
			log.Warn("inferenceKeyCache: Workload Manager refused the Router token; fetching again on the next request",
				"sessionId", sid)
			return
		}
		if err != nil {
			log.Warn("inferenceKeyCache: fetch failed",
				"attempt", attempt+1, "error", err)
			continue
		}

		c.mu.Lock()
		c.apiKey = apiKey
		c.fetched = true
		c.mu.Unlock()

		if apiKey != "" {
			log.Info("inferenceKeyCache: API key cached", "sessionId", sid)
		} else {
			log.Debug("inferenceKeyCache: inference not enabled for this session", "sessionId", sid)
		}
		return
	}

	log.Warn("inferenceKeyCache: all retries exhausted, inference API key not available until the next request",
		"sessionId", sid)
}

func (c *inferenceKeyCache) doFetch(ctx context.Context) (string, error) {
	resp, err := c.callWM(ctx, c.httpClient, http.MethodGet, "policy", nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return "", fmt.Errorf("%w: status %d", errAwaitingToken, resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return "", fmt.Errorf("non-200 response: %d %s", resp.StatusCode, string(body))
	}

	var policy policyResponse
	if err := json.NewDecoder(resp.Body).Decode(&policy); err != nil {
		return "", fmt.Errorf("decode: %w", err)
	}

	if policy.Inference != nil {
		return policy.Inference.ApiKey, nil
	}
	return "", nil
}
