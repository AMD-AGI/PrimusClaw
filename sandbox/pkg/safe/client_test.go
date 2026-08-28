// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package safe

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestIsAPIKey(t *testing.T) {
	tests := []struct {
		token    string
		expected bool
	}{
		{"ak-abc123", true},
		{"ak-dGVzdC1rZXktMTIz", true},
		{"ak-", true}, // valid prefix but empty key
		{"bearer-token", false},
		{"", false},
		{"sk-abc123", false},
	}
	for _, tt := range tests {
		assert.Equal(t, tt.expected, IsAPIKey(tt.token), "token: %q", tt.token)
	}
}

func TestVerifyAPIKey_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/api/v1/users/self", r.URL.Path)
		assert.Equal(t, "Bearer ak-test123", r.Header.Get("Authorization"))

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(userSelfResponse{
			ID:   "user-001",
			Name: "Li, Shuoshuo",
		})
	}))
	defer server.Close()

	client := NewClient(server.URL)
	user, err := client.VerifyAPIKey(context.Background(), "ak-test123")

	require.NoError(t, err)
	assert.Equal(t, "user-001", user.UserID)
	assert.Equal(t, "Li, Shuoshuo", user.UserName)
}

func TestVerifyAPIKey_InvalidFormat(t *testing.T) {
	client := NewClient("http://unused")
	_, err := client.VerifyAPIKey(context.Background(), "not-an-api-key")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "invalid API key format")
}

func TestVerifyAPIKey_Unauthorized(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"error":"invalid key"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL)
	_, err := client.VerifyAPIKey(context.Background(), "ak-bad-key")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "invalid or expired credential")
}

func TestVerifyAPIKey_Forbidden(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte(`{"error":"IP not in whitelist"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL)
	_, err := client.VerifyAPIKey(context.Background(), "ak-blocked")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "forbidden")
}

func TestVerifyAPIKey_CacheHit(t *testing.T) {
	var callCount atomic.Int32

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount.Add(1)
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(userSelfResponse{
			ID:   "user-cached",
			Name: "cached-key",
		})
	}))
	defer server.Close()

	client := NewClient(server.URL)

	// First call — hits SaFE
	user1, err := client.VerifyAPIKey(context.Background(), "ak-cache-test")
	require.NoError(t, err)
	assert.Equal(t, "user-cached", user1.UserID)
	assert.Equal(t, int32(1), callCount.Load())

	// Second call — should use cache, NOT call SaFE again
	user2, err := client.VerifyAPIKey(context.Background(), "ak-cache-test")
	require.NoError(t, err)
	assert.Equal(t, "user-cached", user2.UserID)
	assert.Equal(t, int32(1), callCount.Load(), "should NOT call SaFE again (cache hit)")
}

func TestVerifyAPIKey_CacheExpiration(t *testing.T) {
	var callCount atomic.Int32

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount.Add(1)
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(userSelfResponse{
			ID:   "user-expiry",
			Name: "expiry-test",
		})
	}))
	defer server.Close()

	client := NewClient(server.URL)
	// Override cache TTL to a very short duration for testing
	client.cacheTTL = 50 * time.Millisecond

	// First call
	_, err := client.VerifyAPIKey(context.Background(), "ak-expiry-test")
	require.NoError(t, err)
	assert.Equal(t, int32(1), callCount.Load())

	// Wait for cache to expire
	time.Sleep(100 * time.Millisecond)

	// Second call — cache expired, should call SaFE again
	_, err = client.VerifyAPIKey(context.Background(), "ak-expiry-test")
	require.NoError(t, err)
	assert.Equal(t, int32(2), callCount.Load(), "should call SaFE again after cache expiry")
}

func TestVerifyAPIKey_CacheLRUEviction(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(userSelfResponse{
			ID:   "user-" + key,
			Name: "lru-test",
		})
	}))
	defer server.Close()

	client := NewClient(server.URL)
	client.maxCache = 3 // small cache for testing

	// Fill cache to capacity
	for i := 0; i < 3; i++ {
		_, err := client.VerifyAPIKey(context.Background(), "ak-lru-"+string(rune('a'+i)))
		require.NoError(t, err)
	}
	size, maxSize := client.CacheStats()
	assert.Equal(t, 3, size)
	assert.Equal(t, 3, maxSize)

	// Add one more — should evict the oldest
	_, err := client.VerifyAPIKey(context.Background(), "ak-lru-d")
	require.NoError(t, err)
	size, _ = client.CacheStats()
	assert.Equal(t, 3, size, "cache should not exceed maxSize")
}

func TestVerifyAPIKey_EmptyUserID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(userSelfResponse{
			// ID intentionally empty → should return error
			Name: "no-user",
		})
	}))
	defer server.Close()

	client := NewClient(server.URL)
	_, err := client.VerifyAPIKey(context.Background(), "ak-no-user")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "empty user ID")
}
