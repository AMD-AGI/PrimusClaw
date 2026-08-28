// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"strings"
	"time"
)

// handleSessionCreate handles POST /api/session/create
// Creates a new tmux session and returns its terminal_id.
func (s *Server) handleSessionCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	id := newShortID()
	sessionName := "sandbox-" + id

	cmd := exec.CommandContext(r.Context(), "tmux", "new-session", "-d", "-s", sessionName,
		"-x", fmt.Sprintf("%d", s.tmuxWidth),
		"-y", fmt.Sprintf("%d", s.tmuxHeight),
	)
	cmd.Env = s.buildChildEnv(nil)
	stripEnvDProxyGroup(cmd)
	if out, err := cmd.CombinedOutput(); err != nil {
		httpError(w, "failed to create tmux session: "+string(out), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, SessionCreateResponse{TerminalID: id})
}

// handleSessionExec handles POST /api/session/{id}/exec
// Executes a command inside the tmux session and captures the output.
func (s *Server) handleSessionExec(w http.ResponseWriter, r *http.Request, sessionID string) {
	if r.Method != http.MethodPost {
		httpError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req SessionExecRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpError(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}

	timeout := 30 * time.Second
	if req.Timeout != "" {
		if d, err := time.ParseDuration(req.Timeout); err == nil {
			timeout = d
		}
	}

	sessionName := "sandbox-" + sessionID
	marker := "__EXEC_DONE_" + newShortID() + "__"

	// Build the command with cd if working_dir is provided
	command := req.Command
	if req.WorkingDir != "" {
		abs, err := sanitizePath(s.workspace, req.WorkingDir)
		if err != nil {
			httpError(w, "invalid working_dir: "+err.Error(), http.StatusBadRequest)
			return
		}
		command = fmt.Sprintf("cd %s && %s", abs, command)
	}

	// Send command + marker.
	// The marker is wrapped with a newline prefix so we can distinguish it from
	// the echoed command line. tmux echoes "$ command; printf '\nMARKER\n'" on screen,
	// and then the actual printf output appears on its own line below.
	// We search for "\nMARKER" (line-start match) to find only the real output line,
	// not the marker that appears inside the echoed command string.
	fullCmd := fmt.Sprintf("%s; printf '\\n%s\\n'", command, marker)
	sendKeys := exec.Command("tmux", "send-keys", "-t", sessionName, fullCmd, "Enter")
	if out, err := sendKeys.CombinedOutput(); err != nil {
		httpError(w, "failed to send keys: "+string(out), http.StatusInternalServerError)
		return
	}

	// Poll until we see the marker on its own line in the pane output.
	// Using "\n" + marker ensures we match the real output line, not the echoed command.
	lineMarker := "\n" + marker
	deadline := time.Now().Add(timeout)
	var output string
	exitCode := 0

	for time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)

		// Capture full pane history (not just visible area) to avoid scroll-off issues
		capture := exec.Command("tmux", "capture-pane", "-t", sessionName, "-p", "-S", "-")
		out, err := capture.Output()
		if err != nil {
			continue
		}
		paneContent := string(out)

		// Find marker at line start (skips the marker embedded in the echoed command)
		if idx := strings.Index(paneContent, lineMarker); idx >= 0 {
			before := paneContent[:idx]

			// Pane layout around current command:
			//   $ cmd; printf '\nMARKER\n'    ← command echo (contains cmdSuffix)
			//   actual output line(s)          ← what we want
			//   [blank line from printf '\n']
			//   \nMARKER                       ← lineMarker found at idx
			//
			// Strategy: find the LAST occurrence of cmdSuffix in 'before',
			// then take everything on the lines AFTER that command echo line.
			cmdSuffix := "; printf '\\n" + marker + "\\n'"
			cmdIdx := strings.LastIndex(before, cmdSuffix)
			if cmdIdx >= 0 {
				// Skip past the rest of the command echo line
				rest := before[cmdIdx+len(cmdSuffix):]
				nlIdx := strings.Index(rest, "\n")
				if nlIdx >= 0 {
					output = strings.TrimSpace(rest[nlIdx+1:])
				} else {
					output = strings.TrimSpace(rest)
				}
			} else {
				// Fallback: strip first line (old-style command echo)
				lines := strings.SplitN(strings.TrimSpace(before), "\n", 2)
				if len(lines) > 1 {
					output = strings.TrimSpace(lines[1])
				}
			}
			break
		}
	}

	if !time.Now().Before(deadline) {
		exitCode = -1
		output = "(timeout)"
	}

	writeJSON(w, http.StatusOK, SessionExecResponse{
		Output:   output,
		ExitCode: exitCode,
	})
}

// handleSessionOutput handles GET /api/session/{id}/output
// Returns the current tmux pane content.
func (s *Server) handleSessionOutput(w http.ResponseWriter, r *http.Request, sessionID string) {
	if r.Method != http.MethodGet {
		httpError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	sessionName := "sandbox-" + sessionID
	capture := exec.CommandContext(r.Context(), "tmux", "capture-pane", "-t", sessionName, "-p")
	out, err := capture.Output()
	if err != nil {
		httpError(w, "failed to capture pane: "+err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, SessionOutputResponse{Output: string(out)})
}

// handleSessionDelete handles DELETE /api/session/{id}
// Destroys the tmux session.
func (s *Server) handleSessionDelete(w http.ResponseWriter, r *http.Request, sessionID string) {
	if r.Method != http.MethodDelete {
		httpError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	sessionName := "sandbox-" + sessionID
	cmd := exec.CommandContext(r.Context(), "tmux", "kill-session", "-t", sessionName)
	if out, err := cmd.CombinedOutput(); err != nil {
		httpError(w, "failed to kill session: "+string(out), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// handleTerminalSendKeys handles POST /api/terminal/{id}/send_keys
func (s *Server) handleTerminalSendKeys(w http.ResponseWriter, r *http.Request, sessionID string) {
	if r.Method != http.MethodPost {
		httpError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req SendKeysRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpError(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}

	sessionName := "sandbox-" + sessionID

	for _, key := range req.Keys {
		args := []string{"send-keys", "-t", sessionName}
		// Special key mapping
		switch key {
		case "Enter":
			args = append(args, "", "Enter")
		case "Tab":
			args = append(args, "", "Tab")
		case "Escape":
			args = append(args, "", "Escape")
		case "Up":
			args = append(args, "", "Up")
		case "Down":
			args = append(args, "", "Down")
		case "C-c":
			args = append(args, "C-c")
		case "C-d":
			args = append(args, "C-d")
		default:
			args = append(args, key)
			if !strings.HasPrefix(key, "C-") {
				args = append(args, "") // no Enter for regular text
			}
		}
		cmd := exec.CommandContext(r.Context(), "tmux", args...)
		if _, err := cmd.CombinedOutput(); err != nil {
			// Best-effort; continue
		}
	}

	w.WriteHeader(http.StatusNoContent)
}

// newShortID generates an 8-char random hex ID using crypto/rand.
func newShortID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// handleTerminalScreen handles GET /api/terminal/{id}/screen
func (s *Server) handleTerminalScreen(w http.ResponseWriter, r *http.Request, sessionID string) {
	if r.Method != http.MethodGet {
		httpError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	sessionName := "sandbox-" + sessionID

	// Capture with cursor position
	capture := exec.CommandContext(r.Context(), "tmux", "capture-pane", "-t", sessionName, "-p", "-e")
	out, err := capture.Output()
	if err != nil {
		httpError(w, "failed to capture screen: "+err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, ScreenResponse{
		Content: string(out),
		Width:   s.tmuxWidth,
		Height:  s.tmuxHeight,
	})
}
