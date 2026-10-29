// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package identity validates primus-identity API keys through RFC 7662 token introspection.
package identity

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	positiveTTL  = 30 * time.Second
	negativeTTL  = 5 * time.Second
	maxCacheSize = 4096
	maxBodyBytes = 1 << 20
)

// ErrInactive means identity reported the key as not active.
var ErrInactive = errors.New("identity key is not active")

// ErrUnavailable means identity could not answer. It never means the key is invalid.
var ErrUnavailable = errors.New("identity is unavailable")

// Token is the introspection result of an active key.
type Token struct {
	Subject string
	Email   string
	Roles   []string
}

// HasRole reports whether the token carries role.
func (t Token) HasRole(role string) bool {
	for _, r := range t.Roles {
		if r == role {
			return true
		}
	}
	return false
}

type cacheEntry struct {
	token   Token
	active  bool
	expires time.Time
}

// Client calls the identity introspection endpoint with client_secret_basic.
// Active results are cached for 30s and inactive results for 5s.
type Client struct {
	url          string
	clientID     string
	clientSecret string
	http         *http.Client
	now          func() time.Time

	mu    sync.Mutex
	cache map[string]cacheEntry
}

// NewClient returns an introspection client for endpoint.
func NewClient(endpoint, clientID, clientSecret string) *Client {
	return &Client{
		url:          endpoint,
		clientID:     clientID,
		clientSecret: clientSecret,
		http:         &http.Client{Timeout: 5 * time.Second},
		now:          time.Now,
		cache:        map[string]cacheEntry{},
	}
}

// FromEnv reads IDENTITY_INTROSPECT_URL, IDENTITY_CLIENT_ID, and IDENTITY_CLIENT_SECRET.
// It returns nil when the URL is unset.
func FromEnv() (*Client, error) {
	endpoint := strings.TrimSpace(os.Getenv("IDENTITY_INTROSPECT_URL"))
	if endpoint == "" {
		return nil, nil
	}
	id := strings.TrimSpace(os.Getenv("IDENTITY_CLIENT_ID"))
	secret := strings.TrimSpace(os.Getenv("IDENTITY_CLIENT_SECRET"))
	if id == "" || secret == "" {
		return nil, fmt.Errorf("IDENTITY_CLIENT_ID and IDENTITY_CLIENT_SECRET are required with IDENTITY_INTROSPECT_URL")
	}
	return NewClient(endpoint, id, secret), nil
}

// Introspect returns the token for an active key, ErrInactive, or ErrUnavailable.
func (c *Client) Introspect(ctx context.Context, key string) (Token, error) {
	if c == nil {
		return Token{}, ErrUnavailable
	}
	if key == "" {
		return Token{}, ErrInactive
	}
	sum := sha256.Sum256([]byte(key))
	cacheKey := hex.EncodeToString(sum[:])
	if entry, ok := c.cached(cacheKey); ok {
		if !entry.active {
			return Token{}, ErrInactive
		}
		return entry.token, nil
	}
	token, active, err := c.call(ctx, key)
	if err != nil {
		return Token{}, err
	}
	c.store(cacheKey, token, active)
	if !active {
		return Token{}, ErrInactive
	}
	return token, nil
}

// call performs one introspection request.
func (c *Client) call(ctx context.Context, key string) (Token, bool, error) {
	form := url.Values{"token": {key}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, strings.NewReader(form.Encode()))
	if err != nil {
		return Token{}, false, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.SetBasicAuth(url.QueryEscape(c.clientID), url.QueryEscape(c.clientSecret))
	resp, err := c.http.Do(req)
	if err != nil {
		return Token{}, false, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return Token{}, false, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if resp.StatusCode != http.StatusOK {
		return Token{}, false, fmt.Errorf("%w: status %d", ErrUnavailable, resp.StatusCode)
	}
	var out struct {
		Active bool     `json:"active"`
		Sub    string   `json:"sub"`
		Email  string   `json:"email"`
		Roles  []string `json:"roles"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return Token{}, false, fmt.Errorf("%w: response is not JSON", ErrUnavailable)
	}
	if !out.Active || out.Sub == "" {
		return Token{}, false, nil
	}
	return Token{Subject: out.Sub, Email: out.Email, Roles: out.Roles}, true, nil
}

// cached returns an unexpired entry.
func (c *Client) cached(key string) (cacheEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.cache[key]
	if !ok {
		return cacheEntry{}, false
	}
	if !c.now().Before(entry.expires) {
		delete(c.cache, key)
		return cacheEntry{}, false
	}
	return entry, true
}

// store caches a result and drops expired entries when the cache is full.
func (c *Client) store(key string, token Token, active bool) {
	ttl := negativeTTL
	if active {
		ttl = positiveTTL
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if len(c.cache) >= maxCacheSize {
		for k, e := range c.cache {
			if !now.Before(e.expires) {
				delete(c.cache, k)
			}
		}
		if len(c.cache) >= maxCacheSize {
			c.cache = map[string]cacheEntry{}
		}
	}
	c.cache[key] = cacheEntry{token: token, active: active, expires: now.Add(ttl)}
}
