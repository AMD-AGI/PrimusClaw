// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package safe implements the SaFE platform API Key verification client.
// It validates API Keys (ak-* prefix) by calling the SaFE apiserver,
// with an in-memory LRU cache (5min TTL, max 1000 entries) to reduce API calls.
package safe

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	// APIKeyPrefix is the required prefix for SaFE API Keys.
	APIKeyPrefix = "ak-"

	// defaultCacheTTL is how long a verification result is cached.
	defaultCacheTTL = 5 * time.Minute

	// defaultMaxCacheSize is the maximum number of cached entries.
	defaultMaxCacheSize = 1000

	// userSelfPath is the SaFE apiserver endpoint that returns the authenticated user's info.
	// When called with "Authorization: Bearer ak-xxx", returns the API Key owner's identity.
	userSelfPath = "/api/v1/users/self"
)

// UserInfo holds the verified user identity returned by SaFE.
type UserInfo struct {
	UserID   string   `json:"userId"`
	UserName string   `json:"userName,omitempty"`
	Roles    []string `json:"roles,omitempty"`
}

// cacheEntry holds a cached verification result.
type cacheEntry struct {
	user      *UserInfo
	err       error
	expiresAt time.Time
}

// Client is a SaFE API Key verification client with LRU caching.
type Client struct {
	baseURL    string
	httpClient *http.Client

	mu       sync.Mutex
	cache    map[string]*cacheEntry
	order    []string // insertion order for LRU eviction
	cacheTTL time.Duration
	maxCache int
}

// NewClient creates a new SaFE verification client.
// baseURL is the SaFE apiserver URL (e.g. "https://safe.example.com").
func NewClient(baseURL string) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
		cache:    make(map[string]*cacheEntry),
		order:    make([]string, 0, defaultMaxCacheSize),
		cacheTTL: defaultCacheTTL,
		maxCache: defaultMaxCacheSize,
	}
}

// IsAPIKey checks whether the given token has the SaFE API Key prefix.
func IsAPIKey(token string) bool {
	return strings.HasPrefix(token, APIKeyPrefix)
}

// VerifyAPIKey validates an API Key against the SaFE apiserver.
// Returns the verified user info or an error.
// Results are cached for 5 minutes (max 1000 entries).
func (c *Client) VerifyAPIKey(ctx context.Context, apiKey string) (*UserInfo, error) {
	if !IsAPIKey(apiKey) {
		return nil, fmt.Errorf("invalid API key format: must start with %q", APIKeyPrefix)
	}

	// Check cache
	if user, ok := c.getFromCache(apiKey); ok {
		return user, nil
	}

	// Call SaFE apiserver
	user, err := c.callSaFE(ctx, apiKey)
	if err != nil {
		// Cache negative results briefly (30s) to avoid hammering SaFE on bad keys
		c.putToCache(apiKey, nil, err, 30*time.Second)
		return nil, err
	}

	// Cache positive result
	c.putToCache(apiKey, user, nil, c.cacheTTL)
	return user, nil
}

// getFromCache returns a cached result if it exists and hasn't expired.
func (c *Client) getFromCache(apiKey string) (*UserInfo, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	entry, exists := c.cache[apiKey]
	if !exists {
		return nil, false
	}

	// Check expiration
	if time.Now().After(entry.expiresAt) {
		delete(c.cache, apiKey)
		c.removeFromOrder(apiKey)
		return nil, false
	}

	// If it was a cached error, we should still return "not found" to allow retry
	if entry.err != nil {
		return nil, false
	}

	// Move to end of order (most recently used)
	c.removeFromOrder(apiKey)
	c.order = append(c.order, apiKey)

	return entry.user, true
}

// putToCache stores a verification result in the cache.
func (c *Client) putToCache(apiKey string, user *UserInfo, err error, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Evict oldest entries if at capacity
	for len(c.cache) >= c.maxCache && len(c.order) > 0 {
		oldest := c.order[0]
		c.order = c.order[1:]
		delete(c.cache, oldest)
	}

	c.cache[apiKey] = &cacheEntry{
		user:      user,
		err:       err,
		expiresAt: time.Now().Add(ttl),
	}

	c.removeFromOrder(apiKey)
	c.order = append(c.order, apiKey)
}

// removeFromOrder removes a key from the insertion order slice.
func (c *Client) removeFromOrder(apiKey string) {
	for i, k := range c.order {
		if k == apiKey {
			c.order = append(c.order[:i], c.order[i+1:]...)
			return
		}
	}
}

// VerifyCookie validates a SaFE session cookie (Token + userType) against the SaFE apiserver.
// Used for browser/frontend authentication path.
// Results are cached using the token as cache key (same cache as API Key).
func (c *Client) VerifyCookie(ctx context.Context, token, userType string) (*UserInfo, error) {
	if token == "" {
		return nil, fmt.Errorf("empty Token cookie")
	}

	// Cache key: prefix with "cookie:" to avoid collision with API Key cache
	cacheKey := "cookie:" + token

	if user, ok := c.getFromCache(cacheKey); ok {
		return user, nil
	}

	user, err := c.callSaFEWithCookie(ctx, token, userType)
	if err != nil {
		c.putToCache(cacheKey, nil, err, 30*time.Second)
		return nil, err
	}

	c.putToCache(cacheKey, user, nil, c.cacheTTL)
	return user, nil
}

// callSaFEWithCookie calls SaFE /api/v1/users/self using cookie authentication.
func (c *Client) callSaFEWithCookie(ctx context.Context, token, userType string) (*UserInfo, error) {
	reqURL := c.baseURL + userSelfPath

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build SaFE request: %w", err)
	}
	req.AddCookie(&http.Cookie{Name: "Token", Value: token})
	if userType != "" {
		req.AddCookie(&http.Cookie{Name: "userType", Value: userType})
	}
	req.Header.Set("Content-Type", "application/json")

	return c.parseSaFEResponse(req)
}

// callSaFE makes the actual HTTP call to the SaFE apiserver using API Key.
func (c *Client) callSaFE(ctx context.Context, apiKey string) (*UserInfo, error) {
	reqURL := c.baseURL + userSelfPath

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build SaFE request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")

	return c.parseSaFEResponse(req)
}

// parseSaFEResponse executes the request and parses the /api/v1/users/self response.
// Shared by both API Key and cookie authentication paths.
func (c *Client) parseSaFEResponse(req *http.Request) (*UserInfo, error) {
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("SaFE API unreachable: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	switch resp.StatusCode {
	case http.StatusOK:
		var result userSelfResponse
		if err := json.Unmarshal(body, &result); err != nil {
			return nil, fmt.Errorf("parse SaFE response: %w", err)
		}
		if result.ID == "" {
			return nil, fmt.Errorf("SaFE returned empty user ID")
		}
		return &UserInfo{
			UserID:   result.ID,
			UserName: result.Name,
			Roles:    result.Roles,
		}, nil

	case http.StatusUnauthorized:
		return nil, fmt.Errorf("invalid or expired credential")

	case http.StatusForbidden:
		return nil, fmt.Errorf("access forbidden")

	default:
		return nil, fmt.Errorf("SaFE returned HTTP %d: %s", resp.StatusCode, string(body))
	}
}

// userSelfResponse maps the SaFE GET /api/v1/users/self response.
// This endpoint returns the authenticated user's full identity.
type userSelfResponse struct {
	ID    string   `json:"id"`    // User ID
	Name  string   `json:"name"`  // Display name
	Email string   `json:"email"` // Email
	Type  string   `json:"type"`  // User type
	Roles []string `json:"roles"` // User roles: system-admin, system-admin-readonly, default
}

// CacheStats returns current cache statistics (for monitoring/debugging).
func (c *Client) CacheStats() (size int, maxSize int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.cache), c.maxCache
}
