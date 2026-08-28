// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	globalEventsKey  = "audit:events"
	sessionKeyPrefix = "audit:session:"
)

// RedisAuditStore implements AuditStore using Redis Sorted Sets.
// Global timeline: audit:events (score=unix_ms, member=event_json).
// Per-session:     audit:session:{id} (score=unix_ms, member=event_json, auto-TTL).
type RedisAuditStore struct {
	client        *redis.Client
	retentionDays int
}

// NewRedisStore creates an audit store backed by Redis.
// Reuses the provided client to avoid duplicate connections.
func NewRedisStore(client *redis.Client, retentionDays int) *RedisAuditStore {
	if retentionDays <= 0 {
		retentionDays = 30
	}
	return &RedisAuditStore{client: client, retentionDays: retentionDays}
}

func (s *RedisAuditStore) Store(ctx context.Context, event *AuditEvent) error {
	NormalizeEvent(event)
	data, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal audit event: %w", err)
	}

	score := float64(event.Timestamp.UnixMilli())
	sessionKey := sessionKeyPrefix + event.SessionID
	ttl := time.Duration(s.retentionDays) * 24 * time.Hour

	pipe := s.client.Pipeline()
	pipe.ZAdd(ctx, globalEventsKey, redis.Z{Score: score, Member: string(data)})
	pipe.ZAdd(ctx, sessionKey, redis.Z{Score: score, Member: string(data)})
	pipe.Expire(ctx, sessionKey, ttl)
	_, err = pipe.Exec(ctx)
	return err
}

func (s *RedisAuditStore) QueryBySession(ctx context.Context, sessionID string) ([]*AuditEvent, error) {
	members, err := s.client.ZRangeByScore(ctx, sessionKeyPrefix+sessionID, &redis.ZRangeBy{
		Min: "-inf", Max: "+inf",
	}).Result()
	if err != nil {
		return nil, fmt.Errorf("redis ZRANGEBYSCORE: %w", err)
	}
	return unmarshalEvents(members), nil
}

func (s *RedisAuditStore) QueryByTimeRange(ctx context.Context, start, end time.Time, opts QueryOptions) (*QueryResult, error) {
	members, err := s.client.ZRangeByScore(ctx, globalEventsKey, &redis.ZRangeBy{
		Min: fmt.Sprintf("%d", start.UnixMilli()),
		Max: fmt.Sprintf("%d", end.UnixMilli()),
	}).Result()
	if err != nil {
		return nil, fmt.Errorf("redis ZRANGEBYSCORE: %w", err)
	}

	all := unmarshalEvents(members)

	// Apply filters
	filtered := make([]*AuditEvent, 0, len(all))
	for _, e := range all {
		if opts.UserID != "" && e.UserID != opts.UserID {
			continue
		}
		if opts.EventType != "" && e.EventType != opts.EventType {
			continue
		}
		if opts.Source != "" && e.Source != opts.Source {
			continue
		}
		filtered = append(filtered, e)
	}

	// Paginate
	total := int64(len(filtered))
	limit := opts.Limit
	if limit <= 0 {
		limit = 100
	}
	offset := opts.Offset
	if offset < 0 {
		offset = 0
	}
	if offset > total {
		offset = total
	}
	endIdx := offset + limit
	if endIdx > total {
		endIdx = total
	}

	return &QueryResult{
		Total:  total,
		Events: filtered[offset:endIdx],
	}, nil
}

func (s *RedisAuditStore) DeleteBefore(ctx context.Context, before time.Time) (int64, error) {
	max := fmt.Sprintf("%d", before.UnixMilli())
	deleted, err := s.client.ZRemRangeByScore(ctx, globalEventsKey, "-inf", max).Result()
	if err != nil {
		return 0, fmt.Errorf("redis ZREMRANGEBYSCORE: %w", err)
	}
	return deleted, nil
}

// RetentionDays returns the configured retention period.
func (s *RedisAuditStore) RetentionDays() int {
	return s.retentionDays
}

func unmarshalEvents(members []string) []*AuditEvent {
	events := make([]*AuditEvent, 0, len(members))
	for _, m := range members {
		var e AuditEvent
		if err := json.Unmarshal([]byte(m), &e); err != nil {
			continue
		}
		events = append(events, &e)
	}
	return events
}
