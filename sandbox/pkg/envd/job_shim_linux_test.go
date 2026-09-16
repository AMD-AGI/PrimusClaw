// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build linux

package envd

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// TestMain lets the test binary act as the job shim. startTrackedCommand
// re-executes os.Executable() with the shim argument, which under `go test` is
// this binary, so the shim path is exercised against the real fork, subreaper
// and reaping behaviour rather than a stand-in.
func TestMain(m *testing.M) {
	if MaybeRunJobShim() {
		return
	}
	os.Exit(m.Run())
}

func newTestServer() *Server {
	return &Server{jobs: newJobRegistry(), instanceID: "inst-test"}
}

// run starts a tracked command and returns its exit code once the primary ends.
func run(t *testing.T, s *Server, track bool, args ...string) (int, *synchronizedBuffer) {
	t.Helper()
	var out synchronizedBuffer
	_, exitCh, _, err := s.startTrackedCommand(args, "", os.Environ(), &out, &out, track)
	if err != nil {
		t.Fatalf("startTrackedCommand: %v", err)
	}
	select {
	case code := <-exitCh:
		return code, &out
	case <-time.After(30 * time.Second):
		t.Fatal("primary command did not finish")
		return 0, nil
	}
}

func TestTrackedCommandDeliversOutputTheExitStatusOvertook(t *testing.T) {
	// The exit status arrives on its own descriptor while the output crosses a
	// pipe, so a command that writes a lot and exits at once is the case where
	// the two race. Every line has to be present.
	const lines = 4000
	s := newTestServer()
	script := fmt.Sprintf("i=0; while [ $i -lt %d ]; do echo line-$i; i=$((i+1)); done", lines)
	code, out := run(t, s, true, "sh", "-c", script)
	if code != 0 {
		t.Fatalf("exit=%d", code)
	}
	awaitOutputQuiet(out.lastWrite)
	got := strings.Count(out.String(), "\n")
	if got != lines {
		t.Fatalf("output truncated: got %d lines, want %d", got, lines)
	}
}

func TestJobShimDoesNotLeakItsControlDescriptor(t *testing.T) {
	// fd 3 carries the primary PID and the exit status. A command that writes to
	// it by convention must not be able to reach it, or those bytes are read
	// back as an exit code.
	s := newTestServer()
	code, out := run(t, s, true, "sh", "-c", "echo intruder >&3 && echo reachable || echo refused")
	awaitOutputQuiet(out.lastWrite)
	if !strings.Contains(out.String(), "refused") {
		t.Fatalf("fd 3 was inherited by the command: exit=%d out=%q", code, out.String())
	}
}

func TestSetsidDescendantKeepsTheJobTracked(t *testing.T) {
	// The shim is a subreaper, so a descendant that detaches itself is adopted
	// by it rather than by PID 1, and the job stays on the roster until that
	// descendant exits.
	s := newTestServer()
	code, _ := run(t, s, true, "sh", "-c", "setsid sleep 2 >/dev/null 2>&1 & exit 0")
	if code != 0 {
		t.Fatalf("exit=%d", code)
	}
	snap, err := s.jobs.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if snap.count == 0 {
		t.Fatal("a detached descendant left the roster empty, so the sandbox reads as idle")
	}
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		snap, err = s.jobs.snapshot()
		if err != nil {
			t.Fatal(err)
		}
		if snap.count == 0 {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("the job stayed on the roster after its descendant exited")
}

func TestHandsJobCountsDescendantsAndNotHandsItself(t *testing.T) {
	// The Hands job is infrastructure: its own process never counts, and the
	// roster reports the descendants it spawned. This is the branch that decides
	// every reclaim in production, and it walks procfs.
	s := newTestServer()
	command := []string{"sh", "-c", "exec -a /tmp/.hands-binary sleep 2"}
	if !isHandsCommand(command) {
		t.Fatal("the relaunch command has to be recognised as Hands")
	}
	var out synchronizedBuffer
	_, _, stop, err := s.startTrackedCommand(command, "", os.Environ(), &out, &out, true)
	if err != nil {
		t.Fatalf("startTrackedCommand: %v", err)
	}
	defer stop()
	// Read once, while Hands is up: the walk crosses every process the caller
	// can see, so its cost tracks the size of that table rather than the tree.
	time.Sleep(200 * time.Millisecond)
	snap, err := s.jobs.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if snap.count != 0 {
		t.Fatalf("Hands counted itself as user work, which holds every sandbox open: %+v", snap)
	}
}

func TestUntrackedCommandStaysOffTheRoster(t *testing.T) {
	// Probes and ledger reads travel this path. Counting them would make an idle
	// sandbox look busy for as long as the probe runs.
	s := newTestServer()
	if _, _ = run(t, s, false, "sh", "-c", "exit 0"); false {
		return
	}
	snap, err := s.jobs.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if snap.count != 0 || snap.lost {
		t.Fatalf("untracked execute reached the roster: %+v", snap)
	}
}

func TestSignalledUntrackedShimDoesNotLoseTracking(t *testing.T) {
	// Tracking loss is about a roster that can no longer account for its jobs.
	// An untracked tree was never accounted for, so its supervisor dying says
	// nothing -- and a latched flag would stop every later reclaim.
	s := newTestServer()
	var out synchronizedBuffer
	_, exitCh, stop, err := s.startTrackedCommand(
		[]string{"sh", "-c", "sleep 30"}, "", os.Environ(), &out, &out, false,
	)
	if err != nil {
		t.Fatalf("startTrackedCommand: %v", err)
	}
	stop()
	select {
	case <-exitCh:
	case <-time.After(30 * time.Second):
		t.Fatal("the signalled shim did not settle")
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		snap, snapErr := s.jobs.snapshot()
		if snapErr != nil {
			t.Fatal(snapErr)
		}
		if !snap.lost && snap.count == 0 {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("an untracked shim's death latched tracking_lost")
}
