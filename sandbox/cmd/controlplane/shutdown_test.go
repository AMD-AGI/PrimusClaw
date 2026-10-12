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

// A component failing after the signal (the controller manager losing its
// lease, say) must not end the drain: the Router's in-flight requests still
// complete, and the process does not report the Router as failed.
func TestRunUntilSignalOtherFailureDoesNotCutTheDrain(t *testing.T) {
	sigCtx, signal := context.WithCancel(context.Background())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	failed := make(chan struct{})
	finishDrain := make(chan struct{})
	var log eventLog
	router := component{name: "router", run: func(rc context.Context) error {
		<-rc.Done()
		select {
		case <-failed:
		case <-time.After(3 * time.Second):
			log.add("manager not stopped by the signal")
		}
		<-finishDrain
		if ctx.Err() != nil {
			log.add("dependencies stopped while router was draining")
		}
		log.add("router drained")
		return nil
	}}
	manager := component{name: "controller manager", stopOnSignal: true, run: func(mc context.Context) error {
		<-mc.Done()
		defer close(failed)
		return errors.New("leader election lost")
	}}

	done := make(chan error, 1)
	go func() { done <- runUntilSignal(sigCtx, ctx, cancel, router, []component{manager}, time.Second) }()
	signal()
	select {
	case <-failed:
	case <-time.After(3 * time.Second):
		close(finishDrain)
		t.Fatal("the stopOnSignal component was not stopped by the signal")
	}
	select {
	case err := <-done:
		t.Fatalf("runUntilSignal returned before the router drained: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(finishDrain)

	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(3 * time.Second):
		t.Fatal("runUntilSignal did not return")
	}
	assert.Equal(t, []string{"router drained"}, log.get())
}

// The controller manager holds the leader lease, so it stops on the signal
// rather than after the drain; the Workload Manager keeps serving the drain.
func TestRunUntilSignalStopsStopOnSignalComponentsAtOnce(t *testing.T) {
	sigCtx, signal := context.WithCancel(context.Background())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	managerStopped := make(chan struct{})
	var log eventLog
	router := component{name: "router", run: func(rc context.Context) error {
		<-rc.Done()
		select {
		case <-managerStopped:
			log.add("manager stopped during the drain")
		case <-time.After(3 * time.Second):
			log.add("manager still running at the end of the drain")
		}
		if ctx.Err() != nil {
			log.add("wm stopped during the drain")
		}
		return nil
	}}
	manager := component{name: "controller manager", stopOnSignal: true, run: func(mc context.Context) error {
		<-mc.Done()
		close(managerStopped)
		return nil
	}}
	wm := component{name: "wm", run: func(wc context.Context) error { <-wc.Done(); return nil }}

	done := make(chan error, 1)
	go func() {
		done <- runUntilSignal(sigCtx, ctx, cancel, router, []component{wm, manager}, time.Second)
	}()
	signal()
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("runUntilSignal did not return")
	}
	assert.Equal(t, []string{"manager stopped during the drain"}, log.get())
}

// A Router that had to cut connections, or failed while draining, is an error:
// the process must exit non-zero and name the Router.
func TestRunUntilSignalReturnsRouterDrainFailure(t *testing.T) {
	sigCtx, signal := context.WithCancel(context.Background())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	router := component{name: "router", run: func(rc context.Context) error {
		<-rc.Done()
		return errors.New("drain incomplete")
	}}
	wm := component{name: "wm", run: func(wc context.Context) error { <-wc.Done(); return nil }}

	done := make(chan error, 1)
	go func() { done <- runUntilSignal(sigCtx, ctx, cancel, router, []component{wm}, time.Second) }()
	signal()
	select {
	case err := <-done:
		require.Error(t, err)
		assert.Contains(t, err.Error(), "router: drain incomplete")
	case <-time.After(3 * time.Second):
		t.Fatal("runUntilSignal did not return")
	}
	assert.Error(t, ctx.Err(), "the rest is still stopped")
}

// A Router that stops on its own before any signal is a failure, not a wait.
func TestRunUntilSignalReturnsRouterStoppingBeforeSignal(t *testing.T) {
	sigCtx, signal := context.WithCancel(context.Background())
	defer signal()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	router := component{name: "router", run: func(context.Context) error { return nil }}
	wm := component{name: "wm", run: func(wc context.Context) error { <-wc.Done(); return nil }}

	done := make(chan error, 1)
	go func() { done <- runUntilSignal(sigCtx, ctx, cancel, router, []component{wm}, time.Second) }()
	select {
	case err := <-done:
		require.Error(t, err)
		assert.Contains(t, err.Error(), "router")
	case <-time.After(3 * time.Second):
		t.Fatal("runUntilSignal waited on a router that had already stopped")
	}
}

// The replacement Pod can only reconcile Sandboxes once this one gives up the
// lease, so the manager must stop on the signal and release the lease on stop.
func TestControllerManagerStepsDownOnSignal(t *testing.T) {
	assert.True(t, managerOptions(":0", ":0", true).LeaderElectionReleaseOnCancel)
	assert.True(t, managerComponent(nil).stopOnSignal)
}
