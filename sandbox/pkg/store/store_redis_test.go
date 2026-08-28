// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// What a refresh does when the record is gone, exercised against a real server
// because that is precisely the part a fake would paper over: idle-gc reads the
// timestamp off the record, so a refresh reporting success without one is how an
// activity signal disappears. Skips when no Redis is reachable, matching
// pkg/audit.

package store

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

func requireRedisStore(t *testing.T) *RedisStore {
	t.Helper()
	addr := os.Getenv("REDIS_ADDR")
	if addr == "" {
		addr = "localhost:6379"
	}
	st, err := NewRedisStore(Config{Addr: addr, Password: os.Getenv("REDIS_PASSWORD"), DB: 15})
	if err != nil {
		t.Skipf("Redis unavailable at %s: %v", addr, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := st.Ping(ctx); err != nil {
		t.Skipf("Redis unavailable at %s: %v", addr, err)
	}
	t.Cleanup(func() {
		st.client.FlushDB(context.Background())
		st.Close()
	})
	return st
}

// A refresh with no record to land on used to return nil, so every caller
// believed it had kept the session alive while idle-gc saw no activity at all.
// That is the shape a Redis restart without AOF leaves behind.
func TestRedisRefreshingActivityWithoutARecordIsNotFound(t *testing.T) {
	st := requireRedisStore(t)

	err := st.UpdateSessionLastActivity(context.Background(), "sess-never-stored", time.Now())

	if !errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v, want it to wrap ErrNotFound", err)
	}
}

func TestRedisRefreshingActivityStoresOnTheRecord(t *testing.T) {
	st := requireRedisStore(t)
	ctx := context.Background()
	if err := st.StoreSandbox(ctx, &SandboxInfo{
		Kind:         SandboxKind,
		SessionID:    "sess-live",
		SandboxName:  "sbx-1",
		Namespace:    "sandboxes",
		LastActivity: time.Now().Add(-time.Hour),
		ExpiresAt:    time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	at := time.Now().Truncate(time.Second)
	if err := st.UpdateSessionLastActivity(ctx, "sess-live", at); err != nil {
		t.Fatalf("update: %v", err)
	}

	info, err := st.GetSandboxBySessionID(ctx, "sess-live")
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !info.LastActivity.Equal(at) {
		t.Errorf("LastActivity = %s, want %s", info.LastActivity, at)
	}
}
