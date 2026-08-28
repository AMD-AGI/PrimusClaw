// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

// testDrainTimeout keeps the drain long enough to be a real wait and short
// enough that the suite does not spend the production budget on every run.
const testDrainTimeout = 200 * time.Millisecond

// widenHardExitGrace moves the abandon-shutdown timer far out of the way.
//
// That timer ends the process when it fires, so a scheduling stall on a loaded
// machine would take this test binary down with it -- and what these tests are
// about is that Run returns, not what happens when it cannot. Safe to assign
// here because it happens before the goroutine that reads it is started, and the
// restore runs after that goroutine has already handed back its result.
func widenHardExitGrace(t *testing.T) {
	t.Helper()
	previous := shutdownHardExitGrace
	shutdownHardExitGrace = 30 * time.Second
	t.Cleanup(func() { shutdownHardExitGrace = previous })
}

// freePort asks the kernel for a port nobody is using, so parallel runs cannot
// collide on a fixed one.
func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	if err := l.Close(); err != nil {
		t.Fatalf("release port: %v", err)
	}
	return port
}

// waitForListener blocks until the server accepts, so the test signals a
// running server rather than racing its startup.
func waitForListener(t *testing.T, port int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 200*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("server on port %d never started listening", port)
}

// TestRunReturnsEvenWhileACommandIsStillRunning pins the property that makes a
// signalled sandbox actually stop.
//
// envd is PID 1, so Run returning is what ends the container. Shutdown closes
// the listeners at once and then waits for in-flight requests; while that wait
// was unbounded, one long agent command kept PID 1 alive indefinitely. From
// outside, the pod stayed Running with every connection refused --
// indistinguishable from a crash, and with no exit code to explain it.
func TestRunReturnsEvenWhileACommandIsStillRunning(t *testing.T) {
	widenHardExitGrace(t)
	port := freePort(t)
	srv, err := New(Config{
		Port:                 port,
		Workspace:            t.TempDir(),
		ShutdownDrainTimeout: testDrainTimeout,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	runErr := make(chan error, 1)
	go func() { runErr <- srv.Run(ctx) }()
	waitForListener(t, port)

	// A command that outlives the drain, standing in for the agent work the
	// real shutdown got stuck behind.
	inFlight := make(chan struct{})
	go func() {
		defer close(inFlight)
		resp, err := http.Post(
			fmt.Sprintf("http://127.0.0.1:%d/api/execute", port),
			"application/json",
			strings.NewReader(`{"command":["sh","-c","sleep 120"],"timeout":"120s"}`),
		)
		if err == nil {
			_ = resp.Body.Close()
		}
	}()
	// Let the request reach the handler before signalling.
	time.Sleep(300 * time.Millisecond)

	start := time.Now()
	cancel()

	select {
	case err := <-runErr:
		if err != nil {
			t.Fatalf("Run returned an error: %v", err)
		}
		if elapsed := time.Since(start); elapsed < testDrainTimeout {
			t.Logf("returned in %s (drain finished early)", elapsed)
		}
	case <-time.After(testDrainTimeout + 15*time.Second):
		t.Fatal("Run never returned: a signalled envd must not keep PID 1 alive waiting on a command")
	}

	<-inFlight
}

// TestRunReturnsPromptlyWithNothingInFlight keeps the common case honest: the
// bounded drain must not make an idle shutdown wait out its whole timeout.
func TestRunReturnsPromptlyWithNothingInFlight(t *testing.T) {
	widenHardExitGrace(t)
	port := freePort(t)
	srv, err := New(Config{Port: port, Workspace: t.TempDir()})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	runErr := make(chan error, 1)
	go func() { runErr <- srv.Run(ctx) }()
	waitForListener(t, port)
	cancel()

	select {
	case err := <-runErr:
		if err != nil {
			t.Fatalf("Run returned an error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("an idle shutdown must not wait for the drain timeout")
	}
}
