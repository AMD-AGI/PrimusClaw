// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build !linux

package envd

import (
	"context"
	"io"
	"os/exec"
)

// runJobShim is unavailable outside Linux.
func runJobShim() {}

// startTrackedCommand preserves basic execute behavior outside Linux.
func (s *Server) startTrackedCommand(
	ctx context.Context,
	command []string,
	workDir string,
	env []string,
	stdout, stderr io.Writer,
) (int, <-chan int, func(), error) {
	cmd := exec.CommandContext(ctx, command[0], command[1:]...)
	cmd.Dir = workDir
	cmd.Env = env
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	stripEnvDProxyGroup(cmd)
	ch := make(chan int, 1)
	if err := cmd.Start(); err != nil {
		return 0, nil, func() {}, err
	}
	go func() {
		err := cmd.Wait()
		code := 0
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				code = exitErr.ExitCode()
			} else {
				code = 1
			}
		}
		ch <- code
	}()
	return cmd.Process.Pid, ch, func() {}, nil
}
