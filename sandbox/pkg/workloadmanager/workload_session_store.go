// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"errors"

	"sigs.k8s.io/agent-sandbox/pkg/store"
)

// WorkloadSessionStore resolves an E2B sandbox from its SaFE Workload when the
// wrapped store has no record of the session. All other calls go to the wrapped store.
type WorkloadSessionStore struct {
	store.Store
	workloads *SafeWorkloadCreator
}

// NewWorkloadSessionStore wraps base with a Workload lookup by sandbox id.
func NewWorkloadSessionStore(base store.Store, workloads *SafeWorkloadCreator) *WorkloadSessionStore {
	return &WorkloadSessionStore{Store: base, workloads: workloads}
}

// GetSandboxBySessionID reads the wrapped store, then the Workload named by the session id.
func (s *WorkloadSessionStore) GetSandboxBySessionID(ctx context.Context, sessionID string) (*store.SandboxInfo, error) {
	info, err := s.Store.GetSandboxBySessionID(ctx, sessionID)
	if err == nil || !errors.Is(err, store.ErrNotFound) || s.workloads == nil {
		return info, err
	}
	return s.workloads.Session(ctx, sessionID)
}
