// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package e2b

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"sigs.k8s.io/agent-sandbox/pkg/grant"
)

func TestPendingWait(t *testing.T) {
	template := 15 * time.Minute
	cases := []struct {
		raw  string
		want time.Duration
		bad  bool
	}{
		{want: template},
		{raw: "   ", want: template},
		{raw: " 30 ", want: 30 * time.Second},
		{raw: "1", want: time.Second},
		{raw: "86400", want: 24 * time.Hour},
		{raw: "0", bad: true},
		{raw: "-1", bad: true},
		{raw: "86401", bad: true},
		{raw: "1.5", bad: true},
		{raw: "abc", bad: true},
		{raw: "1e3", bad: true},
	}
	for _, tc := range cases {
		t.Run(tc.raw, func(t *testing.T) {
			got, err := pendingWait(template, tc.raw)
			if tc.bad {
				var op *grant.OpError
				if !errors.As(err, &op) || op.Status != 400 || op.Reason != "invalid_sandbox" {
					t.Fatalf("err=%v", err)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("got=%s err=%v", got, err)
			}
		})
	}
}

func TestCreateMetadataOverridesPendingTimeout(t *testing.T) {
	svc, runner, keys := testPlaneWithSpec(t, 600, []int32{1}, 1, `{"pendingTimeoutSec":120}`)
	runner.hold = make(chan struct{})
	_, _, err := svc.Create(context.Background(), keys["measurement"], CreateBody{
		TemplateID: "runner", Timeout: 60,
		Metadata: map[string]string{pendingTimeoutMetadata: "1"},
	})
	var op *grant.OpError
	if !errors.As(err, &op) || op.Status != 503 || op.Reason != "pending_timeout" || !strings.Contains(op.Detail, "pendingTimeoutSec=1") {
		t.Fatalf("create=%v", err)
	}
	refs, err := svc.grants.ListRoleSandboxes(context.Background(), "gr-01jb7m9k2x", "measurement")
	if err != nil || len(refs) != 1 || refs[0].PendingTimeoutSec != 1 {
		t.Fatalf("refs=%+v err=%v", refs, err)
	}
}
