// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"sigs.k8s.io/agent-sandbox/pkg/policy"
)

type allowedInternalUpdater interface {
	SetAllowedInternal([]string) error
}

// PolicySyncer periodically pulls the egress policy from Workload Manager
// and updates the local policy engine when the version changes.
type PolicySyncer struct {
	engine                 *policy.Engine
	allowedInternalUpdater allowedInternalUpdater
	wmURL                  string
	sessionID              string
	jwtToken               string
	interval               time.Duration

	mu             sync.Mutex
	lastVersion    int64
	lastSuccessful *policy.PolicyConfig
}

// NewPolicySyncer creates a syncer that polls WM for policy updates.
func NewPolicySyncer(engine *policy.Engine, updater allowedInternalUpdater, wmURL, sessionID, jwtToken string) *PolicySyncer {
	return &PolicySyncer{
		engine:                 engine,
		allowedInternalUpdater: updater,
		wmURL:                  wmURL,
		sessionID:              sessionID,
		jwtToken:               jwtToken,
		interval:               30 * time.Second,
	}
}

// Run starts the periodic sync loop. Blocks until ctx is cancelled.
func (s *PolicySyncer) Run(ctx context.Context) {
	s.syncOnce(ctx)

	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.syncOnce(ctx)
		}
	}
}

// egressPolicyResponse matches the egress-related fields from WM GET /v1/internal/policy/:sessionId.
type egressPolicyResponse struct {
	RuntimePolicy        string   `json:"runtimePolicy"`
	PolicyMode           string   `json:"policyMode"`
	AllowedEgressHosts   []string `json:"allowedEgressHosts"`
	AllowedInternalHosts []string `json:"allowedInternalHosts"`
	PolicyVersion        int64    `json:"policyVersion"`
}

func (s *PolicySyncer) syncOnce(ctx context.Context) {
	if s.wmURL == "" || s.sessionID == "" {
		return
	}

	endpoint := fmt.Sprintf("%s/v1/internal/policy/%s", s.wmURL, s.sessionID)
	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		slog.Warn("policy_sync: build request failed", "error", err)
		return
	}
	if s.jwtToken != "" {
		req.Header.Set("Authorization", "Bearer "+s.jwtToken)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		slog.Warn("policy_sync: request failed, using last known policy", "error", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		slog.Warn("policy_sync: non-200 response", "status", resp.StatusCode, "body", string(body))
		return
	}

	var pr egressPolicyResponse
	if err := json.NewDecoder(resp.Body).Decode(&pr); err != nil {
		slog.Warn("policy_sync: decode failed", "error", err)
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if pr.PolicyVersion <= s.lastVersion {
		return
	}

	cfg := &policy.PolicyConfig{
		RuntimePolicy:        pr.RuntimePolicy,
		Mode:                 pr.PolicyMode,
		AllowedEgressHosts:   pr.AllowedEgressHosts,
		AllowedInternalHosts: pr.AllowedInternalHosts,
		Version:              pr.PolicyVersion,
	}

	if s.allowedInternalUpdater != nil {
		if err := s.allowedInternalUpdater.SetAllowedInternal(pr.AllowedInternalHosts); err != nil {
			slog.Warn("policy_sync: failed to apply allowedInternalHosts", "error", err)
			return
		}
	}

	s.engine.UpdateConfig(cfg)
	s.lastVersion = pr.PolicyVersion
	s.lastSuccessful = cfg

	slog.Info("policy_sync: updated policy",
		"version", pr.PolicyVersion,
		"runtimePolicy", pr.RuntimePolicy,
		"mode", pr.PolicyMode,
		"egressHosts", len(pr.AllowedEgressHosts),
		"internalHosts", len(pr.AllowedInternalHosts),
	)
}
