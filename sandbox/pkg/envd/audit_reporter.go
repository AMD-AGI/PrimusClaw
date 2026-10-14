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
	"sync"
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

// Events wait in held until Workload Manager has taken them: while envd has no
// Router token WM accepts -- before the first proxied request, and after a
// session has been idle longer than a token lives -- and while WM cannot be
// reached. The next request brings a fresh token and wakes Run to deliver
// them; an unreachable WM is tried again every auditRetryInterval. WM stamps
// an event when it arrives, so each one also carries the time envd observed it.
const (
	maxHeldAuditEvents = 256
	auditRetryInterval = 10 * time.Second
)

type timedDecision struct {
	egress.DecisionEvent
	at  time.Time
	seq uint64
}

// sendResult is what send did with an event.
type sendResult int

const (
	sendDone       sendResult = iota // delivered, or failed for a reason retrying would not fix
	sendAwaitToken                   // WM refused the token, or envd has none yet
	sendRetryLater                   // WM could not be reached or failed
)

type egressAuditReporter struct {
	cache  *inferenceKeyCache
	client *http.Client
	wakeCh chan struct{}

	mu      sync.Mutex
	held    []timedDecision // oldest first
	nextSeq uint64
}

func newEgressAuditReporter(cache *inferenceKeyCache) *egressAuditReporter {
	return &egressAuditReporter{
		cache: cache,
		client: &http.Client{
			Timeout: 5 * time.Second,
		},
		wakeCh: make(chan struct{}, 1),
	}
}

// ReportDecision holds event for Run to upload. It never blocks the proxy, and
// an upload in flight never makes it drop the event: a full hold drops the
// oldest one instead.
func (r *egressAuditReporter) ReportDecision(event egress.DecisionEvent) {
	r.hold(event, time.Now())
	r.wake()
}

// wake tells Run that an event was held, or that a proxied request may have
// brought the token, and the first one the session ID, held events wait for.
func (r *egressAuditReporter) wake() {
	select {
	case r.wakeCh <- struct{}{}:
	default:
	}
}

func (r *egressAuditReporter) Run(ctx context.Context) {
	var retry <-chan time.Time // set while backing off from an unreachable WM
	for {
		select {
		case <-ctx.Done():
			return
		case <-r.wakeCh:
			if retry != nil {
				continue // held; the retry timer flushes
			}
		case <-retry:
			retry = nil
		}
		if r.flush(ctx) == sendRetryLater {
			retry = time.After(auditRetryInterval)
		}
	}
}

// hold queues event behind those already waiting, dropping the oldest when full.
func (r *egressAuditReporter) hold(event egress.DecisionEvent, at time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.held) == maxHeldAuditEvents {
		log.Warn("egress audit: Workload Manager has not taken held events, dropping the oldest",
			"stage", r.held[0].Stage, "action", r.held[0].Action)
		r.held = r.held[1:]
	}
	r.nextSeq++
	r.held = append(r.held, timedDecision{DecisionEvent: event, at: at, seq: r.nextSeq})
}

// heldCount reports how many events are waiting.
func (r *egressAuditReporter) heldCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.held)
}

// flush uploads held events oldest first, stopping at the first one that has to
// wait, and reports why it stopped: sendDone once nothing is held.
func (r *egressAuditReporter) flush(ctx context.Context) sendResult {
	for {
		r.mu.Lock()
		if len(r.held) == 0 {
			r.mu.Unlock()
			return sendDone
		}
		event := r.held[0]
		r.mu.Unlock()

		if result := r.send(ctx, event); result != sendDone {
			return result
		}

		r.mu.Lock()
		if len(r.held) > 0 && r.held[0].seq == event.seq { // hold may have dropped it meanwhile
			r.held = r.held[1:]
		}
		r.mu.Unlock()
	}
}

// send uploads one event and reports what became of it.
func (r *egressAuditReporter) send(ctx context.Context, event timedDecision) sendResult {
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
		Metadata: map[string]string{audit.MetadataObservedAt: event.at.UTC().Format(time.RFC3339Nano)},
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return sendDone
	}

	reqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := r.cache.callWM(reqCtx, r.client, http.MethodPost, "audit", bytes.NewReader(body))
	switch {
	case errors.Is(err, errAwaitingToken):
		return sendAwaitToken
	case errors.Is(err, errNoWM):
		return sendDone
	case err != nil:
		log.Debug("egress audit upload failed, retrying later", "error", err)
		return sendRetryLater
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return sendAwaitToken
	case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500:
		log.Debug("egress audit upload failed, retrying later", "status", resp.StatusCode)
		return sendRetryLater
	case resp.StatusCode >= 300:
		log.Debug("egress audit upload returned non-2xx", "status", resp.StatusCode)
	}
	return sendDone
}
