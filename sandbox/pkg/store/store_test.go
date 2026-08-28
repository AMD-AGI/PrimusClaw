// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

// The refresh has nowhere to land without a record, and idle-gc reads the
// timestamp off that record. Reporting success here is how an activity signal
// disappears while every caller believes it landed.
func TestUpdatingActivityOnAMissingSessionIsNotFound(t *testing.T) {
	err := NewMemoryStore().UpdateSessionLastActivity(context.Background(), "sess-gone", time.Now())
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v, want it to wrap ErrNotFound", err)
	}
}

func TestUpdatingActivityOnALiveSessionStores(t *testing.T) {
	st := NewMemoryStore()
	ctx := context.Background()
	if err := st.StoreSandbox(ctx, &SandboxInfo{
		SessionID:    "sess-1",
		LastActivity: time.Now().Add(-time.Hour),
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	at := time.Now().Truncate(time.Second)
	if err := st.UpdateSessionLastActivity(ctx, "sess-1", at); err != nil {
		t.Fatalf("update: %v", err)
	}

	info, err := st.GetSandboxBySessionID(ctx, "sess-1")
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !info.LastActivity.Equal(at) {
		t.Errorf("LastActivity = %s, want %s", info.LastActivity, at)
	}
}
