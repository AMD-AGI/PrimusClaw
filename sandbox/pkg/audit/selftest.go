// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package audit

import (
	"context"
	"fmt"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// selfTestSessionID is a reserved session id for the startup round-trip
// check. It never collides with a real sandbox session id (those are always
// "<namespace>/<name>" or a generated sandbox id) and is filtered out of
// QueryByTimeRange results by callers that care, the same way health-check
// traffic is filtered out of request logs.
const selfTestSessionID = "__audit_selftest__"

// BackendUp reports whether AUDIT_ENABLED is true and the backend's startup
// self-check (see SelfCheck) last succeeded. It starts at 0: an audit
// backend that is enabled but has not yet proven it can be written to and
// read back from is not distinguishable from one that is broken, and the
// default must not read as "healthy" before SelfCheck has run.
var BackendUp = promauto.NewGauge(prometheus.GaugeOpts{
	Name: "audit_backend_up",
	Help: "1 if AUDIT_ENABLED and the backend self-check (write+read round trip) last succeeded, 0 otherwise (includes disabled)",
})

// SelfCheck writes one synthetic event and reads it back, to catch at startup
// exactly the failure mode that left L639 unable to tell who deleted a
// Sandbox: AUDIT_ENABLED=true with a store that constructs without error but
// never actually lands writes (wrong DB, a silently-swallowed pipeline error,
// a backend that is reachable but rejects the write for some other reason).
// Store() reporting success is not enough on its own -- the point is to also
// prove the write is readable through the same query path callers use, not
// only that the client call returned nil.
//
// It never blocks startup: the caller decides what to do with a non-nil
// error (log loudly, set BackendUp to 0, and keep serving -- audit is a
// diagnostic subsystem, not a safety interlock, so a Redis hiccup at startup
// must not turn into a control-plane outage of its own).
func SelfCheck(ctx context.Context, store AuditStore) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	probe := &AuditEvent{
		ID:        NewEventID(),
		EventType: EventResourceReport,
		SessionID: selfTestSessionID,
		Timestamp: time.Now(),
		Metadata:  map[string]string{"purpose": "startup-selftest"},
	}
	if err := store.Store(ctx, probe); err != nil {
		return fmt.Errorf("audit selftest: write failed: %w", err)
	}

	events, err := store.QueryBySession(ctx, selfTestSessionID)
	if err != nil {
		return fmt.Errorf("audit selftest: read-back query failed: %w", err)
	}
	for _, e := range events {
		if e.ID == probe.ID {
			return nil
		}
	}
	return fmt.Errorf("audit selftest: wrote event %s but it did not read back "+
		"(wrong DB/key prefix, or the write was silently dropped)", probe.ID)
}
