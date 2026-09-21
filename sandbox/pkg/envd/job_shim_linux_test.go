// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build linux

package envd

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
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

var shimProbe struct {
	once sync.Once
	err  error
}

// requireJobShim skips where this environment will not let the test binary
// re-execute itself, which is how these cases reach the supervisor. A sandbox
// runs EnvD as its own binary and has no such restriction; a build container
// under a restrictive seccomp profile can.
func requireJobShim(t *testing.T) {
	t.Helper()
	shimProbe.once.Do(func() {
		var out synchronizedBuffer
		s := newTestServer()
		_, exitCh, _, _, err := s.startTrackedCommand(
			[]string{"true"}, "", os.Environ(), &out, &out, jobTracking{},
		)
		if err != nil {
			shimProbe.err = err
			return
		}
		select {
		case <-exitCh:
		case <-time.After(30 * time.Second):
			shimProbe.err = errors.New("the shim did not report an exit status")
		}
	})
	if shimProbe.err != nil {
		t.Skipf("the job shim cannot start here, so the supervisor is untested: %v", shimProbe.err)
	}
}

// run starts a tracked command and returns its exit code once the primary ends,
// having waited out its output the way the handlers do. Cases assert on what a
// response would have carried, so they have to wait where a response waits.
func run(t *testing.T, s *Server, track bool, args ...string) (int, *synchronizedBuffer) {
	t.Helper()
	var out synchronizedBuffer
	_, exitCh, drained, _, err := s.startTrackedCommand(
		args, "", os.Environ(), &out, &out, jobTracking{track: track},
	)
	if err != nil {
		t.Fatalf("startTrackedCommand: %v", err)
	}
	select {
	case code := <-exitCh:
		awaitOutputQuiet(drained, out.lastWrite)
		return code, &out
	case <-time.After(30 * time.Second):
		t.Fatal("primary command did not finish")
		return 0, nil
	}
}

func TestTrackedCommandDeliversOutputTheExitStatusOvertook(t *testing.T) {
	requireJobShim(t)
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
	got := strings.Count(out.String(), "\n")
	if got != lines {
		t.Fatalf("output truncated: got %d lines, want %d", got, lines)
	}
}

func TestOneLineOfOutputSurvivesAnImmediateExit(t *testing.T) {
	requireJobShim(t)
	// The shape that actually lost output: a single line, then exit. The status
	// crosses its own descriptor and reaches the handler before the copy
	// goroutine has been scheduled at all, so the buffer is still empty and its
	// write timestamp still zero. Repeated because losing it is a scheduling
	// race that a single attempt will not show.
	s := newTestServer()
	for attempt := 0; attempt < 60; attempt++ {
		code, out := run(t, s, true, "sh", "-c", "echo ONLY")
		if code != 0 {
			t.Fatalf("attempt %d: exit=%d", attempt, code)
		}
		if !strings.Contains(out.String(), "ONLY") {
			t.Fatalf("attempt %d answered with an exit status and no output: %q",
				attempt, out.String())
		}
	}
}

func TestJobShimDoesNotLeakItsControlDescriptor(t *testing.T) {
	requireJobShim(t)
	// fd 3 carries the primary PID and the exit status. A command that writes to
	// it by convention must not be able to reach it, or those bytes are read
	// back as an exit code.
	s := newTestServer()
	code, out := run(t, s, true, "sh", "-c", "echo intruder >&3 && echo reachable || echo refused")
	if !strings.Contains(out.String(), "refused") {
		t.Fatalf("fd 3 was inherited by the command: exit=%d out=%q", code, out.String())
	}
}

func TestSetsidDescendantIsAdoptedByItsSupervisor(t *testing.T) {
	requireJobShim(t)
	// Two mechanisms hold this job together, and the assertions below name one
	// each.
	//
	// `PR_SET_CHILD_SUBREAPER` is what makes a descendant that called setsid
	// re-parent onto the shim instead of onto PID 1. Without it the descendant
	// leaves every subtree the roster walk starts at, and no later walk can
	// reach it -- so its parent being anything other than init is the
	// observable.
	//
	// `reapOrphans` is what keeps the shim itself alive until that descendant
	// exits. Without it the shim is reaped as soon as the primary returns, the
	// job leaves the roster, and the sandbox reports idle with work still in it
	// -- so the supervisor still running is the other observable.
	//
	// The descendant reports its own pid, because the shim's pid is not returned
	// and init is the only parent that needs ruling out.
	s := newTestServer()
	pidFile := filepath.Join(t.TempDir(), "descendant.pid")
	var out synchronizedBuffer
	_, exitCh, drained, stop, err := s.startTrackedCommand(
		[]string{"sh", "-c", fmt.Sprintf(
			"setsid sh -c 'echo $$ > %s; sleep 30' >/dev/null 2>&1 & exit 0", pidFile,
		)},
		"", os.Environ(), &out, &out, jobTracking{track: true},
	)
	if err != nil {
		t.Fatalf("startTrackedCommand: %v", err)
	}
	defer stop()
	select {
	case code := <-exitCh:
		if code != 0 {
			t.Fatalf("the primary command failed: exit=%d", code)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the primary command did not finish")
	}

	descendant := 0
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
		if raw, readErr := os.ReadFile(pidFile); readErr == nil {
			if pid, convErr := strconv.Atoi(strings.TrimSpace(string(raw))); convErr == nil {
				descendant = pid
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if descendant == 0 {
		t.Fatal("the detached descendant never reported its pid")
	}

	info, ok := readProc(procRoot, descendant)
	if !ok {
		t.Fatalf("the detached descendant %d is already gone", descendant)
	}
	if info.ppid == 1 {
		t.Fatal("the detached descendant was re-parented to init, " +
			"so no roster walk can reach it and the sandbox reads as idle")
	}

	select {
	case <-drained:
		t.Fatal("the supervisor was reaped while its detached descendant was still " +
			"running, so the job left the roster with work still in it")
	default:
	}
}

func TestTheJobLeavesTheRosterOnceItsTreeIsEmpty(t *testing.T) {
	requireJobShim(t)
	// The other half of the contract: holding the job open past its tree would
	// keep every sandbox that ever detached anything from being reclaimed.
	s := newTestServer()
	code, _ := run(t, s, true, "sh", "-c", "setsid sleep 1 >/dev/null 2>&1 & exit 0")
	if code != 0 {
		t.Fatalf("exit=%d", code)
	}
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		snap, err := s.jobs.snapshot()
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

func TestCancelFreesShimStuckReapingOrphans(t *testing.T) {
	requireJobShim(t)
	// After the primary exits, the shim stays alive for setsid descendants.
	// cancel() sends SIGTERM; Ignore left that signal inert and the job on the
	// roster for the Pod lifetime, so every idle reclaim read the sandbox busy.
	s := newTestServer()
	pidFile := filepath.Join(t.TempDir(), "descendant.pid")
	var out synchronizedBuffer
	_, exitCh, drained, stop, err := s.startTrackedCommand(
		[]string{"sh", "-c", fmt.Sprintf(
			"setsid sh -c 'echo $$ > %s; sleep 100000' >/dev/null 2>&1 & exit 0", pidFile,
		)},
		"", os.Environ(), &out, &out, jobTracking{track: true},
	)
	if err != nil {
		t.Fatalf("startTrackedCommand: %v", err)
	}
	select {
	case code := <-exitCh:
		if code != 0 {
			t.Fatalf("the primary command failed: exit=%d", code)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the primary command did not finish")
	}
	descendant := 0
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
		if raw, readErr := os.ReadFile(pidFile); readErr == nil {
			if pid, convErr := strconv.Atoi(strings.TrimSpace(string(raw))); convErr == nil {
				descendant = pid
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if descendant == 0 {
		t.Fatal("the detached descendant never reported its pid")
	}
	select {
	case <-drained:
		t.Fatal("the supervisor left before cancel while its orphan still ran")
	default:
	}
	stop()
	select {
	case <-drained:
	case <-time.After(30 * time.Second):
		t.Fatal("SIGTERM did not free a shim stuck reaping orphans")
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		snap, snapErr := s.jobs.snapshot()
		if snapErr != nil {
			t.Fatal(snapErr)
		}
		if snap.count == 0 && !snap.lost {
			if _, ok := readProc("/proc", descendant); ok {
				t.Fatal("the orphan survived cancel; the roster would still look busy")
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("cancel left the job on the roster")
}

func TestHandsStartIsAccountedAsInfrastructure(t *testing.T) {
	// The Hands job is infrastructure: the roster reports the descendants it
	// spawned rather than the supervisor, which is the branch that decides every
	// reclaim. A user job is accounted for by its own live shim instead.
	root := procTable(t,
		procEntry{pid: 400, ppid: 1, state: 'S', argv: []string{"envd", "--job-shim", "sh"}},
		procEntry{pid: 401, ppid: 400, state: 'S', argv: []string{"/tmp/.hands-binary"}},
	)
	r := newJobRegistry()
	r.count = func(shimPID int) (int, error) { return countUserDescendantsIn(root, shimPID) }
	r.add(400, true)
	snap, err := r.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if snap.count != 0 {
		t.Fatalf("Hands counted itself as user work, which holds every sandbox open: %+v", snap)
	}
	r.add(500, false)
	snap, err = r.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if snap.count != 1 {
		t.Fatalf("a live user shim is work regardless of its tree: %+v", snap)
	}
}

func TestUntrackedCommandStaysOffTheRoster(t *testing.T) {
	requireJobShim(t)
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
	requireJobShim(t)
	// Tracking loss is about a roster that can no longer account for its jobs.
	// An untracked tree was never accounted for, so its supervisor dying says
	// nothing -- and a latched flag would stop every later reclaim.
	s := newTestServer()
	var out synchronizedBuffer
	_, exitCh, _, stop, err := s.startTrackedCommand(
		[]string{"sh", "-c", "sleep 30"}, "", os.Environ(), &out, &out, jobTracking{},
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

// procEntry is one row of a process table the walk can be pointed at.
type procEntry struct {
	pid   int
	ppid  int
	state byte
	argv  []string
}

// procTable writes a process table the walk reads like procfs. Pointing the
// walk at one of these keeps a case about the tree from being a measurement of
// whatever else the host is running.
func procTable(t *testing.T, entries ...procEntry) string {
	t.Helper()
	root := t.TempDir()
	for _, e := range entries {
		dir := filepath.Join(root, strconv.Itoa(e.pid))
		if err := os.Mkdir(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		comm := filepath.Base(e.argv[0])
		stat := fmt.Sprintf("%d (%s) %c %d 0 0 0\n", e.pid, comm, e.state, e.ppid)
		if err := os.WriteFile(filepath.Join(dir, "stat"), []byte(stat), 0o644); err != nil {
			t.Fatal(err)
		}
		cmdline := strings.Join(e.argv, "\x00") + "\x00"
		if err := os.WriteFile(filepath.Join(dir, "cmdline"), []byte(cmdline), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestWorkDetachedAlongsideHandsIsCounted(t *testing.T) {
	// The shape production produces. The tracked job starts Hands; Hands spawns
	// a detached shell for the user's command, and prompts routinely detach
	// again with `setsid nohup`. Neither hop leaves the shim -- a subreaper
	// adopts orphans from its whole descendant tree, and setsid changes the
	// session rather than the parent chain -- so both land back under it.
	// Hands stays out of the count while the work beside it is counted.
	root := procTable(t,
		procEntry{pid: 100, ppid: 1, state: 'S', argv: []string{"envd", "--job-shim", "sh"}},
		procEntry{pid: 101, ppid: 100, state: 'S', argv: []string{"/tmp/.hands-binary"}},
		procEntry{pid: 102, ppid: 100, state: 'S', argv: []string{"sleep", "120"}},
	)
	n, err := countUserDescendantsIn(root, 100)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("detached work beside Hands has to be the one thing counted, got %d", n)
	}
}

func TestHandsDescendantsAreCountedAndZombiesAreNot(t *testing.T) {
	// Work the user started through Hands is a descendant of Hands, so the walk
	// has to continue through the process it excludes. A zombie has nothing
	// left running and is not work.
	root := procTable(t,
		procEntry{pid: 200, ppid: 1, state: 'S', argv: []string{"envd", "--job-shim", "sh"}},
		procEntry{pid: 201, ppid: 200, state: 'S', argv: []string{"/app/hands-binary"}},
		procEntry{pid: 202, ppid: 201, state: 'S', argv: []string{"python", "train.py"}},
		procEntry{pid: 203, ppid: 202, state: 'S', argv: []string{"sh", "-c", "nvidia-smi"}},
		procEntry{pid: 204, ppid: 201, state: 'Z', argv: []string{"sh"}},
	)
	n, err := countUserDescendantsIn(root, 200)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("Hands is excluded but its descendants are not, and a zombie is not work; got %d", n)
	}
}

func TestAnIdleHandsSandboxCountsNothing(t *testing.T) {
	// The state a reclaim turns on: Hands resident, nothing else running.
	root := procTable(t,
		procEntry{pid: 300, ppid: 1, state: 'S', argv: []string{"envd", "--job-shim", "sh"}},
		procEntry{pid: 301, ppid: 300, state: 'S', argv: []string{"/tmp/.hands-binary"}},
	)
	n, err := countUserDescendantsIn(root, 300)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("a sandbox holding only Hands is idle, got %d", n)
	}
}

func TestOnlyHandsItselfIsExcludedFromTheCount(t *testing.T) {
	// Hands is deployed under several paths, so the leading directories are not
	// part of the test. Everything else is user work: a command that merely
	// mentions the path, or a wrapper named after it, occupies the sandbox, and
	// excluding it would report that sandbox as idle.
	for _, tc := range []struct {
		cmd  string
		want bool
	}{
		{"/app/hands-binary", true},
		{"/tmp/.hands-binary", true},
		{"/wekafs/Primus-Claw/primus-claw/hands-binary", true},
		{"/app/hands-binary --serve", true},
		{"/opt/run-hands-binary-helper", false},
		{"sleep 60 # hands-binary", false},
		{"cp /tmp/.hands-binary /workspace/x", false},
		{"python train.py --out /data/hands-binary", false},
		{"/usr/local/bin/hands-binary-wrapper", false},
	} {
		if got := isHandsProcess(tc.cmd); got != tc.want {
			t.Errorf("isHandsProcess(%q) = %v, want %v", tc.cmd, got, tc.want)
		}
	}
}

func TestKilledTrackedShimLatchesTrackingLoss(t *testing.T) {
	requireJobShim(t)
	// A tracked supervisor that dies on a non-SIGTERM signal leaves its
	// setsid descendants re-parented onto PID 1, outside every roster walk.
	// tracking_lost is the only record of that; deleting markLost would make
	// the sandbox look idle while the orphan keeps running.
	s := newTestServer()
	pidFile := filepath.Join(t.TempDir(), "descendant.pid")
	var out synchronizedBuffer
	_, exitCh, drained, _, err := s.startTrackedCommand(
		[]string{"sh", "-c", fmt.Sprintf(
			"setsid sh -c 'echo $$ > %s; sleep 60' >/dev/null 2>&1 & exit 0", pidFile,
		)},
		"", os.Environ(), &out, &out, jobTracking{track: true, hands: true},
	)
	if err != nil {
		t.Fatalf("startTrackedCommand: %v", err)
	}
	select {
	case code := <-exitCh:
		if code != 0 {
			t.Fatalf("the primary command failed: exit=%d", code)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the primary command did not finish")
	}
	descendant := 0
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
		if raw, readErr := os.ReadFile(pidFile); readErr == nil {
			if pid, convErr := strconv.Atoi(strings.TrimSpace(string(raw))); convErr == nil {
				descendant = pid
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if descendant == 0 {
		t.Fatal("the detached descendant never reported its pid")
	}
	info, ok := readProc("/proc", descendant)
	if !ok {
		t.Fatalf("the detached descendant %d is already gone", descendant)
	}
	shim := info.ppid
	if shim <= 1 {
		t.Fatalf("descendant parent is %d; expected the still-running shim", shim)
	}
	if err := syscall.Kill(shim, syscall.SIGKILL); err != nil {
		t.Fatalf("SIGKILL shim %d: %v", shim, err)
	}
	select {
	case <-drained:
	case <-time.After(30 * time.Second):
		t.Fatal("the killed shim was not reaped")
	}
	snap, err := s.jobs.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if !snap.lost {
		t.Fatal("killing a tracked shim did not latch tracking_lost")
	}
	after, ok := readProc("/proc", descendant)
	if !ok {
		t.Fatalf("the orphaned descendant %d exited before the assertion", descendant)
	}
	if after.ppid != 1 {
		t.Fatalf("orphaned descendant ppid=%d, want 1 (init)", after.ppid)
	}
	_ = syscall.Kill(descendant, syscall.SIGKILL)
}
