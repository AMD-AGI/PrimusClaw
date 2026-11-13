// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package usercr

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// countingReader counts Read calls and returns the configured user.
type countingReader struct {
	mu    sync.Mutex
	calls atomic.Int32
	user  User
	gate  chan struct{}
}

func (r *countingReader) Read(ctx context.Context, userID string) (User, error) {
	r.calls.Add(1)
	if r.gate != nil {
		select {
		case <-r.gate:
		case <-ctx.Done():
			return User{}, ctx.Err()
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.user, nil
}

func TestUserReadCache(t *testing.T) {
	now := time.Unix(0, 0)
	r := &countingReader{user: User{Found: true, Workspaces: []string{"ws"}}}
	a := NewFromReader(r)
	a.now = func() time.Time { return now }
	ctx := context.Background()
	if _, err := a.read(ctx, "u"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.read(ctx, "u"); err != nil {
		t.Fatal(err)
	}
	if r.calls.Load() != 1 {
		t.Fatalf("found user was read %d times", r.calls.Load())
	}
	now = now.Add(userAllowTTL + time.Second)
	if _, err := a.read(ctx, "u"); err != nil {
		t.Fatal(err)
	}
	if r.calls.Load() != 2 {
		t.Fatalf("found user after ttl was read %d times", r.calls.Load())
	}

	r.user = User{}
	now = now.Add(userAllowTTL + time.Second)
	if _, err := a.read(ctx, "missing"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.read(ctx, "missing"); err != nil {
		t.Fatal(err)
	}
	if r.calls.Load() != 3 {
		t.Fatalf("missing user was read %d times", r.calls.Load())
	}
	now = now.Add(userDenyTTL + time.Second)
	if _, err := a.read(ctx, "missing"); err != nil {
		t.Fatal(err)
	}
	if r.calls.Load() != 4 {
		t.Fatalf("missing user after ttl was read %d times", r.calls.Load())
	}
}

func TestUserReadSharesOneCall(t *testing.T) {
	r := &countingReader{user: User{Found: true}, gate: make(chan struct{})}
	a := NewFromReader(r)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = a.read(context.Background(), "u")
		}()
	}
	for r.calls.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	close(r.gate)
	wg.Wait()
	if r.calls.Load() != 1 {
		t.Fatalf("concurrent reads called Read %d times", r.calls.Load())
	}
}
