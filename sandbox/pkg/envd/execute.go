// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"syscall"
	"time"

	"sigs.k8s.io/agent-sandbox/pkg/cmdlog"
	log "sigs.k8s.io/agent-sandbox/pkg/logx"
)

// handleExecute handles POST /api/execute — synchronous command execution.
func (s *Server) handleExecute(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req ExecuteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpError(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}

	if len(req.Command) == 0 {
		httpError(w, "command is required", http.StatusBadRequest)
		return
	}

	log.Info("sandbox.execute",
		"sessionId", r.Header.Get("x-session-id"),
		"timeout", req.Timeout,
		"command", cmdlog.Preview(req.Command, 0),
		"stream", false,
	)

	// Parse timeout
	timeout := 60 * time.Second
	if req.Timeout != "" {
		if d, err := time.ParseDuration(req.Timeout); err == nil {
			timeout = d
		}
	}

	// Resolve working directory
	workDir := s.workspace
	if req.WorkingDir != "" {
		abs, err := sanitizePath(s.workspace, req.WorkingDir)
		if err != nil {
			httpError(w, "invalid working_dir: "+err.Error(), http.StatusBadRequest)
			return
		}
		workDir = abs
	}

	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, req.Command[0], req.Command[1:]...)
	cmd.Dir = workDir
	cmd.Env = s.buildChildEnv(req.Env)
	stripEnvDProxyGroup(cmd)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	startTime := time.Now()
	err := cmd.Run()
	endTime := time.Now()

	exitCode := 0
	if err != nil {
		// Check context timeout FIRST — exec.CommandContext kills the process and
		// returns *exec.ExitError(-1), so ctx.Err() must be checked before ExitError.
		// Use exit code 124 — GNU timeout standard.
		if ctx.Err() != nil {
			exitCode = 124
			stderr.WriteString(fmt.Sprintf("command timed out after %s", timeout))
		} else if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = 1
		}
	}

	resp := ExecuteResponse{
		Stdout:    stdout.String(),
		Stderr:    stderr.String(),
		ExitCode:  exitCode,
		Duration:  endTime.Sub(startTime).Seconds(),
		StartTime: startTime.UTC(),
		EndTime:   endTime.UTC(),
	}

	writeJSON(w, http.StatusOK, resp)
}

// handleExecuteStream handles POST /api/execute/stream — SSE streaming execution.
func (s *Server) handleExecuteStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req ExecuteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpError(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}

	if len(req.Command) == 0 {
		httpError(w, "command is required", http.StatusBadRequest)
		return
	}

	log.Info("sandbox.execute",
		"sessionId", r.Header.Get("x-session-id"),
		"timeout", req.Timeout,
		"command", cmdlog.Preview(req.Command, 0),
		"stream", true,
	)

	timeout := 300 * time.Second
	if req.Timeout != "" {
		if d, err := time.ParseDuration(req.Timeout); err == nil {
			timeout = d
		}
	}

	workDir := s.workspace
	if req.WorkingDir != "" {
		abs, err := sanitizePath(s.workspace, req.WorkingDir)
		if err != nil {
			httpError(w, "invalid working_dir: "+err.Error(), http.StatusBadRequest)
			return
		}
		workDir = abs
	}

	// Setup SSE headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	flusher, ok := w.(http.Flusher)
	if !ok {
		httpError(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, req.Command[0], req.Command[1:]...)
	cmd.Dir = workDir
	cmd.Env = s.buildChildEnv(req.Env)
	stripEnvDProxyGroup(cmd)

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		httpError(w, "failed to create stdout pipe: "+err.Error(), http.StatusInternalServerError)
		return
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		httpError(w, "failed to create stderr pipe: "+err.Error(), http.StatusInternalServerError)
		return
	}

	if err := cmd.Start(); err != nil {
		httpError(w, "failed to start command: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Send start event
	sseWrite(w, flusher, "start", map[string]interface{}{"pid": cmd.Process.Pid})

	// Stream stdout and stderr concurrently
	done := make(chan struct{}, 2)

	streamPipe := func(pipe interface{ Read([]byte) (int, error) }, key string) {
		buf := make([]byte, 4096)
		for {
			n, err := pipe.Read(buf)
			if n > 0 {
				sseWrite(w, flusher, "data", map[string]string{key: string(buf[:n])})
			}
			if err != nil {
				break
			}
		}
		done <- struct{}{}
	}

	go streamPipe(stdoutPipe, "stdout")
	go streamPipe(stderrPipe, "stderr")

	// Wait for both streams to finish
	<-done
	<-done

	exitCode := 0
	if err := cmd.Wait(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = 1
		}
	}

	sseWrite(w, flusher, "end", map[string]interface{}{
		"exit_code": exitCode,
		"exited":    true,
		"status":    exitStatusString(exitCode),
	})
}

// buildChildEnv constructs the environment for a child process.
// Inherits the current process env, applies user overrides, and injects
// OPENAI_API_KEY from the policy puller if available (§4.2 unified inference gateway).
func (s *Server) buildChildEnv(userEnv map[string]string) []string {
	env := os.Environ()

	// Inject inference API Key (only if not already set by the user)
	if _, userSet := userEnv["OPENAI_API_KEY"]; !userSet {
		if apiKey := s.inference.getApiKey(); apiKey != "" {
			env = append(env, "OPENAI_API_KEY="+apiKey)
		}
	}

	// Apply user-provided overrides last (highest priority)
	for k, v := range userEnv {
		env = append(env, k+"="+v)
	}

	return env
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func sseWrite(w http.ResponseWriter, f http.Flusher, event string, data interface{}) {
	b, _ := json.Marshal(data)
	_, _ = w.Write([]byte("event: " + event + "\ndata: " + string(b) + "\n\n"))
	f.Flush()
}

func exitStatusString(code int) string {
	if code == 0 {
		return "completed"
	}
	return "failed"
}

// stripEnvDProxyGroup sets the child process's supplementary groups to only
// the primary group, removing EnvDProxyGID so its traffic is subject to
// iptables REDIRECT rules instead of being exempted like EnvD itself.
// Setpgid is required so that background processes started via
// `setsid ... &` inside `sh -c` survive after the parent shell exits;
// without it Go's exec.CommandContext (Go 1.21+) may kill the entire
// process group when the HTTP request context closes.
func stripEnvDProxyGroup(cmd *exec.Cmd) {
	uid := uint32(os.Getuid())
	gid := uint32(os.Getgid())
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setpgid: true,
		Credential: &syscall.Credential{
			Uid:    uid,
			Gid:    gid,
			Groups: []uint32{gid},
		},
	}
}
