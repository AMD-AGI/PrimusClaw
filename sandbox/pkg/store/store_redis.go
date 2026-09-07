// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Phase 5: Redis-backed Store implementation.
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	log "sigs.k8s.io/agent-sandbox/pkg/logx"
)

const (
	// Key prefixes
	sessionPrefix = "session:"     // HASH: SandboxInfo JSON
	expiryZSet    = "idx:expiry"   // ZSET: sessionID → expiresAt unix
	activityZSet  = "idx:activity" // ZSET: sessionID → lastActivity unix

	// redisSessionGrace is the grace period added to the Redis session TTL
	// beyond the sandbox ExpiresAt. It ensures the session key outlives the
	// sandbox itself, so idle-gc can still read the Redis-backed LastActivity
	// during the shutdown window without falling back to CreationTimestamp.
	redisSessionGrace = 1 * time.Hour
)

// RedisStore implements Store using Redis.
type RedisStore struct {
	client *redis.Client
}

// NewRedisStore creates a RedisStore from the given Config.
// Configures automatic retry (3 attempts with backoff) to handle transient
// connection errors during Redis restarts.
func NewRedisStore(cfg Config) (*RedisStore, error) {
	client := redis.NewClient(&redis.Options{
		Addr:            cfg.Addr,
		Password:        cfg.Password,
		DB:              cfg.DB,
		MaxRetries:      3, // Retry transient failures (default is 3, be explicit)
		MinRetryBackoff: 100 * time.Millisecond,
		MaxRetryBackoff: 500 * time.Millisecond,
		DialTimeout:     5 * time.Second,
		ReadTimeout:     3 * time.Second,
		WriteTimeout:    3 * time.Second,
		PoolSize:        20,
		MinIdleConns:    5, // Keep idle connections for fast reconnect
	})
	// Build-time reachability check: keep this short so the outer retry loop
	// (see singleton.NewFromEnv) gets quick feedback. Runtime ops use the
	// per-call DialTimeout / ReadTimeout / WriteTimeout configured above.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("redis ping failed: %w", err)
	}
	return &RedisStore{client: client}, nil
}

// Client returns the underlying Redis client for reuse by other subsystems (e.g. audit store).
func (r *RedisStore) Client() *redis.Client {
	return r.client
}

func (r *RedisStore) Ping(ctx context.Context) error {
	return r.client.Ping(ctx).Err()
}

func (r *RedisStore) GetSandboxBySessionID(ctx context.Context, sessionID string) (*SandboxInfo, error) {
	data, err := r.client.Get(ctx, sessionPrefix+sessionID).Bytes()
	if err == redis.Nil {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("redis GET: %w", err)
	}
	var info SandboxInfo
	if err := json.Unmarshal(data, &info); err != nil {
		return nil, fmt.Errorf("unmarshal session: %w", err)
	}
	return &info, nil
}

func (r *RedisStore) StoreSandbox(ctx context.Context, info *SandboxInfo) error {
	data, err := json.Marshal(info)
	if err != nil {
		return fmt.Errorf("marshal session: %w", err)
	}

	pipe := r.client.Pipeline()
	// Store session JSON with TTL = (expiresAt - now) + redisSessionGrace.
	// The grace period keeps the Redis key alive after ExpiresAt so agentd's
	// idle-gc can still read LastActivity from here rather than fall back to
	// CreationTimestamp.
	ttl := time.Until(info.ExpiresAt) + redisSessionGrace
	if ttl <= 0 {
		ttl = 24 * time.Hour
	}
	pipe.Set(ctx, sessionPrefix+info.SessionID, data, ttl)
	// Update sorted set indexes
	pipe.ZAdd(ctx, expiryZSet, redis.Z{Score: float64(info.ExpiresAt.Unix()), Member: info.SessionID})
	pipe.ZAdd(ctx, activityZSet, redis.Z{Score: float64(info.LastActivity.Unix()), Member: info.SessionID})

	_, err = pipe.Exec(ctx)
	return err
}

func (r *RedisStore) UpdateSandbox(ctx context.Context, info *SandboxInfo) error {
	return r.StoreSandbox(ctx, info)
}

func (r *RedisStore) DeleteSandboxBySessionID(ctx context.Context, sessionID string) error {
	pipe := r.client.Pipeline()
	pipe.Del(ctx, sessionPrefix+sessionID)
	pipe.ZRem(ctx, expiryZSet, sessionID)
	pipe.ZRem(ctx, activityZSet, sessionID)
	_, err := pipe.Exec(ctx)
	return err
}

func (r *RedisStore) ListExpiredSandboxes(ctx context.Context, before time.Time, limit int64) ([]*SandboxInfo, error) {
	// Sessions whose expiresAt < before
	members, err := r.client.ZRangeByScore(ctx, expiryZSet, &redis.ZRangeBy{
		Min:    "-inf",
		Max:    fmt.Sprintf("%d", before.Unix()),
		Offset: 0,
		Count:  limit,
	}).Result()
	if err != nil {
		return nil, err
	}
	return r.fetchInfos(ctx, members)
}

func (r *RedisStore) ListInactiveSandboxes(ctx context.Context, before time.Time, limit int64) ([]*SandboxInfo, error) {
	// Sessions whose lastActivity < before
	members, err := r.client.ZRangeByScore(ctx, activityZSet, &redis.ZRangeBy{
		Min:    "-inf",
		Max:    fmt.Sprintf("%d", before.Unix()),
		Offset: 0,
		Count:  limit,
	}).Result()
	if err != nil {
		return nil, err
	}
	return r.fetchInfos(ctx, members)
}

func (r *RedisStore) UpdateSessionLastActivity(ctx context.Context, sessionID string, at time.Time) error {
	// Update activity index
	if err := r.client.ZAdd(ctx, activityZSet, redis.Z{
		Score:  float64(at.Unix()),
		Member: sessionID,
	}).Err(); err != nil {
		return err
	}
	// Also update the stored JSON. The ZSet write above is not enough on its
	// own: idle-gc reads LastActivity off this record, so if it is missing the
	// refresh had nowhere to land. Reporting that as success -- which this did,
	// with `return nil` -- is how a Redis restart silently strips every
	// sandbox's activity signal while every caller believes it is refreshing
	// them.
	info, err := r.GetSandboxBySessionID(ctx, sessionID)
	if err != nil {
		return err
	}
	info.LastActivity = at
	return r.StoreSandbox(ctx, info)
}

func (r *RedisStore) ListAllSandboxes(ctx context.Context, limit int64) ([]*SandboxInfo, error) {
	members, err := r.client.ZRevRange(ctx, activityZSet, 0, limit-1).Result()
	if err != nil {
		return nil, fmt.Errorf("redis ZREVRANGE: %w", err)
	}
	return r.fetchInfos(ctx, members)
}

func (r *RedisStore) Close() error {
	return r.client.Close()
}

// fetchInfos loads SandboxInfo for a list of session IDs.
func (r *RedisStore) fetchInfos(ctx context.Context, sessionIDs []string) ([]*SandboxInfo, error) {
	if len(sessionIDs) == 0 {
		return nil, nil
	}
	result := make([]*SandboxInfo, 0, len(sessionIDs))
	skipped := 0
	for _, id := range sessionIDs {
		info, err := r.GetSandboxBySessionID(ctx, id)
		if err != nil {
			skipped++
			if skipped <= 3 {
				log.Warn("store: session expired or invalid", "id", id, "error", err)
			}
			continue
		}
		result = append(result, info)
	}
	return result, nil
}
