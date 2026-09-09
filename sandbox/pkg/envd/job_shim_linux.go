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
	"syscall"
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

	if err := cmd.Start(); err != nil {
		writeControlInt(control, 0)
		writeControlInt(control, 1)
		_ = control.Close()
		os.Exit(1)
	}
	writeControlInt(control, cmd.Process.Pid)

	cancelled := make(chan os.Signal, 1)
	signal.Notify(cancelled, syscall.SIGTERM)
	waited := make(chan error, 1)
	go func() { waited <- cmd.Wait() }()

	var err error
	select {
	case err = <-waited:
	case <-cancelled:
		// Stop only the primary command's process group. A descendant that
		// deliberately created a new session remains adopted by this shim.
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		err = <-waited
	}
	// The primary process is complete; later cancellation must not break
	// adoption while detached descendants are still alive.
	signal.Ignore(syscall.SIGTERM)

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
	reapOrphans()
}

// writeControlInt sends one process identity or exit status to EnvD.
func writeControlInt(control *os.File, value int) {
	var buf [4]byte
	binary.LittleEndian.PutUint32(buf[:], uint32(int32(value)))
	_, _ = control.Write(buf[:])
}

// reapOrphans waits until every descendant adopted by this shim has exited.
func reapOrphans() {
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

// startTrackedCommand starts a shim independent of the HTTP request lifetime.
func (s *Server) startTrackedCommand(
	command []string,
	workDir string,
	env []string,
	stdout, stderr io.Writer,
) (primaryPID int, exitCh <-chan int, cancel func(), err error) {
	self, err := os.Executable()
	if err != nil {
		return 0, nil, nil, err
	}
	exitR, exitW, err := os.Pipe()
	if err != nil {
		return 0, nil, nil, err
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
		return 0, nil, nil, err
	}
	_ = exitW.Close()
	var pidBuf [4]byte
	if _, err := io.ReadFull(exitR, pidBuf[:]); err != nil {
		_ = exitR.Close()
		_ = shim.Wait()
		return 0, nil, nil, fmt.Errorf("job shim startup handshake: %w", err)
	}
	primaryPID = int(int32(binary.LittleEndian.Uint32(pidBuf[:])))
	if primaryPID <= 0 {
		_ = exitR.Close()
		_ = shim.Wait()
		return 0, nil, nil, fmt.Errorf("job shim failed to start primary command")
	}
	s.jobs.add(shim.Process.Pid, command)

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
		if supervisorDiedUnexpectedly(waitErr) {
			s.jobs.markLost()
		}
		s.jobs.remove(shim.Process.Pid)
		close(done)
	}()
	return primaryPID, ch, cancel, nil
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
