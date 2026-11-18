// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package e2b

import (
	"io"
	"sync"
	"testing"
	"time"
)

func TestWaitForOutput(t *testing.T) {
	start := time.Unix(1_700_000_000, 0)
	cases := []struct {
		name    string
		drained bool
		last    time.Time
		want    time.Duration
	}{
		{name: "already drained", drained: true, last: start.Add(-time.Second), want: 0},
		{name: "write before the exit", last: start.Add(-time.Second), want: OutputQuietPeriod},
		{name: "nothing written", want: OutputFirstByteGrace},
		{name: "write during the wait", last: start.Add(OutputQuietPeriod), want: 2 * OutputQuietPeriod},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			now := start
			var mu sync.Mutex
			drained := make(chan struct{})
			if tc.drained {
				close(drained)
			}
			waitForOutput(drained, func() time.Time { return tc.last }, outputClock{
				now: func() time.Time {
					mu.Lock()
					defer mu.Unlock()
					return now
				},
				sleep: func(d time.Duration) {
					mu.Lock()
					now = now.Add(d)
					mu.Unlock()
				},
			})
			mu.Lock()
			got := now.Sub(start)
			mu.Unlock()
			if got != tc.want {
				t.Fatalf("waited %s, want %s", got, tc.want)
			}
		})
	}
}

func TestCloseInputOnExit(t *testing.T) {
	r, w := io.Pipe()
	exit := make(chan int, 1)
	exit <- 0
	p := newProc(1, "", processConfig{}, Command{Stdin: w, Exit: exit})
	done := make(chan struct{})
	go func() {
		buf := make([]byte, 1)
		_, _ = r.Read(buf)
		close(done)
	}()
	p.closeInput()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("closing stdin did not unblock the reader")
	}
	if p.cmd.Stdin != nil {
		t.Fatal("stdin is still open after the process exits")
	}
}

func TestWriteAfterExitIsNotFound(t *testing.T) {
	p := newProc(1, "", processConfig{}, Command{})
	p.finish(0, "")
	s := newProcesses(nil)
	s.byPID[1] = p
	err := s.writeInput(selector{PID: 1}, []byte("x"))
	got, ok := err.(*rpcError)
	if !ok || got.code != "not_found" {
		t.Fatalf("write after exit returned %v", err)
	}
}
