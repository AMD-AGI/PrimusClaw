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
	_, exitCh, drained, stop, err := s.startTrackedCommand(
		req.Command, workDir, s.buildChildEnv(req.Env), &stdout, &stderr,
		jobTracking{track: !req.Untracked, hands: handsExecute(&req)},
	)
	exitCode := 0
	if err == nil {
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		select {
		case exitCode = <-exitCh:
		case <-timer.C:
			exitCode = finalizeTimedOutCommand(exitCh, stop)
			stderr.appendString(fmt.Sprintf("command timed out after %s", timeout))
		case <-r.Context().Done():
			// HTTP cancellation does not stop the tracked tree.
			return
		}
		awaitOutputQuiet(drained, func() time.Time {
			out, errOut := stdout.lastWrite(), stderr.lastWrite()
			if errOut.After(out) {
				return errOut
			}
			return out
		})
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
	pid, exitCh, drained, stop, err := s.startTrackedCommand(
		req.Command,
		workDir,
		s.buildChildEnv(req.Env),
		stream.writer("stdout"),
		stream.writer("stderr"),
		jobTracking{track: !req.Untracked, hands: handsExecute(&req)},
	)
	if err != nil {
		httpError(w, "failed to start command: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Send start event
	stream.event("start", map[string]interface{}{"pid": pid})

	exitCode := 0
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case exitCode = <-exitCh:
	case <-timer.C:
		exitCode = finalizeTimedOutCommand(exitCh, stop)
	case <-r.Context().Done():
		stream.deactivate()
		return
	}
	// Let the output the exit status overtook reach the stream before it stops
	// accepting bytes, or the tail of the command is dropped silently.
	awaitOutputQuiet(drained, stream.lastWrite)

	stream.event("end", map[string]interface{}{
		"exit_code": exitCode,
		"exited":    true,
		"status":    exitStatusString(exitCode),
	})
	stream.deactivate()
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

// GNU timeout's documented execute timeout status.
const executeTimeoutExitCode = 124

// How long the output path must stay silent before a response is built from it.
const outputQuietPeriod = 100 * time.Millisecond

// Ceiling on that wait. Descendants the command detached hold the same pipe and
// may keep writing, so neither the drain signal nor silence is guaranteed to
// arrive, and the response has to be bounded regardless.
const outputQuietCeiling = 2 * time.Second

// awaitOutputQuiet resynchronises the exit status with the output it overtook.
//
// The exit status travels on its own descriptor while output travels through a
// pipe and a copy goroutine, so the status routinely overtakes the last bytes
// the command wrote.
//
// `drained` closing is the real answer: it is the point at which the supervisor
// has been reaped and os/exec has joined the copy goroutines, so nothing can
// arrive afterwards. It cannot be waited on alone, because a detached
// descendant inherits the same pipe and holds it open for as long as it runs --
// which is why silence and a ceiling remain underneath it.
//
// Silence is only evidence once something has been written. A buffer that has
// received nothing carries a zero timestamp, and the age of a zero timestamp is
// quiet by any measure; treating that as completion is what answered with an
// exit status and no output.
func awaitOutputQuiet(drained <-chan struct{}, lastWrite func() time.Time) {
	deadline := time.Now().Add(outputQuietCeiling)
	for time.Now().Before(deadline) {
		select {
		case <-drained:
			return
		default:
		}
		if at := lastWrite(); !at.IsZero() && time.Since(at) >= outputQuietPeriod {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// finalizeTimedOutCommand stops the tracked tree and always reports 124,
// including when the shim surfaces SIGKILL as -1.
func finalizeTimedOutCommand(exitCh <-chan int, stop func()) int {
	stop()
	select {
	case <-exitCh:
	case <-time.After(time.Second):
	}
	return executeTimeoutExitCode
}

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
	mu   sync.Mutex
	b    bytes.Buffer
	last time.Time
}

// Write appends command output while permitting detached descendants to drain.
func (b *synchronizedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.last = time.Now()
	return b.b.Write(p)
}

// lastWrite reports when output last arrived, zero where none has.
func (b *synchronizedBuffer) lastWrite() time.Time {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.last
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
	last    time.Time
}

// lastWrite reports when output last arrived, zero where none has.
func (s *sseCommandStream) lastWrite() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.last
}

// writer creates one stdout or stderr field writer.
func (s *sseCommandStream) writer(key string) *sseFieldWriter {
	return &sseFieldWriter{stream: s, key: key}
}

// event emits one SSE event while the response is active. Output arrives from
// the command's copy goroutines, so every write to the ResponseWriter goes
// through here.
func (s *sseCommandStream) event(name string, data interface{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active {
		sseWrite(s.w, s.flusher, name, data)
	}
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
	w.stream.last = time.Now()
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
