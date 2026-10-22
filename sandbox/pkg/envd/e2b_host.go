// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"io"
	"os"

	e2brpc "sigs.k8s.io/agent-sandbox/pkg/envd/e2b"
)

// startE2BCommand starts a user command with job accounting and an optional stdin pipe.
// The command keeps running after the Connect stream that started it disconnects.
func (s *Server) startE2BCommand(argv []string, dir string, env map[string]string, withStdin bool) (e2brpc.Command, error) {
	root := s.workspace
	if root == "" {
		root = "/home/sandbox"
	}
	cleaned, err := e2brpc.SandboxPath(root, dir)
	if err != nil {
		return e2brpc.Command{}, err
	}
	var stdin io.Reader
	var stdinR *io.PipeReader
	var stdinW *io.PipeWriter
	if withStdin {
		stdinR, stdinW = io.Pipe()
		stdin = stdinR
	}
	stdoutR, stdoutW := io.Pipe()
	stderrR, stderrW := io.Pipe()
	pid, exitCh, drained, stop, err := s.startTrackedCommand(
		argv, cleaned, s.childEnv(env), stdoutW, stderrW, stdin, jobTracking{track: true},
	)
	if err != nil {
		_ = stdoutR.Close()
		_ = stdoutW.Close()
		_ = stderrR.Close()
		_ = stderrW.Close()
		if stdinW != nil {
			_ = stdinW.Close()
		}
		if stdinR != nil {
			_ = stdinR.Close()
		}
		return e2brpc.Command{}, err
	}
	go func() {
		<-drained
		_ = stdoutW.Close()
		_ = stderrW.Close()
		if stdinR != nil {
			_ = stdinR.Close()
		}
	}()
	return e2brpc.Command{
		PID:    pid,
		Stdout: stdoutR,
		Stderr: stderrR,
		Stdin:  stdinW,
		Exit:   exitCh,
		Stop:   stop,
	}, nil
}

// childEnv builds the environment passed to an E2B command.
func (s *Server) childEnv(env map[string]string) []string {
	if s != nil && s.inference != nil {
		return s.buildChildEnv(env)
	}
	out := os.Environ()
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	return out
}
