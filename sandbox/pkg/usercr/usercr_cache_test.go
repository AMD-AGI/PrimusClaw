// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package usercr

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"sigs.k8s.io/agent-sandbox/pkg/authz"
)

// countingReader counts Read calls, records the context of the last call, and returns the configured user or error.
type countingReader struct {
	mu          sync.Mutex
	calls       atomic.Int32
	user        User
	err         error
	gate        chan struct{}
	ctxErr      error
	deadline    time.Time
	hasDeadline bool
}

func (r *countingReader) Read(ctx context.Context, userID string) (User, error) {
	r.calls.Add(1)
	if r.gate != nil {
		<-r.gate
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.ctxErr = ctx.Err()
	r.deadline, r.hasDeadline = ctx.Deadline()
	return r.user, r.err
}

func TestUserReadCache(t *testing.T) {
	now := time.Unix(0, 0)
	r := &countingReader{user: User{Found: true, Workspaces: []string{"ws"}}}
	a := NewFromReader(r, WithClock(func() time.Time { return now }))
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

func TestUserReadUnavailableIsNotCached(t *testing.T) {
	now := time.Unix(0, 0)
	r := &countingReader{err: fmt.Errorf("%w: apiserver down", authz.ErrUnavailable)}
	a := NewFromReader(r, WithClock(func() time.Time { return now }))
	ctx := context.Background()
	if _, err := a.read(ctx, "u"); !errors.Is(err, authz.ErrUnavailable) {
		t.Fatalf("first read err = %v", err)
	}
	r.mu.Lock()
	r.err, r.user = nil, User{Found: true, Admin: true}
	r.mu.Unlock()
	u, err := a.read(ctx, "u")
	if err != nil || !u.Admin {
		t.Fatalf("read after the outage: %+v %v", u, err)
	}
	if r.calls.Load() != 2 {
		t.Fatalf("an unavailable read was reused: %d calls", r.calls.Load())
	}
}

func TestUserReadIgnoresCallerCancel(t *testing.T) {
	r := &countingReader{user: User{Found: true}}
	a := NewFromReader(r)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	if _, err := a.read(ctx, "u"); err != nil {
		t.Fatal(err)
	}
	if r.ctxErr != nil {
		t.Fatalf("the shared read saw the caller's cancel: %v", r.ctxErr)
	}
	if !r.hasDeadline || r.deadline.Before(start.Add(userReadTimeout-time.Second)) || r.deadline.After(time.Now().Add(userReadTimeout)) {
		t.Fatalf("shared read deadline = %v (set %v), want about %v", r.deadline, r.hasDeadline, userReadTimeout)
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
