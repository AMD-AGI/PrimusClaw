// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type eventLog struct {
	mu     sync.Mutex
	events []string
}

func (l *eventLog) add(e string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.events = append(l.events, e)
}

func (l *eventLog) get() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.events...)
}

// The Router drains requests that call the Workload Manager and the store, so
// those must still be running until the Router has finished. Stopping them on
// the signal, as before, failed the very requests the drain waits for.
func TestRunUntilSignalStopsDependenciesOnlyAfterRouterDrained(t *testing.T) {
	sigCtx, signal := context.WithCancel(context.Background())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var log eventLog
	router := component{name: "router", run: func(rc context.Context) error {
		<-rc.Done()
		log.add("router signalled")
		time.Sleep(200 * time.Millisecond) // draining
		if ctx.Err() != nil {
			log.add("dependencies stopped while router was draining")
		}
		log.add("router drained")
		return nil
	}}
	wm := component{name: "wm", run: func(wc context.Context) error {
		<-wc.Done()
		log.add("wm stopped")
		return nil
	}}

	done := make(chan error, 1)
	go func() { done <- runUntilSignal(sigCtx, ctx, cancel, router, []component{wm}, time.Second) }()
	time.Sleep(20 * time.Millisecond)
	signal()

	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(3 * time.Second):
		t.Fatal("runUntilSignal did not return")
	}
	assert.Equal(t, []string{"router signalled", "router drained", "wm stopped"}, log.get())
}

func TestRunUntilSignalReturnsComponentFailure(t *testing.T) {
	sigCtx, signal := context.WithCancel(context.Background())
	defer signal()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	router := component{name: "router", run: func(rc context.Context) error { <-rc.Done(); return nil }}
	broken := component{name: "manager", run: func(context.Context) error { return errors.New("boom") }}

	err := runUntilSignal(sigCtx, ctx, cancel, router, []component{broken}, time.Second)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "manager: boom")
	assert.Error(t, ctx.Err(), "a failure stops the rest")
}
