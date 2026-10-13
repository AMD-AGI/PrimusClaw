// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"sigs.k8s.io/agent-sandbox/pkg/audit"
	"sigs.k8s.io/agent-sandbox/pkg/envd/egress"
	log "sigs.k8s.io/agent-sandbox/pkg/logx"
)

type internalAuditRequest struct {
	EventType string               `json:"eventType,omitempty"`
	Source    string               `json:"source,omitempty"`
	Action    string               `json:"action,omitempty"`
	Reason    string               `json:"reason,omitempty"`
	Egress    *audit.EgressDetails `json:"egress,omitempty"`
}

// Events wait in held while envd has no Router token Workload Manager accepts:
// before the first proxied request, and after a session has been idle longer
// than a token lives. The next request brings a fresh token, and with it the
// next retry delivers them.
const (
	auditRetryInterval = 30 * time.Second
	maxHeldAuditEvents = 256
)

type egressAuditReporter struct {
	cache  *inferenceKeyCache
	client *http.Client
	queue  chan egress.DecisionEvent
	held   []egress.DecisionEvent // oldest first; touched only by Run
}

func newEgressAuditReporter(cache *inferenceKeyCache) *egressAuditReporter {
	return &egressAuditReporter{
		cache: cache,
		client: &http.Client{
			Timeout: 5 * time.Second,
		},
		queue: make(chan egress.DecisionEvent, 256),
	}
}

func (r *egressAuditReporter) ReportDecision(event egress.DecisionEvent) {
	select {
	case r.queue <- event:
	default:
		log.Warn("egress audit queue full, dropping event", "stage", event.Stage, "action", event.Action)
	}
}

func (r *egressAuditReporter) Run(ctx context.Context) {
	retry := time.NewTicker(auditRetryInterval)
	defer retry.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case event := <-r.queue:
			r.hold(event)
			r.flush(ctx)
		case <-retry.C:
			r.flush(ctx)
		}
	}
}

// hold queues event behind those already waiting, dropping the oldest when full.
func (r *egressAuditReporter) hold(event egress.DecisionEvent) {
	if len(r.held) == maxHeldAuditEvents {
		log.Warn("egress audit: no Router token for Workload Manager, dropping oldest held event",
			"stage", r.held[0].Stage, "action", r.held[0].Action)
		r.held = r.held[1:]
	}
	r.held = append(r.held, event)
}

// flush uploads held events oldest first, stopping at the first one that has to
// wait for a token.
func (r *egressAuditReporter) flush(ctx context.Context) {
	for len(r.held) > 0 && r.send(ctx, r.held[0]) {
		r.held = r.held[1:]
	}
}

// send uploads one event and reports whether it is done with: delivered, or
// failed for a reason retrying would not fix. It is not done while envd holds
// no Router token Workload Manager accepts.
func (r *egressAuditReporter) send(ctx context.Context, event egress.DecisionEvent) bool {
	payload := internalAuditRequest{
		EventType: audit.EventEgress,
		Source:    audit.SourceEgress,
		Action:    event.Action,
		Reason:    event.Reason,
		Egress: &audit.EgressDetails{
			Stage:      event.Stage,
			Domain:     event.Domain,
			OriginalIP: event.OriginalIP,
			ResolvedIP: event.ResolvedIP,
			Port:       event.Port,
			IsTLS:      event.IsTLS,
		},
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return true
	}

	reqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := r.cache.callWM(reqCtx, r.client, http.MethodPost, "audit", bytes.NewReader(body))
	if errors.Is(err, errAwaitingToken) {
		return false
	}
	if err != nil {
		log.Debug("egress audit upload failed", "error", err)
		return true
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return false
	}
	if resp.StatusCode >= 300 {
		log.Debug("egress audit upload returned non-2xx", "status", resp.StatusCode)
	}
	return true
}
