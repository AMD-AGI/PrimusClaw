// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	"sigs.k8s.io/agent-sandbox/pkg/audit"
)

// TestInternalAuditEventIsStampedWhenObserved: envd holds egress events while
// it cannot reach WM, so an event is stamped with the time envd observed it,
// within bounds, rather than its arrival.
func TestInternalAuditEventIsStampedWhenObserved(t *testing.T) {
	now := time.Date(2026, 1, 2, 3, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name     string
		observed string
		created  time.Time
		want     time.Time
	}{
		{name: "held an hour", observed: "2026-01-02T02:00:00.5Z", want: now.Add(-59*time.Minute - 59*time.Second - 500*time.Millisecond)},
		{name: "other offset", observed: "2026-01-02T04:00:00+02:00", want: now.Add(-time.Hour)},
		{name: "not reported", want: now},
		{name: "unparsable", observed: "an hour ago", want: now},
		{name: "in the future", observed: "2026-01-02T03:00:01Z", want: now},
		{name: "older than a day", observed: "2026-01-01T02:59:59Z", want: now},
		{name: "older than a day, sandbox older still", observed: "2025-12-31T03:00:00Z", created: now.Add(-72 * time.Hour), want: now.Add(-48 * time.Hour)},
		{name: "before the sandbox was created", observed: "2025-12-30T02:59:59Z", created: now.Add(-72 * time.Hour), want: now},
		{name: "within a day, before a recent creation", observed: "2026-01-02T01:00:00Z", created: now.Add(-time.Hour), want: now.Add(-2 * time.Hour)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			metadata := map[string]string{}
			if tc.observed != "" {
				metadata[audit.MetadataObservedAt] = tc.observed
			}
			got := observedTimestamp(metadata, now, tc.created)
			assert.True(t, tc.want.Equal(got), "got %s, want %s", got, tc.want)
			assert.Equal(t, time.UTC, got.Location())
		})
	}
}
