// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package audit

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// BackendUp reports whether AUDIT_ENABLED is true. Audit events are written to
// process logs (LogEvent); there is no durable backend to probe at startup.
var BackendUp = promauto.NewGauge(prometheus.GaugeOpts{
	Name: "audit_backend_up",
	Help: "1 if AUDIT_ENABLED (process-log audit sink), 0 otherwise",
})
