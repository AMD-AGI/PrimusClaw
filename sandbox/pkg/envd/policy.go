// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// inferenceKeyCache fetches the user's inference API Key from Workload Manager
// once (on first request) and caches it for the lifetime of the sandbox.
//
// The API Key is fixed at sandbox creation time (stored in Redis by WM) and
// never changes, so a single fetch is sufficient. No periodic polling needed.
type inferenceKeyCache struct {
	mu sync.RWMutex

	wmURL        string // Workload Manager base URL
	jwtToken     string // Router-signed JWT captured from first incoming request
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

// setJWTToken captures the Router-signed JWT (first-write-wins) and triggers
// policy fetch when sessionID is also set. Safe because fetch (~6s) ≪ JWT TTL (5min+1min leeway).
func (c *inferenceKeyCache) setJWTToken(token string) {
	if token == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.jwtToken == "" {
		c.jwtToken = token
	}
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
		slog.Debug("inferenceKeyCache: WORKLOAD_MANAGER_URL not set, skipping fetch")
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
		slog.Warn("inferenceKeyCache: timed out waiting for policy fetch (JWT may not have been captured)")
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

// getJWTToken returns the captured Router JWT.
func (c *inferenceKeyCache) getJWTToken() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.jwtToken
}

// getWMURL returns the Workload Manager URL.
func (c *inferenceKeyCache) getWMURL() string {
	return c.wmURL
}

// waitForReady blocks until the first policy fetch completes (or times out).
func (c *inferenceKeyCache) waitForReady() {
	select {
	case <-c.ready:
	case <-time.After(30 * time.Second):
		slog.Warn("inferenceKeyCache: timed out waiting for first request")
	}
}

// fetch calls WM once to get the inference API Key and caches the result.
// Retries a few times on transient failures (WM may not be ready yet when
// the first request arrives right after Pod startup).
func (c *inferenceKeyCache) fetch(ctx context.Context) {
	defer c.closeReady.Do(func() { close(c.ready) })

	c.mu.RLock()
	sid := c.sessionID
	wmURL := c.wmURL
	c.mu.RUnlock()

	if sid == "" || wmURL == "" {
		return
	}

	url := fmt.Sprintf("%s/v1/internal/policy/%s", wmURL, sid)

	const maxRetries = 3
	for attempt := 0; attempt < maxRetries; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Duration(attempt) * 2 * time.Second):
			}
		}

		apiKey, err := c.doFetch(ctx, url)
		if err != nil {
			slog.Warn("inferenceKeyCache: fetch failed",
				"attempt", attempt+1, "error", err)
			continue
		}

		c.mu.Lock()
		c.apiKey = apiKey
		c.fetched = true
		c.mu.Unlock()

		if apiKey != "" {
			slog.Info("inferenceKeyCache: API key cached", "sessionId", sid)
		} else {
			slog.Debug("inferenceKeyCache: inference not enabled for this session", "sessionId", sid)
		}
		return
	}

	slog.Warn("inferenceKeyCache: all retries exhausted, inference API key not available",
		"sessionId", sid)
}

func (c *inferenceKeyCache) doFetch(ctx context.Context, url string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", fmt.Errorf("build request: %w", err)
	}
	c.mu.RLock()
	jwt := c.jwtToken
	c.mu.RUnlock()
	if jwt != "" {
		req.Header.Set("Authorization", "Bearer "+jwt)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("request: %w", err)
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
