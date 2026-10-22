// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"fmt"
	"strings"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

// CRStore implements store.Store by reading Sandbox CRs.
// Writes (Store/Update/Delete) are no-ops: the CR is the source of truth and
// create/delete paths already mutate it through K8sSandboxCreator.
type CRStore struct {
	creator *K8sSandboxCreator
}

// NewCRStore returns a Store backed by Sandbox CRs.
func NewCRStore(creator *K8sSandboxCreator) *CRStore {
	return &CRStore{creator: creator}
}

func (s *CRStore) Ping(ctx context.Context) error {
	if s.creator == nil || s.creator.client == nil {
		return fmt.Errorf("CR store has no Kubernetes client")
	}
	var list sandboxv1alpha1.SandboxList
	return s.creator.client.List(ctx, &list, ctrlclient.Limit(1))
}

func (s *CRStore) GetSandboxBySessionID(ctx context.Context, sessionID string) (*store.SandboxInfo, error) {
	info, err := s.creator.RecoverSessionFromK8s(ctx, sessionID)
	if err != nil {
		if apierrors.IsNotFound(err) || isSandboxNotFound(err) {
			return nil, store.ErrNotFound
		}
		return nil, err
	}
	return info, nil
}

func (s *CRStore) StoreSandbox(context.Context, *store.SandboxInfo) error { return nil }

func (s *CRStore) UpdateSandbox(context.Context, *store.SandboxInfo) error { return nil }

func (s *CRStore) DeleteSandboxBySessionID(context.Context, string) error { return nil }

func (s *CRStore) ListExpiredSandboxes(ctx context.Context, before time.Time, limit int64) ([]*store.SandboxInfo, error) {
	all, err := s.listSandboxInfos(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]*store.SandboxInfo, 0)
	for _, info := range all {
		if info.ExpiresAt.Before(before) {
			out = append(out, info)
			if limit > 0 && int64(len(out)) >= limit {
				break
			}
		}
	}
	return out, nil
}

func (s *CRStore) ListInactiveSandboxes(context.Context, time.Time, int64) ([]*store.SandboxInfo, error) {
	return nil, nil
}

func (s *CRStore) UpdateSessionLastActivity(context.Context, string, time.Time) error {
	return store.ErrNotFound
}

func (s *CRStore) ListAllSandboxes(ctx context.Context, limit int64) ([]*store.SandboxInfo, error) {
	all, err := s.listSandboxInfos(ctx)
	if err != nil {
		return nil, err
	}
	if limit > 0 && int64(len(all)) > limit {
		all = all[:limit]
	}
	return all, nil
}

func (s *CRStore) Close() error { return nil }

func (s *CRStore) listSandboxInfos(ctx context.Context) ([]*store.SandboxInfo, error) {
	var list sandboxv1alpha1.SandboxList
	if err := s.creator.client.List(ctx, &list); err != nil {
		return nil, err
	}
	out := make([]*store.SandboxInfo, 0, len(list.Items))
	for i := range list.Items {
		sb := &list.Items[i]
		info, err := sandboxInfoFromCR(sb)
		if err != nil {
			continue
		}
		out = append(out, info)
	}
	return out, nil
}

func isSandboxNotFound(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "no sandbox found with session-id")
}
