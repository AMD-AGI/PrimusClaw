// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHandleJobsReportsTrackingLost(t *testing.T) {
	s := &Server{jobs: newJobRegistry(), instanceID: "inst-1", podUID: "pod-1"}
	s.jobs.markLost()
	req := httptest.NewRequest(http.MethodGet, "/api/jobs", nil)
	rec := httptest.NewRecorder()
	s.handleJobs(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d", rec.Code)
	}
	var resp JobsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if !resp.TrackingLost {
		t.Fatal("expected tracking_lost")
	}
	// The count is what it is -- nothing is being tracked -- but the boolean a
	// consumer may read on its own must not answer "idle" for a roster nobody
	// can account for.
	if resp.UserProcessCount != 0 {
		t.Fatalf("count=%d", resp.UserProcessCount)
	}
	if !resp.UserProcesses {
		t.Fatal("lost tracking reported as an idle sandbox")
	}
	if resp.InstanceID != "inst-1" || resp.PodUID != "pod-1" {
		t.Fatalf("identity=%+v", resp)
	}
}

func TestHandleJobsEmptyIsIdleWhenTrackingHolds(t *testing.T) {
	s := &Server{jobs: newJobRegistry(), instanceID: "inst-1"}
	req := httptest.NewRequest(http.MethodGet, "/api/jobs", nil)
	rec := httptest.NewRecorder()
	s.handleJobs(rec, req)
	var resp JobsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.TrackingLost || resp.UserProcesses || resp.UserProcessCount != 0 {
		t.Fatalf("empty registry should be idle: %+v", resp)
	}
}

func TestTrackingLossOutlivesTheJobsThatFollowIt(t *testing.T) {
	// Tracking loss says a supervisor died while descendants were still
	// unaccounted for. Those descendants were re-parented away from every shim,
	// so no later walk can reach them and an empty count stops being evidence of
	// idle -- permanently, because nothing in this registry can ever observe
	// them again.
	//
	// A job starting afterwards says nothing about them. It especially cannot
	// clear the flag, because the Hands restart that a dead supervisor triggers
	// issues ordinary jobs of its own: letting those clear it made the recovery
	// withdraw the only protection the sandbox had left, and the sandbox then
	// read as cleanly idle with the orphans still running.
	r := newJobRegistry()
	r.count = func(int) (int, error) { return 0, nil }
	r.add(10, true)
	r.markLost()
	ordinary := r.add(20, false)
	snap, err := r.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if !snap.lost {
		t.Fatal("an ordinary job cleared a tracking loss it cannot account for")
	}
	r.remove(20, ordinary)
	snap, err = r.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if !snap.lost {
		t.Fatal("tracking loss has to outlast the jobs that ran after it")
	}
}

func TestRemovalMatchesTheJobItWasIssuedFor(t *testing.T) {
	// The kernel may hand a reaped shim's PID to the next one, and a job's
	// removal runs after its process was reaped. Matched on the PID alone, the
	// late removal drops the live job that took the number and the sandbox
	// reads idle with a command still running.
	r := newJobRegistry()
	stale := r.add(7, false)
	r.remove(7, stale)
	current := r.add(7, false)
	r.remove(7, stale)
	snap, err := r.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if snap.count != 1 {
		t.Fatalf("a stale removal dropped the job that reused the pid: %+v", snap)
	}
	r.remove(7, current)
	if snap, err = r.snapshot(); err != nil {
		t.Fatal(err)
	} else if snap.count != 0 {
		t.Fatalf("the job did not leave on its own removal: %+v", snap)
	}
}

func TestLostTrackingIsNotReportedAsAnEmptySandbox(t *testing.T) {
	// user_processes is the field a consumer that reads nothing else acts on.
	// Tracking loss is about descendants nobody can count, so answering "none"
	// hands out a sandbox whose roster cannot be accounted for.
	r := newJobRegistry()
	r.markLost()
	snap, err := r.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if snap.count != 0 || !snap.lost {
		t.Fatalf("expected an empty but lost roster: %+v", snap)
	}
	if !(snap.count > 0 || snap.lost) {
		t.Fatal("user_processes would report a lost roster as an idle sandbox")
	}
}

func TestSnapshotCountsLiveJobsWhileLost(t *testing.T) {
	r := newJobRegistry()
	r.add(42, false)
	r.markLost()
	snap, err := r.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if !snap.lost || snap.count != 1 {
		t.Fatalf("lost live jobs: %+v", snap)
	}
}

func TestExecuteRequestDecodesUntracked(t *testing.T) {
	var req ExecuteRequest
	if err := json.Unmarshal([]byte(`{"command":["true"],"untracked":true}`), &req); err != nil {
		t.Fatal(err)
	}
	if !req.Untracked {
		t.Fatal("untracked must decode")
	}
}

func TestTheRequestDecidesWhatIsHands(t *testing.T) {
	// The caller knows what it is starting, so its word settles the question
	// whatever the script looks like.
	var req ExecuteRequest
	if err := json.Unmarshal(
		[]byte(`{"command":["sh","-c","exec /opt/agent"],"hands":true}`), &req,
	); err != nil {
		t.Fatal(err)
	}
	if !req.Hands || !handsExecute(&req) {
		t.Fatalf("the hands field has to decode and decide: %+v", req)
	}
}

// The launch every bootstrap source ends with, as Brain composes it. A Brain
// predating the `hands` field sends only this, so the text test still has to
// find the supervisor in it -- one that goes unrecognised is counted as user
// work and holds its sandbox open for good.
const handsLaunchScript = `mkdir -p /var/log && chmod 700 /var/log ` +
	`|| { echo "cannot create /var/log" >&2; exit 1; }; ` +
	`: > /var/log/hands.log || { echo "cannot write /var/log/hands.log" >&2; exit 1; }; ` +
	`HANDS_SESSION_ID=sess-1 HANDS_MCP_PORT=9100 setsid /app/hands-binary ` +
	`</dev/null >>/var/log/hands.log 2>&1 & ` +
	`PID=$!; sleep 1; ` +
	`if ! kill -0 $PID 2>/dev/null; then ` +
	`echo "hands-binary at /app/hands-binary crashed immediately" >&2; ` +
	`cat /var/log/hands.log >&2; exit 1; fi; echo started_pid=$PID`

func TestHandsStartsAreRecognisedWithoutTheField(t *testing.T) {
	for _, script := range []string{
		handsLaunchScript,
		// The in-image source probes the binary before launching it.
		`test -x /app/hands-binary && timeout -k 2 20 /app/hands-binary --self-check ` +
			`>/dev/null 2>&1 || { echo "no usable hands-binary at /app/hands-binary" >&2; exit 1; }; ` +
			handsLaunchScript,
		// The download source fetches it first, then launches.
		`curl -fsSL -o /tmp/.hands-binary http://brain/internal/assets/hands-binary ` +
			`|| { echo "hands-binary download failed" >&2; exit 1; }; ` +
			`chmod +x /tmp/.hands-binary; ` +
			`HANDS_SESSION_ID=s setsid /tmp/.hands-binary </dev/null >>/tmp/h.log 2>&1 & PID=$!`,
		// Shapes that also start it.
		`exec -a /tmp/.hands-binary sleep 2`,
		`nohup /app/hands-binary &`,
		`cd /app && ./hands-binary --serve`,
	} {
		if !isHandsCommand([]string{"sh", "-c", script}) {
			t.Errorf("a Hands launch went unrecognised, which holds its sandbox open for good:\n%s", script)
		}
	}
}

func TestUserWorkMentioningHandsIsNotTheSupervisor(t *testing.T) {
	// Excluding user work from the count reports an occupied sandbox as idle and
	// reclaims it under the user. Naming the binary is not starting it.
	for _, script := range []string{
		"cp /tmp/.hands-binary /workspace/x",
		"python train.py --out /data/hands-binary",
		"tar czf backup.tgz /app/hands-binary",
		"ls -l /tmp/.hands-binary",
		"md5sum /app/hands-binary > /tmp/sum",
		`echo "hands-binary at /app/hands-binary crashed immediately"`,
		"curl -fsSL -o /tmp/.hands-binary http://brain/internal/assets/hands-binary",
		// A wrapper named after it is its own program.
		"/opt/run-hands-binary-helper",
		"/usr/local/bin/hands-binary-wrapper --serve",
		// The shape the background_shell feature produces.
		"setsid nohup sleep 300 >/dev/null 2>&1 &",
		"sleep 60 # hands-binary",
	} {
		if isHandsCommand([]string{"sh", "-c", script}) {
			t.Errorf("user work was taken for the Hands supervisor, so its sandbox reads idle:\n%s", script)
		}
	}
}

func TestFinalizeTimedOutCommandReports124(t *testing.T) {
	exitCh := make(chan int, 1)
	exitCh <- -1
	got := finalizeTimedOutCommand(exitCh, func() {})
	if got != 124 {
		t.Fatalf("exit=%d", got)
	}
}
