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
	if resp.UserProcesses {
		t.Fatal("lost tracking must not look idle-empty as live work")
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

func TestAddAfterEmptyClearsLost(t *testing.T) {
	r := newJobRegistry()
	r.add(1, false)
	r.markLost()
	r.remove(1)
	r.add(2, false)
	snap, err := r.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if snap.lost {
		t.Fatal("lost must clear when tracking resumes on an empty registry")
	}
	if snap.count != 1 {
		t.Fatalf("count=%d", snap.count)
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
