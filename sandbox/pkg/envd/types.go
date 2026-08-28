// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import "time"

// ─── Execute ──────────────────────────────────────────────────────────────────

// ExecuteRequest is the body for POST /api/execute and /api/execute/stream.
type ExecuteRequest struct {
	Command    []string          `json:"command"`
	Timeout    string            `json:"timeout,omitempty"` // e.g. "60s"
	WorkingDir string            `json:"working_dir,omitempty"`
	Env        map[string]string `json:"env,omitempty"`
}

// ExecuteResponse is the result of a synchronous execution.
type ExecuteResponse struct {
	Stdout    string    `json:"stdout"`
	Stderr    string    `json:"stderr"`
	ExitCode  int       `json:"exit_code"`
	Duration  float64   `json:"duration"`
	StartTime time.Time `json:"start_time"`
	EndTime   time.Time `json:"end_time"`
}

// ─── Session (tmux) ────────────────────────────────────────────────────────────

// SessionCreateResponse is returned when creating a tmux session.
type SessionCreateResponse struct {
	TerminalID string `json:"terminal_id"`
}

// SessionExecRequest is the body for POST /api/session/{id}/exec.
type SessionExecRequest struct {
	Command    string `json:"command"`
	Timeout    string `json:"timeout,omitempty"`
	WorkingDir string `json:"working_dir,omitempty"`
}

// SessionExecResponse is the result of a session exec.
type SessionExecResponse struct {
	Output   string `json:"output"`
	ExitCode int    `json:"exit_code"`
}

// SessionOutputResponse is the current output from the tmux pane.
type SessionOutputResponse struct {
	Output string `json:"output"`
}

// ─── Terminal (interactive) ────────────────────────────────────────────────────

// SendKeysRequest is the body for POST /api/terminal/{id}/send_keys.
type SendKeysRequest struct {
	Keys []string `json:"keys"`
}

// ScreenResponse is the current terminal screen snapshot.
type ScreenResponse struct {
	Content string `json:"content"`
	CursorX int    `json:"cursor_x"`
	CursorY int    `json:"cursor_y"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
}

// ─── Files ────────────────────────────────────────────────────────────────────

// FileUploadJSONRequest is for JSON-based file uploads.
type FileUploadJSONRequest struct {
	Path    string `json:"path"`
	Content string `json:"content"` // base64-encoded
	Mode    string `json:"mode,omitempty"`
}

// FileInfo describes a single file or directory entry.
type FileInfo struct {
	Name  string `json:"name"`
	Size  int64  `json:"size"`
	Mode  string `json:"mode"`
	IsDir bool   `json:"is_dir"`
	MTime string `json:"mtime,omitempty"`
}

// FileListResponse is the response from GET /api/files?path=.
type FileListResponse struct {
	Files []FileInfo `json:"files"`
}

// ─── GPU ──────────────────────────────────────────────────────────────────────

// GPUDevice describes a single GPU device.
type GPUDevice struct {
	ID          int    `json:"id"`
	Name        string `json:"name"`
	MemoryTotal string `json:"memory_total"`
	MemoryUsed  string `json:"memory_used"`
	Utilization int    `json:"utilization"`
	Temperature int    `json:"temperature"`
}

// GPUStatusResponse is the response from GET /api/gpu/status.
type GPUStatusResponse struct {
	Available   bool        `json:"available"`
	Devices     []GPUDevice `json:"devices"`
	ROCmVersion string      `json:"rocm_version,omitempty"`
}

// ─── Common ───────────────────────────────────────────────────────────────────

// ErrorResponse is a generic error payload.
type ErrorResponse struct {
	Error string `json:"error"`
}
