// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package audit

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"

	"sigs.k8s.io/agent-sandbox/pkg/logx"
)

// TestLogEventWritesDetail checks that the detail carried in metadata reaches the process log.
func TestLogEventWritesDetail(t *testing.T) {
	prev := slog.Default()
	t.Cleanup(func() { slog.SetDefault(prev) })
	var buf bytes.Buffer
	logx.InstallHandler(slog.NewTextHandler(&buf, nil))

	LogEvent(&AuditEvent{
		EventType: EventSandboxDenied,
		Source:    SourceGrant,
		Reason:    "grant_quota_exceeded",
		Metadata:  map[string]string{"detail": "grant gpus: requested 1, in use 1, limit 1"},
	})

	out := buf.String()
	if !strings.Contains(out, "reason=grant_quota_exceeded") {
		t.Fatalf("reason missing: %s", out)
	}
	if !strings.Contains(out, `detail="grant gpus: requested 1, in use 1, limit 1"`) {
		t.Fatalf("detail missing: %s", out)
	}
}
