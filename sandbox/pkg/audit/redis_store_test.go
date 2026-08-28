// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package audit

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// requireRedis returns a Redis client or skips the test if unavailable.
func requireRedis(t *testing.T) *redis.Client {
	t.Helper()
	addr := os.Getenv("REDIS_ADDR")
	if addr == "" {
		addr = "localhost:6379"
	}
	client := redis.NewClient(&redis.Options{Addr: addr, DB: 15})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		t.Skipf("Redis unavailable at %s: %v", addr, err)
	}
	t.Cleanup(func() {
		client.FlushDB(context.Background())
		client.Close()
	})
	return client
}

func TestRedisAuditStore_StoreAndQueryBySession(t *testing.T) {
	client := requireRedis(t)
	store := NewRedisStore(client, 30)
	ctx := context.Background()

	e1 := &AuditEvent{
		ID: NewEventID(), EventType: EventCreated,
		SessionID: "sess_abc", SandboxName: "test-sbx", Namespace: "default",
		UserID: "alice", UserName: "Alice",
		Timestamp: time.Now().Add(-2 * time.Second), TemplateName: "python",
	}
	e2 := &AuditEvent{
		ID: NewEventID(), EventType: EventReady,
		SessionID: "sess_abc", SandboxName: "test-sbx", Namespace: "default",
		Timestamp: time.Now().Add(-1 * time.Second), TimeToReadyMs: 3000,
	}
	e3 := &AuditEvent{
		ID: NewEventID(), EventType: EventCreated,
		SessionID: "sess_other", SandboxName: "other-sbx", Namespace: "default",
		Timestamp: time.Now(),
	}

	require.NoError(t, store.Store(ctx, e1))
	require.NoError(t, store.Store(ctx, e2))
	require.NoError(t, store.Store(ctx, e3))

	// Query by session
	events, err := store.QueryBySession(ctx, "sess_abc")
	require.NoError(t, err)
	assert.Len(t, events, 2)
	assert.Equal(t, EventCreated, events[0].EventType)
	assert.Equal(t, EventReady, events[1].EventType)
	assert.Equal(t, "alice", events[0].UserID)
	assert.Equal(t, int64(3000), events[1].TimeToReadyMs)

	// Different session
	events2, err := store.QueryBySession(ctx, "sess_other")
	require.NoError(t, err)
	assert.Len(t, events2, 1)

	// Non-existent session
	events3, err := store.QueryBySession(ctx, "sess_nonexist")
	require.NoError(t, err)
	assert.Empty(t, events3)
}

func TestRedisAuditStore_QueryByTimeRange(t *testing.T) {
	client := requireRedis(t)
	store := NewRedisStore(client, 30)
	ctx := context.Background()

	now := time.Now()
	events := []*AuditEvent{
		{ID: NewEventID(), EventType: EventCreated, SessionID: "s1", SandboxName: "sbx1",
			Namespace: "default", UserID: "alice", Timestamp: now.Add(-3 * time.Hour)},
		{ID: NewEventID(), EventType: EventDeleted, SessionID: "s1", SandboxName: "sbx1",
			Namespace: "default", UserID: "alice", Timestamp: now.Add(-2 * time.Hour), DeleteReason: ReasonGCIdle},
		{ID: NewEventID(), EventType: EventCreated, SessionID: "s2", SandboxName: "sbx2",
			Namespace: "default", UserID: "bob", Timestamp: now.Add(-1 * time.Hour)},
	}
	for _, e := range events {
		require.NoError(t, store.Store(ctx, e))
	}

	// All events in range
	result, err := store.QueryByTimeRange(ctx, now.Add(-4*time.Hour), now, QueryOptions{})
	require.NoError(t, err)
	assert.Equal(t, int64(3), result.Total)
	assert.Len(t, result.Events, 3)

	// Filter by user
	result, err = store.QueryByTimeRange(ctx, now.Add(-4*time.Hour), now, QueryOptions{UserID: "alice"})
	require.NoError(t, err)
	assert.Equal(t, int64(2), result.Total)

	// Filter by event type
	result, err = store.QueryByTimeRange(ctx, now.Add(-4*time.Hour), now, QueryOptions{EventType: EventDeleted})
	require.NoError(t, err)
	assert.Equal(t, int64(1), result.Total)
	assert.Equal(t, ReasonGCIdle, result.Events[0].DeleteReason)

	// Pagination
	result, err = store.QueryByTimeRange(ctx, now.Add(-4*time.Hour), now, QueryOptions{Limit: 2})
	require.NoError(t, err)
	assert.Equal(t, int64(3), result.Total)
	assert.Len(t, result.Events, 2)

	result, err = store.QueryByTimeRange(ctx, now.Add(-4*time.Hour), now, QueryOptions{Limit: 2, Offset: 2})
	require.NoError(t, err)
	assert.Len(t, result.Events, 1)

	// Empty time range
	result, err = store.QueryByTimeRange(ctx, now.Add(1*time.Hour), now.Add(2*time.Hour), QueryOptions{})
	require.NoError(t, err)
	assert.Equal(t, int64(0), result.Total)
}

func TestRedisAuditStore_DeleteBefore(t *testing.T) {
	client := requireRedis(t)
	store := NewRedisStore(client, 30)
	ctx := context.Background()

	now := time.Now()
	old := &AuditEvent{
		ID: NewEventID(), EventType: EventCreated, SessionID: "old",
		SandboxName: "old-sbx", Namespace: "default", Timestamp: now.Add(-48 * time.Hour),
	}
	recent := &AuditEvent{
		ID: NewEventID(), EventType: EventCreated, SessionID: "new",
		SandboxName: "new-sbx", Namespace: "default", Timestamp: now.Add(-1 * time.Hour),
	}
	require.NoError(t, store.Store(ctx, old))
	require.NoError(t, store.Store(ctx, recent))

	// Delete events older than 24h
	deleted, err := store.DeleteBefore(ctx, now.Add(-24*time.Hour))
	require.NoError(t, err)
	assert.Equal(t, int64(1), deleted)

	// Verify only recent event remains in global set
	result, err := store.QueryByTimeRange(ctx, now.Add(-72*time.Hour), now, QueryOptions{})
	require.NoError(t, err)
	assert.Equal(t, int64(1), result.Total)
	assert.Equal(t, "new", result.Events[0].SessionID)
}

func TestNewEventID(t *testing.T) {
	id1 := NewEventID()
	id2 := NewEventID()
	assert.Len(t, id1, 32)
	assert.NotEqual(t, id1, id2)
}
