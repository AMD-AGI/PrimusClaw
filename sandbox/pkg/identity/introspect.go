// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package identity validates primus-identity API keys through RFC 7662 token introspection.
package identity

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
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

	"golang.org/x/sync/singleflight"

	log "sigs.k8s.io/agent-sandbox/pkg/logx"
)

const (
	positiveTTL     = 30 * time.Second
	negativeTTL     = 5 * time.Second
	maxCacheSize    = 4096
	maxBodyBytes    = 1 << 20
	callTimeout     = 5 * time.Second
	defaultAudience = "agent-sandbox"
)

// ErrInactive means identity reported the key as not active, or active for another audience.
var ErrInactive = errors.New("identity key is not active")

// ErrUnavailable means identity could not answer. It never means the key is invalid.
var ErrUnavailable = errors.New("identity is unavailable")

// Token is the introspection result of an active key.
type Token struct {
	Subject string
	Email   string
	Roles   []string
	expires time.Time
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
	expires time.Time
}

// boundedCache is a TTL map that evicts expired entries, then one entry, when full.
type boundedCache struct {
	entries map[string]cacheEntry
}

func (b *boundedCache) get(key string, now time.Time) (cacheEntry, bool) {
	e, ok := b.entries[key]
	if !ok {
		return cacheEntry{}, false
	}
	if !now.Before(e.expires) {
		delete(b.entries, key)
		return cacheEntry{}, false
	}
	return e, true
}

func (b *boundedCache) put(key string, e cacheEntry, now time.Time) {
	if _, ok := b.entries[key]; !ok && len(b.entries) >= maxCacheSize {
		for k, old := range b.entries {
			if !now.Before(old.expires) {
				delete(b.entries, k)
			}
		}
		if len(b.entries) >= maxCacheSize {
			for k := range b.entries {
				delete(b.entries, k)
				break
			}
		}
	}
	b.entries[key] = e
}

// Client calls the identity introspection endpoint with HTTP Basic client credentials.
// Active answers are cached for up to 30s, never past the token exp, and inactive
// answers for 5s, in separate caches. Concurrent lookups of one key share one call.
type Client struct {
	url          string
	clientID     string
	clientSecret string
	audience     string
	http         *http.Client
	now          func() time.Time
	cacheKey     []byte
	group        singleflight.Group

	mu       sync.Mutex
	positive boundedCache
	negative boundedCache
	logged   map[string]time.Time
}

// NewClient returns an introspection client for endpoint. An empty audience uses agent-sandbox.
func NewClient(endpoint, clientID, clientSecret, audience string) *Client {
	if audience == "" {
		audience = defaultAudience
	}
	key := make([]byte, 32)
	_, _ = rand.Read(key)
	return &Client{
		url:          endpoint,
		clientID:     clientID,
		clientSecret: clientSecret,
		audience:     audience,
		http:         &http.Client{Timeout: callTimeout},
		now:          time.Now,
		cacheKey:     key,
		positive:     boundedCache{entries: map[string]cacheEntry{}},
		negative:     boundedCache{entries: map[string]cacheEntry{}},
		logged:       map[string]time.Time{},
	}
}

// FromEnv reads IDENTITY_INTROSPECT_URL, IDENTITY_CLIENT_ID, IDENTITY_CLIENT_SECRET, and
// IDENTITY_AUDIENCE. It returns nil when the URL is unset.
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
	return NewClient(endpoint, id, secret, strings.TrimSpace(os.Getenv("IDENTITY_AUDIENCE"))), nil
}

// Introspect returns the token for an active key, ErrInactive, or ErrUnavailable.
func (c *Client) Introspect(ctx context.Context, key string) (Token, error) {
	if c == nil {
		return Token{}, ErrUnavailable
	}
	if key == "" {
		return Token{}, ErrInactive
	}
	mac := hmac.New(sha256.New, c.cacheKey)
	mac.Write([]byte(key))
	cacheKey := hex.EncodeToString(mac.Sum(nil))
	if tok, err, ok := c.cached(cacheKey); ok {
		return tok, err
	}
	v, err, _ := c.group.Do(cacheKey, func() (any, error) {
		tok, active, err := c.call(ctx, key)
		if err != nil {
			return Token{}, err
		}
		c.store(cacheKey, tok, active)
		if !active {
			return Token{}, ErrInactive
		}
		return tok, nil
	})
	if err != nil {
		return Token{}, err
	}
	return v.(Token), nil
}

// introspection is the RFC 7662 answer with the members this client reads.
type introspection struct {
	Active   *bool           `json:"active"`
	Sub      string          `json:"sub"`
	Email    string          `json:"email"`
	Roles    []string        `json:"roles"`
	Audience json.RawMessage `json:"aud"`
	ClientID string          `json:"client_id"`
	Exp      json.Number     `json:"exp"`
	Act      json.RawMessage `json:"act"`
}

// call performs one introspection request. The bool is false for a key that must be refused.
func (c *Client) call(ctx context.Context, key string) (Token, bool, error) {
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), callTimeout)
	defer cancel()
	form := url.Values{"token": {key}}
	req, err := http.NewRequestWithContext(rctx, http.MethodPost, c.url, strings.NewReader(form.Encode()))
	if err != nil {
		return Token{}, false, c.fail("request", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.SetBasicAuth(c.clientID, c.clientSecret)
	resp, err := c.http.Do(req)
	if err != nil {
		return Token{}, false, c.fail("request", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return Token{}, false, c.fail("read", err)
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return Token{}, false, c.fail("client_rejected", fmt.Errorf("status %d: check IDENTITY_CLIENT_ID and IDENTITY_CLIENT_SECRET", resp.StatusCode))
	}
	if resp.StatusCode != http.StatusOK {
		return Token{}, false, c.fail("status", fmt.Errorf("status %d", resp.StatusCode))
	}
	var out introspection
	if err := json.Unmarshal(body, &out); err != nil || out.Active == nil {
		return Token{}, false, c.fail("bad_response", errors.New("answer is not an introspection object"))
	}
	if !*out.Active {
		return Token{}, false, nil
	}
	if out.Sub == "" {
		c.refuse("no_sub")
		return Token{}, false, nil
	}
	if ok, reason := c.forUs(out); !ok {
		c.refuse(reason)
		return Token{}, false, nil
	}
	tok := Token{Subject: out.Sub, Email: out.Email, Roles: out.Roles}
	if out.Exp != "" {
		if f, err := out.Exp.Float64(); err == nil && f > 0 {
			tok.expires = time.Unix(int64(f), 0)
			if !c.now().Before(tok.expires) {
				return Token{}, false, nil
			}
		}
	}
	return tok, true, nil
}

// forUs accepts an API key answer, which names no audience, or one whose aud, or
// client_id when aud is absent, is this service. A delegated token is refused.
func (c *Client) forUs(out introspection) (bool, string) {
	if raw := strings.TrimSpace(string(out.Act)); raw != "" && raw != "null" {
		return false, "delegated"
	}
	var auds []string
	if raw := strings.TrimSpace(string(out.Audience)); raw != "" && raw != "null" {
		var one string
		if err := json.Unmarshal(out.Audience, &one); err == nil {
			auds = []string{one}
		} else if err := json.Unmarshal(out.Audience, &auds); err != nil {
			return false, "bad_audience"
		}
	}
	if len(nonEmpty(auds)) == 0 && out.ClientID != "" {
		auds = []string{out.ClientID}
	}
	auds = nonEmpty(auds)
	if len(auds) == 0 {
		return true, ""
	}
	for _, a := range auds {
		if a == c.audience {
			return true, ""
		}
	}
	return false, "other_audience"
}

func nonEmpty(in []string) []string {
	out := in[:0:0]
	for _, s := range in {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

// fail logs an identity failure at most once per reason every 30s and wraps ErrUnavailable.
func (c *Client) fail(reason string, err error) error {
	if c.firstLog(reason) {
		if reason == "client_rejected" {
			log.Error("identity introspection rejected this client", "url", c.url, "error", err)
		} else {
			log.Warn("identity introspection failed", "reason", reason, "url", c.url, "error", err)
		}
	}
	return fmt.Errorf("%w: %s: %v", ErrUnavailable, reason, err)
}

// refuse logs an active answer that is not accepted, at most once per reason every 30s.
func (c *Client) refuse(reason string) {
	if c.firstLog("refuse_" + reason) {
		log.Warn("identity key refused", "reason", reason, "audience", c.audience)
	}
}

func (c *Client) firstLog(reason string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if last, ok := c.logged[reason]; ok && now.Sub(last) < 30*time.Second {
		return false
	}
	c.logged[reason] = now
	return true
}

// cached returns a cached answer. The bool is false on a miss.
func (c *Client) cached(key string) (Token, error, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if e, ok := c.positive.get(key, now); ok {
		return e.token, nil, true
	}
	if _, ok := c.negative.get(key, now); ok {
		return Token{}, ErrInactive, true
	}
	return Token{}, nil, false
}

// store caches an answer. An active answer never outlives the token exp.
func (c *Client) store(key string, tok Token, active bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if !active {
		c.negative.put(key, cacheEntry{expires: now.Add(negativeTTL)}, now)
		return
	}
	expires := now.Add(positiveTTL)
	if !tok.expires.IsZero() && tok.expires.Before(expires) {
		expires = tok.expires
	}
	c.positive.put(key, cacheEntry{token: tok, expires: expires}, now)
}
