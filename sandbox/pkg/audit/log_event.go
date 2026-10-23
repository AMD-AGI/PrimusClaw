// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package audit

import (
	"time"

	log "sigs.k8s.io/agent-sandbox/pkg/logx"
)

// LogEvent writes a normalized audit event to the process log.
// This is the production sink when no durable AuditStore is configured.
func LogEvent(event *AuditEvent) {
	if event == nil {
		return
	}
	NormalizeEvent(event)

	args := []any{
		"event_type", event.EventType,
		"source", event.Source,
		"session_id", event.SessionID,
		"sandbox", event.SandboxName,
		"namespace", event.Namespace,
		"event_id", event.ID,
		"timestamp", event.Timestamp.UTC().Format(time.RFC3339Nano),
	}
	if event.UserID != "" {
		args = append(args, "user_id", event.UserID)
	}
	if event.UserName != "" {
		args = append(args, "user_name", event.UserName)
	}
	if event.Action != "" {
		args = append(args, "action", event.Action)
	}
	if event.Reason != "" {
		args = append(args, "reason", event.Reason)
	}
	if event.DeleteReason != "" {
		args = append(args, "delete_reason", event.DeleteReason)
	}
	if event.TemplateName != "" {
		args = append(args, "template", event.TemplateName)
	}
	if event.DurationMs != 0 {
		args = append(args, "duration_ms", event.DurationMs)
	}
	if event.TimeToReadyMs != 0 {
		args = append(args, "time_to_ready_ms", event.TimeToReadyMs)
	}
	if event.Egress != nil {
		args = append(args,
			"egress_stage", event.Egress.Stage,
			"egress_domain", event.Egress.Domain,
			"egress_port", event.Egress.Port,
			"egress_tls", event.Egress.IsTLS,
			"egress_original_ip", event.Egress.OriginalIP,
			"egress_resolved_ip", event.Egress.ResolvedIP,
		)
	}
	log.Info("sandbox.audit", args...)
}
