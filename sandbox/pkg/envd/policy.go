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
	fetchStarted bool   // true once the fetch goroutine has been launched

	ready      chan struct{} // closed when fetch completes (success or failure)
	closeReady sync.Once

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

// tryStartFetch starts the background fetch goroutine if both sessionID and
// jwtToken are set and fetch hasn't been started yet. Must be called with mu held.
func (c *inferenceKeyCache) tryStartFetch() {
	if c.sessionID == "" || c.jwtToken == "" || c.wmURL == "" || c.fetchStarted {
		return
	}
	c.fetchStarted = true
	go c.fetch(context.Background())
}

// getApiKey returns the cached inference API Key (empty if not yet fetched or disabled).
// Blocks up to 15s for the initial fetch to complete; returns empty on timeout
// (e.g. when JWT is never captured because authMode=none).
func (c *inferenceKeyCache) getApiKey() string {
	c.mu.RLock()
	hasSession := c.sessionID != ""
	key := c.apiKey
	fetched := c.fetched
	c.mu.RUnlock()

	if fetched {
		return key
	}
	if !hasSession {
		return key
	}

	select {
	case <-c.ready:
	case <-time.After(15 * time.Second):
		log.Warn("inferenceKeyCache: timed out waiting for policy fetch (JWT may not have been captured)")
	}

	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.apiKey
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
	select {
	case <-c.ready:
		return true
	case <-ctx.Done():
		return false
	}
}

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

// fetch calls WM once to get the inference API Key and caches the result.
// Retries a few times on transient failures (WM may not be ready yet when
// the first request arrives right after Pod startup).
func (c *inferenceKeyCache) fetch(ctx context.Context) {
	defer c.closeReady.Do(func() { close(c.ready) })

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

	log.Warn("inferenceKeyCache: all retries exhausted, inference API key not available",
		"sessionId", sid)
}

func (c *inferenceKeyCache) doFetch(ctx context.Context) (string, error) {
	resp, err := c.callWM(ctx, c.httpClient, http.MethodGet, "policy", nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

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
