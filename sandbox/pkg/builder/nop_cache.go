// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package builder

import (
	"context"
	"time"
)

// NopCache is an ImageCache that never hits and ignores writes.
// Kaniko still has its own layer cache (--cache-repo) when configured.
type NopCache struct{}

// NewNopCache returns a no-op image content-hash cache.
func NewNopCache() *NopCache { return &NopCache{} }

// Get always misses.
func (NopCache) Get(context.Context, string) (string, bool) { return "", false }

// Set is a no-op.
func (NopCache) Set(context.Context, string, string, time.Duration) error { return nil }

// Delete is a no-op.
func (NopCache) Delete(context.Context, string) error { return nil }
