// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"sigs.k8s.io/agent-sandbox/pkg/audit"
	"sigs.k8s.io/agent-sandbox/pkg/envd/egress"
)

type internalAuditRequest struct {
	EventType string               `json:"eventType,omitempty"`
	Source    string               `json:"source,omitempty"`
	Action    string               `json:"action,omitempty"`
	Reason    string               `json:"reason,omitempty"`
	Egress    *audit.EgressDetails `json:"egress,omitempty"`
}

type egressAuditReporter struct {
	cache  *inferenceKeyCache
	client *http.Client
	queue  chan egress.DecisionEvent
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
		slog.Warn("egress audit queue full, dropping event", "stage", event.Stage, "action", event.Action)
	}
}

func (r *egressAuditReporter) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case event := <-r.queue:
			r.send(ctx, event)
		}
	}
}

func (r *egressAuditReporter) send(ctx context.Context, event egress.DecisionEvent) {
	wmURL := r.cache.getWMURL()
	sessionID := r.cache.getSessionID()
	jwtToken := r.cache.getJWTToken()
	if wmURL == "" || sessionID == "" || jwtToken == "" {
		return
	}

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
		return
	}

	reqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(
		reqCtx,
		http.MethodPost,
		fmt.Sprintf("%s/v1/internal/audit/%s", wmURL, sessionID),
		bytes.NewReader(body),
	)
	if err != nil {
		return
	}
	req.Header.Set("Authorization", "Bearer "+jwtToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := r.client.Do(req)
	if err != nil {
		slog.Debug("egress audit upload failed", "error", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		slog.Debug("egress audit upload returned non-2xx", "status", resp.StatusCode)
	}
}
