// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"sync"
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

	var stdout, stderr synchronizedBuffer

	startTime := time.Now()
	_, exitCh, stop, err := s.startTrackedCommand(
		req.Command, workDir, s.buildChildEnv(req.Env), &stdout, &stderr,
	)
	exitCode := 0
	if err == nil {
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		select {
		case exitCode = <-exitCh:
		case <-timer.C:
			stop()
			select {
			case exitCode = <-exitCh:
			case <-time.After(time.Second):
				exitCode = 124
			}
			stderr.appendString(fmt.Sprintf("command timed out after %s", timeout))
		case <-r.Context().Done():
			// HTTP cancellation does not stop the tracked tree.
			return
		}
	}
	endTime := time.Now()

	if err != nil {
		exitCode = 1
		stderr.appendString(err.Error())
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

	stream := &sseCommandStream{w: w, flusher: flusher, active: true}
	pid, exitCh, stop, err := s.startTrackedCommand(
		req.Command,
		workDir,
		s.buildChildEnv(req.Env),
		stream.writer("stdout"),
		stream.writer("stderr"),
	)
	if err != nil {
		httpError(w, "failed to start command: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Send start event
	sseWrite(w, flusher, "start", map[string]interface{}{"pid": pid})

	exitCode := 0
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case exitCode = <-exitCh:
	case <-timer.C:
		stop()
		select {
		case exitCode = <-exitCh:
		case <-time.After(time.Second):
			exitCode = 124
		}
	case <-r.Context().Done():
		stream.deactivate()
		return
	}
	stream.deactivate()

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

type synchronizedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

// Write appends command output while permitting detached descendants to drain.
func (b *synchronizedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}

// appendString appends an EnvD-generated error message.
func (b *synchronizedBuffer) appendString(s string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	_, _ = b.b.WriteString(s)
}

// String returns a stable output snapshot.
func (b *synchronizedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}

type sseCommandStream struct {
	mu      sync.Mutex
	w       http.ResponseWriter
	flusher http.Flusher
	active  bool
}

// writer creates one stdout or stderr field writer.
func (s *sseCommandStream) writer(key string) *sseFieldWriter {
	return &sseFieldWriter{stream: s, key: key}
}

// deactivate stops writes after the HTTP response has ended.
func (s *sseCommandStream) deactivate() {
	s.mu.Lock()
	s.active = false
	s.mu.Unlock()
}

type sseFieldWriter struct {
	stream *sseCommandStream
	key    string
}

// Write emits one synchronized SSE data event while the response is active.
func (w *sseFieldWriter) Write(p []byte) (int, error) {
	w.stream.mu.Lock()
	defer w.stream.mu.Unlock()
	if w.stream.active {
		sseWrite(w.stream.w, w.stream.flusher, "data", map[string]string{w.key: string(p)})
	}
	return len(p), nil
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
