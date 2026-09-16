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
	r.add(1, []string{"sleep", "1"})
	r.markLost()
	r.remove(1)
	r.add(2, []string{"sleep", "1"})
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
	r.add(42, []string{"sleep", "1"})
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

func TestFinalizeTimedOutCommandReports124(t *testing.T) {
	exitCh := make(chan int, 1)
	exitCh <- -1
	got := finalizeTimedOutCommand(exitCh, func() {})
	if got != 124 {
		t.Fatalf("exit=%d", got)
	}
}
