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

// jobTracking says how an execute is accounted for in the job roster.
type jobTracking struct {
	// track registers the execute as a job. Probes and ledger reads leave this
	// false so they cannot make an idle sandbox look busy while they run.
	track bool
	// hands marks the execute that starts the resident Hands supervisor. Its own
	// process is infrastructure, so the roster reports the descendants it spawns
	// instead of counting the supervisor as user work.
	hands bool
}

type jobRegistry struct {
	mu   sync.Mutex
	jobs map[int]trackedJob
	lost bool
	// count resolves a Hands shim to its live user descendants. It is a field
	// so accounting can be exercised against a known tree; the walk it defaults
	// to reads the whole process table of whatever host it runs on.
	count func(shimPID int) (int, error)
}

// newJobRegistry creates an empty per-EnvD job registry.
func newJobRegistry() *jobRegistry {
	return &jobRegistry{jobs: make(map[int]trackedJob), count: countUserDescendants}
}

// markLost records that a supervisor died before its tree could be accounted
// for. It is never unset: the descendants it is about were re-parented away
// from every shim the walk starts at, so nothing this registry can observe will
// ever account for them again, and no later job speaks for them. A sandbox that
// has lost tracking is left to its own timeout rather than reported idle.
func (r *jobRegistry) markLost() {
	if r == nil {
		return
	}
	r.mu.Lock()
	r.lost = true
	r.mu.Unlock()
}

// handsExecute reports whether an execute starts the resident Hands supervisor.
//
// The request says so. The command text is read only when it does not, so that
// a Brain predating the field still has its Hands recognised: a supervisor
// mistaken for user work counts forever and holds its sandbox open for good,
// which is a worse failure than the false positive the text test can produce.
func handsExecute(req *ExecuteRequest) bool {
	return req.Hands || isHandsCommand(req.Command)
}

// Words that run a command given to them, so the command name follows rather
// than being the word itself.
var commandLaunchers = map[string]bool{
	"setsid": true, "nohup": true, "exec": true, "env": true, "command": true,
	"time": true, "timeout": true, "sudo": true, "stdbuf": true, "nice": true,
}

// isCommandOperator reports whether a word ends the current command, making the
// next one a command name again.
func isCommandOperator(w string) bool {
	switch w {
	case ";", "&", "|", "&&", "||", "(", ")", "{", "}",
		"!", "then", "else", "elif", "do", "fi", "done":
		return true
	}
	return false
}

// handsBasename reports whether a path's final element names the Hands binary.
// Hands is deployed under several directories, so the leading path is not part
// of the test.
func handsBasename(path string) bool {
	if i := strings.LastIndexByte(path, '/'); i >= 0 {
		path = path[i+1:]
	}
	return path == handsBinaryMark || path == "."+handsBinaryMark
}

// isHandsCommand identifies the infrastructure execute that starts Hands from
// the command text.
//
// The Hands binary has to appear in a command position -- the start of a
// command, or the target of a launcher like `setsid` -- rather than anywhere in
// the line. Every execute arrives as `sh -c <script>`, so argv[0] is always the
// shell and cannot be the test; but a script that merely mentions the path,
// whether copying it, downloading it or naming it in an error message, is user
// work, and treating that as the supervisor drops it from the count and reports
// an occupied sandbox as idle.
func isHandsCommand(command []string) bool {
	for _, arg := range command {
		if handsStartsIn(arg) {
			return true
		}
	}
	return false
}

// handsStartsIn reports whether a shell line launches the Hands binary.
func handsStartsIn(line string) bool {
	// Until the command name is found, leading environment assignments, options
	// and option values are stepped over: production launches Hands as
	// `VAR=v setsid <bin>` and probes it as `timeout -k 2 <sec> <bin>`.
	seeking := true
	for _, w := range shellWords(line) {
		switch {
		case isCommandOperator(w):
			seeking = true
		case !seeking:
			// An operand of a command already identified.
		case isAssignment(w), strings.HasPrefix(w, "-"), isNumber(w):
			// The command name is still ahead.
		case handsBasename(w):
			return true
		case commandLaunchers[w]:
			// The command name is still ahead.
		default:
			seeking = false
		}
	}
	return false
}

// isAssignment reports whether a word is a leading VAR=value prefix.
func isAssignment(w string) bool {
	i := strings.IndexByte(w, '=')
	return i > 0 && !strings.ContainsAny(w[:i], "/.")
}

// isNumber reports whether a word is a bare integer, as a launcher's timeout is.
func isNumber(w string) bool {
	if w == "" {
		return false
	}
	for i := 0; i < len(w); i++ {
		if w[i] < '0' || w[i] > '9' {
			return false
		}
	}
	return true
}

// shellWords splits a line into words, emitting the operators that separate
// commands as words of their own even when written flush against their
// neighbours, as in `exit 1;` or `sleep 1 & PID=$!`.
func shellWords(line string) []string {
	var out []string
	var cur strings.Builder
	flush := func() {
		if cur.Len() > 0 {
			out = append(out, cur.String())
			cur.Reset()
		}
	}
	for i := 0; i < len(line); i++ {
		c := line[i]
		switch {
		case c == ' ', c == '\t', c == '\n', c == '\r':
			flush()
		case c == ';', c == '&', c == '|', c == '(', c == ')', c == '{', c == '}':
			flush()
			out = append(out, string(c))
		default:
			cur.WriteByte(c)
		}
	}
	flush()
	return out
}

// add records a newly started job shim.
func (r *jobRegistry) add(shimPID int, hands bool) {
	if r == nil || shimPID <= 0 {
		return
	}
	r.mu.Lock()
	r.jobs[shimPID] = trackedJob{shimPID: shimPID, hands: hands}
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
	count := 0
	for _, j := range r.jobs {
		if j.hands {
			n, err := r.count(j.shimPID)
			if err != nil {
				return jobSnapshot{}, err
			}
			count += n
			continue
		}
		// A non-Hands shim exits once its tree is empty, so a live shim is user work.
		count++
	}
	return jobSnapshot{count: count, lost: r.lost}, nil
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
