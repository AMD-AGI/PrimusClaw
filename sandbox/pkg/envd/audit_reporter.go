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
	Metadata  map[string]string    `json:"metadata,omitempty"`
}

// Events wait in held while envd has no Router token Workload Manager accepts:
// before the first proxied request, and after a session has been idle longer
// than a token lives. The next request brings a fresh token and wakes Run to
// deliver them. WM stamps an event when it arrives, so each one also carries
// the time envd observed it.
const maxHeldAuditEvents = 256

type timedDecision struct {
	egress.DecisionEvent
	at time.Time
}

type egressAuditReporter struct {
	cache  *inferenceKeyCache
	client *http.Client
	queue  chan timedDecision
	wakeCh chan struct{}
	held   []timedDecision // oldest first; touched only by Run
}

func newEgressAuditReporter(cache *inferenceKeyCache) *egressAuditReporter {
	return &egressAuditReporter{
		cache: cache,
		client: &http.Client{
			Timeout: 5 * time.Second,
		},
		queue:  make(chan timedDecision, 256),
		wakeCh: make(chan struct{}, 1),
	}
}

func (r *egressAuditReporter) ReportDecision(event egress.DecisionEvent) {
	select {
	case r.queue <- timedDecision{DecisionEvent: event, at: time.Now()}:
	default:
		log.Warn("egress audit queue full, dropping event", "stage", event.Stage, "action", event.Action)
	}
}

// wake tells Run that a proxied request may have brought the token, and the
// first one the session ID, that held events are waiting for.
func (r *egressAuditReporter) wake() {
	select {
	case r.wakeCh <- struct{}{}:
	default:
	}
}

func (r *egressAuditReporter) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case event := <-r.queue:
			r.hold(event)
			r.flush(ctx)
		case <-r.wakeCh:
			r.flush(ctx)
		}
	}
}

// hold queues event behind those already waiting, dropping the oldest when full.
func (r *egressAuditReporter) hold(event timedDecision) {
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
func (r *egressAuditReporter) send(ctx context.Context, event timedDecision) bool {
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
		Metadata: map[string]string{"observedAt": event.at.UTC().Format(time.RFC3339Nano)},
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
