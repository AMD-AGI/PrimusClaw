// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"strings"
	"testing"
	"time"
)

func TestAwaitTrackedExitHonoursTimeoutAfterDisconnect(t *testing.T) {
	// Context.Done used to return immediately, dropping the request timer. A
	// disconnect then left the tracked tree running with no deadline, so
	// /api/jobs stayed non-empty and idle reclaim never fired.
	exitCh := make(chan int, 1)
	timer := time.NewTimer(40 * time.Millisecond)
	stopped := make(chan struct{})
	started := time.Now()
	awaitTrackedExit(exitCh, timer, func() {
		close(stopped)
		exitCh <- 1
	})
	select {
	case <-stopped:
	default:
		t.Fatal("timeout after disconnect did not stop the tracked tree")
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("awaitTrackedExit hung past the request timeout: %s", elapsed)
	}
}

func TestAwaitTrackedExitReturnsOnNaturalExit(t *testing.T) {
	exitCh := make(chan int, 1)
	exitCh <- 0
	timer := time.NewTimer(time.Hour)
	defer timer.Stop()
	stopped := false
	awaitTrackedExit(exitCh, timer, func() { stopped = true })
	if stopped {
		t.Fatal("natural exit must not call stop")
	}
}

func TestOutputWaitDoesNotReadSilenceAsCompletion(t *testing.T) {
	// The exit status travels on its own descriptor while output travels through
	// a pipe and a copy goroutine, so the status routinely overtakes the last
	// bytes a command wrote. This wait exists to let the copy catch up.
	//
	// A buffer that has received nothing carries a zero timestamp, and the age
	// of a zero timestamp is two thousand years -- quiet by any measure. A wait
	// that reads that as completion returns before the first byte lands, and the
	// response goes out with an exit status and no output at all.
	var buf synchronizedBuffer
	// Never closed: this stands for a tree still holding the pipe open.
	running := make(chan struct{})
	go func() {
		time.Sleep(3 * outputQuietPeriod)
		_, _ = buf.Write([]byte("LATE"))
	}()
	awaitOutputQuiet(running, buf.lastWrite)
	if got := buf.String(); !strings.Contains(got, "LATE") {
		t.Fatalf("the wait ended before any output arrived, answering with %q", got)
	}
}

func TestOutputWaitEndsOnTheDrainSignal(t *testing.T) {
	// `shim.Wait()` returning is the point at which os/exec has joined the copy
	// goroutines feeding this buffer, so nothing can arrive after it. Waiting
	// out a quiet period past that signal would delay every ordinary response
	// for no reading that could still change.
	var buf synchronizedBuffer
	_, _ = buf.Write([]byte("EARLY"))
	drained := make(chan struct{})
	close(drained)
	started := time.Now()
	awaitOutputQuiet(drained, buf.lastWrite)
	if elapsed := time.Since(started); elapsed >= outputQuietPeriod {
		t.Fatalf("a tree already drained still paid the quiet period: %s", elapsed)
	}
}

func TestTakeClosesBufferAgainstDetachedWriters(t *testing.T) {
	// handleExecute's Context.Done path must call take() so a detached
	// descendant cannot keep appending after the HTTP response ends.
	var buf synchronizedBuffer
	_, _ = buf.Write([]byte("early"))
	if got := buf.take(); got != "early" {
		t.Fatalf("take returned %q", got)
	}
	n, err := buf.Write([]byte("late-and-large"))
	if err != nil {
		t.Fatalf("Write after take: %v", err)
	}
	if n != len("late-and-large") {
		t.Fatalf("Write should accept and discard, got n=%d", n)
	}
	if got := buf.String(); got != "" {
		t.Fatalf("buffer kept growing after take: %q", got)
	}
}

func TestOutputWaitGivesUpOnADetachedWriter(t *testing.T) {
	// A descendant the command detached holds the same pipe and can keep
	// writing, so the drain signal may never come and silence may never arrive.
	// The wait has to end anyway -- the ceiling is what makes the response
	// bounded rather than hostage to whatever the user left running.
	var buf synchronizedBuffer
	running := make(chan struct{})
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		for {
			select {
			case <-stop:
				return
			default:
				_, _ = buf.Write([]byte("."))
				time.Sleep(10 * time.Millisecond)
			}
		}
	}()
	started := time.Now()
	awaitOutputQuiet(running, buf.lastWrite)
	elapsed := time.Since(started)
	if elapsed < outputQuietCeiling {
		t.Fatalf("the wait ended before its ceiling on a writer that never stops: %s", elapsed)
	}
	if elapsed > outputQuietCeiling+time.Second {
		t.Fatalf("the ceiling did not bound the wait: %s", elapsed)
	}
}
