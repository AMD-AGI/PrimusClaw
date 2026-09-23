// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

const exitStatusFD = 3
const prSetChildSubreaper = 36

// runJobShim supervises one execute tree and adopts its orphaned descendants.
func runJobShim() {
	if len(os.Args) < 3 {
		os.Exit(2)
	}
	if _, _, errno := syscall.Syscall6(
		syscall.SYS_PRCTL,
		prSetChildSubreaper,
		1,
		0,
		0,
		0,
		0,
	); errno != 0 {
		os.Exit(1)
	}
	// Close-on-exec before the command starts. This descriptor carries the
	// primary PID and the exit status, and a program that writes to fd 3 by
	// convention would otherwise feed four of its own bytes back as an exit
	// code. Inherited, it also keeps the read end from seeing EOF when the shim
	// is killed, so a request would wait out its timeout instead.
	syscall.CloseOnExec(exitStatusFD)
	control := os.NewFile(uintptr(exitStatusFD), "job-control")
	if control == nil {
		os.Exit(1)
	}

	cmd := exec.Command(os.Args[2], os.Args[3:]...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	cmd.Env = os.Environ()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	// Two signals, two meanings. SIGTERM ends the command this execute started
	// and nothing else: a descendant that detached itself is background work
	// the request does not own, and killing it with the request is what made a
	// sandbox unable to host any. SIGUSR1 is the deliberate call that does end
	// the whole adopted tree. Notified before the command starts, because the
	// default disposition of SIGUSR1 is to terminate this process.
	cancelled := make(chan os.Signal, 1)
	signal.Notify(cancelled, syscall.SIGTERM)
	defer signal.Stop(cancelled)
	purge := make(chan os.Signal, 1)
	signal.Notify(purge, syscall.SIGUSR1)
	defer signal.Stop(purge)

	if err := cmd.Start(); err != nil {
		writeControlInt(control, 0)
		writeControlInt(control, 1)
		_ = control.Close()
		os.Exit(1)
	}
	writeControlInt(control, cmd.Process.Pid)

	waited := make(chan error, 1)
	go func() { waited <- cmd.Wait() }()

	var err error
	purgeRequested := false
	select {
	case err = <-waited:
	case <-cancelled:
		// Stop only the primary command's process group. A descendant that
		// deliberately created a new session remains adopted by this shim.
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		err = <-waited
	case <-purge:
		purgeRequested = true
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		err = <-waited
	}

	code := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			code = exitErr.ExitCode()
		} else {
			code = 1
		}
	}

	writeControlInt(control, code)
	_ = control.Close()
	if purgeRequested {
		killAdoptedDescendants()
		drainOrphans()
		return
	}
	// Whether or not the primary was cancelled, what it detached is still
	// running, and the roster has to go on accounting for it -- a sandbox is
	// only idle once this shim reports no descendants. Waiting on the purge
	// signal, not on SIGTERM: the request's cancellation has already been
	// spent, and the tree ends either when it finishes or when it is purged.
	reapOrphans(purge)
}

// purgeJobTree asks a shim to end everything it has adopted.
//
// The signal is the whole protocol: a shim that has outlived its request is
// waiting on it, and one still running its primary command takes the primary
// down with the tree.
//
// The target is confirmed first. A roster PID is only as good as the moment it
// was read, the kernel is free to hand a reaped shim's number to anything, and
// the default disposition of SIGUSR1 is to terminate -- so an unchecked signal
// can end a process that has nothing to do with this sandbox's jobs.
func purgeJobTree(shimPID int) error {
	if !isJobShim(shimPID) {
		return fmt.Errorf("pid %d is not a job shim", shimPID)
	}
	return syscall.Kill(shimPID, syscall.SIGUSR1)
}

// isJobShim reports whether the PID is one of this EnvD's job shims.
func isJobShim(pid int) bool {
	raw, err := os.ReadFile(fmt.Sprintf("%s/%d/cmdline", procRoot, pid))
	if err != nil {
		return false
	}
	for _, arg := range strings.Split(string(raw), "\x00") {
		if arg == jobShimArg {
			return true
		}
	}
	return false
}

// writeControlInt sends one process identity or exit status to EnvD.
func writeControlInt(control *os.File, value int) {
	var buf [4]byte
	binary.LittleEndian.PutUint32(buf[:], uint32(int32(value)))
	_, _ = control.Write(buf[:])
}

// reapOrphans waits until every descendant adopted by this shim has exited, or
// until EnvD purges the tree.
func reapOrphans(purge <-chan os.Signal) {
	for {
		var ws syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &ws, syscall.WNOHANG, nil)
		switch {
		case err == syscall.ECHILD:
			return
		case err == syscall.EINTR:
			continue
		case err != nil:
			return
		case pid > 0:
			continue
		}
		select {
		case <-purge:
			killAdoptedDescendants()
			drainOrphans()
			return
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// drainOrphans blocks until Wait4 reports no children remain.
func drainOrphans() {
	for {
		var ws syscall.WaitStatus
		_, err := syscall.Wait4(-1, &ws, 0, nil)
		if err == syscall.ECHILD {
			return
		}
		if err == syscall.EINTR {
			continue
		}
		if err != nil {
			return
		}
	}
}

// killAdoptedDescendants SIGKILLs every live process under this shim.
func killAdoptedDescendants() {
	self := os.Getpid()
	procs, err := listProcs(procRoot)
	if err != nil {
		return
	}
	byPPID := make(map[int][]int)
	for _, p := range procs {
		byPPID[p.ppid] = append(byPPID[p.ppid], p.pid)
	}
	seen := map[int]bool{self: true}
	queue := []int{self}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, child := range byPPID[cur] {
			if seen[child] {
				continue
			}
			seen[child] = true
			queue = append(queue, child)
			_ = syscall.Kill(child, syscall.SIGKILL)
		}
	}
}

// startTrackedCommand starts a shim independent of the HTTP request lifetime.
func (s *Server) startTrackedCommand(
	command []string,
	workDir string,
	env []string,
	stdout, stderr io.Writer,
	tracking jobTracking,
) (primaryPID int, exitCh <-chan int, drained <-chan struct{}, cancel func(), err error) {
	self, err := os.Executable()
	if err != nil {
		return 0, nil, nil, nil, err
	}
	exitR, exitW, err := os.Pipe()
	if err != nil {
		return 0, nil, nil, nil, err
	}

	shim := exec.Command(self, append([]string{jobShimArg}, command...)...)
	shim.Dir = workDir
	shim.Env = env
	shim.Stdout = stdout
	shim.Stderr = stderr
	shim.ExtraFiles = []*os.File{exitW}
	stripEnvDProxyGroup(shim)

	if err := shim.Start(); err != nil {
		_ = exitR.Close()
		_ = exitW.Close()
		return 0, nil, nil, nil, err
	}
	_ = exitW.Close()
	var pidBuf [4]byte
	if _, err := io.ReadFull(exitR, pidBuf[:]); err != nil {
		_ = exitR.Close()
		_ = shim.Wait()
		return 0, nil, nil, nil, fmt.Errorf("job shim startup handshake: %w", err)
	}
	primaryPID = int(int32(binary.LittleEndian.Uint32(pidBuf[:])))
	if primaryPID <= 0 {
		_ = exitR.Close()
		_ = shim.Wait()
		return 0, nil, nil, nil, fmt.Errorf("job shim failed to start primary command")
	}
	jobToken := uint64(0)
	if tracking.track {
		jobToken = s.jobs.add(shim.Process.Pid, tracking.hands)
	}

	ch := make(chan int, 1)
	go func() {
		var buf [4]byte
		code := 1
		if _, readErr := io.ReadFull(exitR, buf[:]); readErr == nil {
			code = int(int32(binary.LittleEndian.Uint32(buf[:])))
		}
		_ = exitR.Close()
		ch <- code
	}()
	// Closed once the supervisor has been reaped, which is where os/exec has
	// joined the goroutines copying its output: past this point the buffers a
	// caller reads can no longer change.
	done := make(chan struct{})
	cancel = func() {
		if shim.Process == nil {
			return
		}
		select {
		case <-done:
			return
		default:
			_ = shim.Process.Signal(syscall.SIGTERM)
		}
	}
	go func() {
		waitErr := shim.Wait()
		// Only a tracked tree contributes to the jobs roster, so only its
		// supervisor dying leaves descendants unaccounted for.
		if tracking.track && supervisorDiedUnexpectedly(waitErr) {
			s.jobs.markLost()
		}
		s.jobs.remove(shim.Process.Pid, jobToken)
		close(done)
	}()
	return primaryPID, ch, done, cancel, nil
}

// supervisorDiedUnexpectedly is true when the shim was signaled or failed
// without a normal exit, so remaining descendants are no longer tracked.
func supervisorDiedUnexpectedly(err error) bool {
	if err == nil {
		return false
	}
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		return true
	}
	status, ok := exitErr.Sys().(syscall.WaitStatus)
	if !ok {
		return false
	}
	return status.Signaled() && status.Signal() != syscall.SIGTERM
}
