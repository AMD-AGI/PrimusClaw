// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package builder

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

const cacheKeyPrefix = "builder:image:"

// RedisCache implements ImageCache backed by Redis.
type RedisCache struct {
	client redis.Cmdable
}

// NewRedisCache creates a Redis-backed image cache.
func NewRedisCache(client redis.Cmdable) *RedisCache {
	return &RedisCache{client: client}
}

// Get returns the cached image for the given content hash.
func (c *RedisCache) Get(ctx context.Context, hash string) (string, bool) {
	val, err := c.client.Get(ctx, cacheKeyPrefix+hash).Result()
	if err != nil {
		return "", false
	}
	return val, true
}

// Set stores an image address for the given content hash with TTL.
func (c *RedisCache) Set(ctx context.Context, hash, image string, ttl time.Duration) error {
	return c.client.Set(ctx, cacheKeyPrefix+hash, image, ttl).Err()
}

// Delete removes a cached entry.
func (c *RedisCache) Delete(ctx context.Context, hash string) error {
	return c.client.Del(ctx, cacheKeyPrefix+hash).Err()
}
