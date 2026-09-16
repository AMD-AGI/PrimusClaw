// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"
)

// newEnvDInstanceID identifies this EnvD process for jobs-probe binding.
func newEnvDInstanceID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "envd"
	}
	return hex.EncodeToString(b[:])
}

const handsBinaryMark = "hands-binary"

type trackedJob struct {
	shimPID int
	hands   bool
}

type jobRegistry struct {
	mu   sync.Mutex
	jobs map[int]trackedJob
	lost bool
}

// newJobRegistry creates an empty per-EnvD job registry.
func newJobRegistry() *jobRegistry {
	return &jobRegistry{jobs: make(map[int]trackedJob)}
}

// markLost records that a supervisor died before its tree could be accounted for.
func (r *jobRegistry) markLost() {
	if r == nil {
		return
	}
	r.mu.Lock()
	r.lost = true
	r.mu.Unlock()
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

type jobSnapshot struct {
	count int
	lost  bool
}

// snapshot returns the current user-process count. lost means a supervisor
// exited unexpectedly, so an empty count is not evidence of idle.
func (r *jobRegistry) snapshot() (jobSnapshot, error) {
	if r == nil {
		return jobSnapshot{}, nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.lost {
		return jobSnapshot{lost: true}, nil
	}
	count := 0
	for _, j := range r.jobs {
		if j.hands {
			n, err := countUserDescendants(j.shimPID)
			if err != nil {
				return jobSnapshot{}, err
			}
			count += n
			continue
		}
		// A non-Hands shim exits once its tree is empty, so a live shim is user work.
		count++
	}
	return jobSnapshot{count: count}, nil
}

// handleJobs reports whether any tracked user task process remains.
func (s *Server) handleJobs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httpError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	snap, err := s.jobs.snapshot()
	if err != nil {
		httpError(w, "failed to inspect tracked jobs: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, JobsResponse{
		UserProcesses:    snap.count > 0 && !snap.lost,
		UserProcessCount: snap.count,
		TrackingLost:     snap.lost,
		PodUID:           s.podUID,
		InstanceID:       s.instanceID,
	})
}
