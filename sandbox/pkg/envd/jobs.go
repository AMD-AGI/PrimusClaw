// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"net/http"
	"strings"
	"sync"
)

const handsBinaryMark = "hands-binary"

type trackedJob struct {
	shimPID int
	hands   bool
}

type jobRegistry struct {
	mu   sync.Mutex
	jobs map[int]trackedJob
}

// newJobRegistry creates an empty per-EnvD job registry.
func newJobRegistry() *jobRegistry {
	return &jobRegistry{jobs: make(map[int]trackedJob)}
}

// isHandsCommand identifies the infrastructure execute that starts Hands.
func isHandsCommand(command []string) bool {
	for _, a := range command {
		if strings.Contains(a, handsBinaryMark) {
			return true
		}
	}
	return false
}

// add records a newly started job shim.
func (r *jobRegistry) add(shimPID int, command []string) {
	if r == nil || shimPID <= 0 {
		return
	}
	r.mu.Lock()
	r.jobs[shimPID] = trackedJob{shimPID: shimPID, hands: isHandsCommand(command)}
	r.mu.Unlock()
}

// remove forgets a shim after all descendants have exited.
func (r *jobRegistry) remove(shimPID int) {
	if r == nil {
		return
	}
	r.mu.Lock()
	delete(r.jobs, shimPID)
	r.mu.Unlock()
}

// userProcessCount returns the number of tracked user processes. A non-Hands
// execute counts as one job because the shim itself proves that tree is live.
func (r *jobRegistry) userProcessCount() (int, error) {
	if r == nil {
		return 0, nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	count := 0
	for _, j := range r.jobs {
		if j.hands {
			n, err := countUserDescendants(j.shimPID)
			if err != nil {
				return 0, err
			}
			count += n
			continue
		}
		// A non-Hands shim exits once its tree is empty, so a live shim is user work.
		count++
	}
	return count, nil
}

// handleJobs reports whether any tracked user task process remains.
func (s *Server) handleJobs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httpError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	count, err := s.jobs.userProcessCount()
	if err != nil {
		httpError(w, "failed to inspect tracked jobs: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, JobsResponse{
		UserProcesses:    count > 0,
		UserProcessCount: count,
	})
}
