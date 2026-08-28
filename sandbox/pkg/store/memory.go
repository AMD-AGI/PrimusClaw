// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package store

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// MemoryStore is an in-memory Store implementation for development and testing.
// It does NOT persist across restarts. Use RedisStore for production.
type MemoryStore struct {
	mu   sync.RWMutex
	data map[string]*SandboxInfo
}

// NewMemoryStore creates a new in-memory store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		data: make(map[string]*SandboxInfo),
	}
}

func (m *MemoryStore) Ping(_ context.Context) error {
	return nil
}

func (m *MemoryStore) GetSandboxBySessionID(_ context.Context, sessionID string) (*SandboxInfo, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	info, ok := m.data[sessionID]
	if !ok {
		return nil, ErrNotFound
	}
	cp := *info
	return &cp, nil
}

func (m *MemoryStore) StoreSandbox(_ context.Context, info *SandboxInfo) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := *info
	m.data[info.SessionID] = &cp
	return nil
}

func (m *MemoryStore) UpdateSandbox(_ context.Context, info *SandboxInfo) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.data[info.SessionID]; !ok {
		return fmt.Errorf("session %q not found", info.SessionID)
	}
	cp := *info
	m.data[info.SessionID] = &cp
	return nil
}

func (m *MemoryStore) DeleteSandboxBySessionID(_ context.Context, sessionID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.data, sessionID)
	return nil
}

func (m *MemoryStore) ListExpiredSandboxes(_ context.Context, before time.Time, limit int64) ([]*SandboxInfo, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var result []*SandboxInfo
	for _, info := range m.data {
		if info.ExpiresAt.Before(before) {
			cp := *info
			result = append(result, &cp)
			if limit > 0 && int64(len(result)) >= limit {
				break
			}
		}
	}
	return result, nil
}

func (m *MemoryStore) ListInactiveSandboxes(_ context.Context, before time.Time, limit int64) ([]*SandboxInfo, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var result []*SandboxInfo
	for _, info := range m.data {
		if info.LastActivity.Before(before) {
			cp := *info
			result = append(result, &cp)
			if limit > 0 && int64(len(result)) >= limit {
				break
			}
		}
	}
	return result, nil
}

func (m *MemoryStore) UpdateSessionLastActivity(_ context.Context, sessionID string, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	info, ok := m.data[sessionID]
	if !ok {
		// Wrapped so callers can tell a missing record from a broken store with
		// errors.Is, the same way GetSandboxBySessionID reports it.
		return fmt.Errorf("session %q: %w", sessionID, ErrNotFound)
	}
	info.LastActivity = at
	return nil
}

func (m *MemoryStore) ListAllSandboxes(_ context.Context, limit int64) ([]*SandboxInfo, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var result []*SandboxInfo
	for _, info := range m.data {
		cp := *info
		result = append(result, &cp)
		if limit > 0 && int64(len(result)) >= limit {
			break
		}
	}
	return result, nil
}

func (m *MemoryStore) Close() error {
	return nil
}
