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

// GrantExists reports whether the charged sandbox session is still in the store.
type GrantExists struct {
	store store.Store
}

// NewGrantExists checks sandbox presence through the session store.
func NewGrantExists(st store.Store) GrantExists {
	return GrantExists{store: st}
}

// Exists returns false when the session record is gone.
// A ref without a session id is treated as still present, so reconcile does
// not drop a charge it cannot look up.
func (e GrantExists) Exists(ctx context.Context, ref grant.SandboxRef) (bool, error) {
	if e.store == nil || ref.SessionID == "" {
		return true, nil
	}
	_, err := e.store.GetSandboxBySessionID(ctx, ref.SessionID)
	if errors.Is(err, store.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}
