// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	ctrl "sigs.k8s.io/controller-runtime"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	log "sigs.k8s.io/agent-sandbox/pkg/logx"
)

// defaultStopGrace is the --shutdown-stop-grace default; the Helm chart passes
// controlplane.shutdown.stopGraceSeconds and sizes terminationGracePeriodSeconds
// from the same value.
const defaultStopGrace = 15 * time.Second

// component is one long-running part of the control plane.
type component struct {
	name string
	run  func(context.Context) error
	// stopOnSignal stops the component as soon as the signal arrives instead of
	// after the Router has drained. The controller manager is one: it holds the
	// leader lease, and the replacement Pod cannot reconcile Sandboxes until the
	// lease is released, so holding it for the whole drain stalls creations.
	stopOnSignal bool
}

// runUntilSignal runs the Router on sigCtx and every other component on ctx,
// and orders the shutdown the way Kubernetes expects a Pod to drain.
//
// The signal ends the Router's context and that of every stopOnSignal
// component. The Router then fails readiness, keeps serving for its shutdown
// delay and drains in-flight requests; only when it has returned is ctx
// cancelled for the Workload Manager, the informers and the store. The Router
// proxies control-plane calls to the Workload Manager and resolves sessions
// through the store, so stopping those first would fail the very requests the
// drain is waiting for.
//
// Before the signal any component ending is fatal and returned. After it, only
// the Router decides when the drain ends: another component failing (the
// controller manager losing its lease, say) is logged and does not cut the
// in-flight requests. A Router that fails or has to force-close connections
// while draining is returned as an error, so the process exits non-zero.
//
// stopGrace bounds the wait for the components after ctx is cancelled.
func runUntilSignal(sigCtx, ctx context.Context, cancel context.CancelFunc,
	router component, others []component, stopGrace time.Duration,
) error {
	routerRes := make(chan error, 1)
	othersErr := make(chan error, len(others))
	start := func(c component, runCtx context.Context, report func(error)) <-chan struct{} {
		done := make(chan struct{})
		go func() {
			defer close(done)
			log.Info(c.name + " starting")
			err := c.run(runCtx)
			if errors.Is(err, http.ErrServerClosed) {
				err = nil
			}
			report(err)
		}()
		return done
	}

	routerDone := start(router, sigCtx, func(err error) {
		if err != nil {
			err = fmt.Errorf("%s: %w", router.name, err)
		}
		routerRes <- err
	})
	othersDone := make([]<-chan struct{}, 0, len(others))
	for _, c := range others {
		runCtx := ctx
		if c.stopOnSignal {
			var stop context.CancelFunc
			runCtx, stop = context.WithCancel(ctx)
			defer stop()
			context.AfterFunc(sigCtx, stop)
		}
		name := c.name
		othersDone = append(othersDone, start(c, runCtx, func(err error) {
			if err != nil {
				othersErr <- fmt.Errorf("%s: %w", name, err)
			}
		}))
	}

	select {
	case err := <-othersErr:
		cancel()
		return err
	case err := <-routerRes:
		cancel()
		if err == nil {
			err = fmt.Errorf("%s: stopped before the signal", router.name)
		}
		return err
	case <-sigCtx.Done():
	}

	log.Info("controlplane draining: router first, then the rest")
	var routerErr error
drain:
	for {
		select {
		case routerErr = <-routerRes:
			break drain
		case err := <-othersErr:
			log.Error("component failed while the router drains; drain continues",
				"error", err)
		}
	}
	<-routerDone
	if routerErr != nil {
		log.Error("router did not drain cleanly", "error", routerErr)
	}
	cancel()

	deadline := time.After(stopGrace)
	for i, done := range othersDone {
		select {
		case <-done:
		case <-deadline:
			log.Warn("component did not stop in time", "component", others[i].name,
				"grace", stopGrace.String())
			return routerErr
		}
	}
	return routerErr
}

// managerOptions configures the controller manager. The manager stops on SIGTERM
// while the Router is still draining (see managerComponent), and nothing outside
// it acts as leader, so stepping down at once is safe and lets the replacement
// Pod reconcile Sandboxes immediately instead of waiting out the whole drain
// plus the lease duration.
func managerOptions(metricsAddr, probeAddr string, leaderElect bool) ctrl.Options {
	return ctrl.Options{
		Scheme: scheme,
		Metrics: metricsserver.Options{
			BindAddress: metricsAddr,
		},
		HealthProbeBindAddress:        probeAddr,
		LeaderElection:                leaderElect,
		LeaderElectionID:              "agent-sandbox-controlplane.agent-sandbox.io",
		LeaderElectionReleaseOnCancel: true,
	}
}

// managerComponent runs the controller manager so that it stops on the signal
// rather than after the Router's drain, releasing the leader lease.
func managerComponent(start func(context.Context) error) component {
	return component{name: "controller manager", run: start, stopOnSignal: true}
}
