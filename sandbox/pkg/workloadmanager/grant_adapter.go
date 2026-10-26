// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"errors"

	"sigs.k8s.io/agent-sandbox/pkg/grant"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

// GrantReclaimer deletes the sandbox charged to a grant.
type GrantReclaimer struct {
	server *Server
}

// NewGrantReclaimer reclaims by session id through the Workload Manager delete path.
func NewGrantReclaimer(server *Server) GrantReclaimer {
	return GrantReclaimer{server: server}
}

// Reclaim deletes the sandbox session. A ref without a session id is ignored.
func (r GrantReclaimer) Reclaim(ctx context.Context, ref grant.SandboxRef) error {
	if r.server == nil {
		return nil
	}
	return r.server.ReclaimSession(ctx, ref.SessionID)
}

// GrantExists reports whether the charged sandbox is still present.
// Native sessions resolve through the session store. E2B sessions are SaFE
// Workloads, which that store does not record, so a store miss falls through
// to the Workload.
type GrantExists struct {
	store     store.Store
	workloads *SafeWorkloadCreator
}

// NewGrantExists checks sandbox presence through the session store and,
// for E2B sandboxes, the SaFE Workload named by the session id.
func NewGrantExists(st store.Store, workloads *SafeWorkloadCreator) GrantExists {
	return GrantExists{store: st, workloads: workloads}
}

// Exists returns false when neither the session record nor a live Workload
// remains. A ref without a session id is treated as still present, so
// reconcile does not drop a charge it cannot look up. A store or API error
// is returned so the caller keeps the charge.
func (e GrantExists) Exists(ctx context.Context, ref grant.SandboxRef) (bool, error) {
	if ref.SessionID == "" {
		return true, nil
	}
	if e.store != nil {
		_, err := e.store.GetSandboxBySessionID(ctx, ref.SessionID)
		if err == nil {
			return true, nil
		}
		if !errors.Is(err, store.ErrNotFound) {
			return false, err
		}
	}
	if e.workloads != nil {
		return e.workloads.Present(ctx, ref.SessionID)
	}
	if e.store == nil {
		return true, nil
	}
	return false, nil
}
