// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	log "sigs.k8s.io/agent-sandbox/pkg/logx"
)

// component is one long-running part of the control plane.
type component struct {
	name string
	run  func(context.Context) error
}

// runUntilSignal runs the Router on sigCtx and every other component on ctx,
// and orders the shutdown the way Kubernetes expects a Pod to drain.
//
// The signal ends only the Router's context. The Router then fails readiness,
// keeps serving for its shutdown delay and drains in-flight requests; only when
// it has returned is ctx cancelled for the Workload Manager, the controller
// manager, the informers and the store. The Router proxies control-plane calls
// to the Workload Manager and resolves sessions through the store, so stopping
// those first would fail the very requests the drain is waiting for.
//
// stopGrace bounds the wait for the components after ctx is cancelled.
// A component failing before the signal is returned as an error.
func runUntilSignal(sigCtx, ctx context.Context, cancel context.CancelFunc,
	router component, others []component, stopGrace time.Duration,
) error {
	errCh := make(chan error, 1+len(others))
	start := func(c component, runCtx context.Context) <-chan struct{} {
		done := make(chan struct{})
		go func() {
			defer close(done)
			log.Info(c.name + " starting")
			if err := c.run(runCtx); err != nil && !errors.Is(err, http.ErrServerClosed) {
				errCh <- fmt.Errorf("%s: %w", c.name, err)
			}
		}()
		return done
	}

	routerDone := start(router, sigCtx)
	othersDone := make([]<-chan struct{}, 0, len(others))
	for _, c := range others {
		othersDone = append(othersDone, start(c, ctx))
	}

	select {
	case err := <-errCh:
		cancel()
		return err
	case <-sigCtx.Done():
	}

	log.Info("controlplane draining: router first, then the rest")
	select {
	case <-routerDone:
	case err := <-errCh:
		// The Router failed rather than drained; there is nothing left to wait for.
		log.Error("router failed while draining", "error", err)
	}
	cancel()

	deadline := time.After(stopGrace)
	for i, done := range othersDone {
		select {
		case <-done:
		case <-deadline:
			log.Warn("component did not stop in time", "component", others[i].name,
				"grace", stopGrace.String())
			return nil
		}
	}
	return nil
}
