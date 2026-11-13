// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package identity

import "time"

type ttlItem[V any] struct {
	value   V
	expires time.Time
}

// TTL is a map that drops expired entries, then one entry, when it is full.
// Callers serialize access. The zero value is ready to use.
type TTL[V any] struct {
	entries map[string]ttlItem[V]
}

// Get returns the value stored for key when it has not expired.
func (t *TTL[V]) Get(key string, now time.Time) (V, bool) {
	var zero V
	if t == nil || t.entries == nil {
		return zero, false
	}
	e, ok := t.entries[key]
	if !ok {
		return zero, false
	}
	if !now.Before(e.expires) {
		delete(t.entries, key)
		return zero, false
	}
	return e.value, true
}

// Put stores value until expires. A new key evicts expired entries, then one entry, when the map is full.
func (t *TTL[V]) Put(key string, value V, expires, now time.Time, max int) {
	if t.entries == nil {
		t.entries = map[string]ttlItem[V]{}
	}
	if _, ok := t.entries[key]; !ok && max > 0 && len(t.entries) >= max {
		for k, old := range t.entries {
			if !now.Before(old.expires) {
				delete(t.entries, k)
			}
		}
		if len(t.entries) >= max {
			for k := range t.entries {
				delete(t.entries, k)
				break
			}
		}
	}
	t.entries[key] = ttlItem[V]{value: value, expires: expires}
}
