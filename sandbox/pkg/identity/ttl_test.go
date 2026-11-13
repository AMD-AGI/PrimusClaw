// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package identity

import (
	"testing"
	"time"
)

func TestTTLZeroValueAndNilAreEmpty(t *testing.T) {
	var zero TTL[int]
	if _, ok := zero.Get("k", time.Now()); ok {
		t.Fatal("zero value returned an entry")
	}
	var nilMap *TTL[int]
	if _, ok := nilMap.Get("k", time.Now()); ok {
		t.Fatal("nil map returned an entry")
	}
}

func TestTTLExpiresAtTheDeadline(t *testing.T) {
	var m TTL[string]
	now := time.Unix(1_700_000_000, 0)
	m.Put("k", "v", now.Add(time.Second), now, 0)
	if v, ok := m.Get("k", now.Add(time.Second-time.Nanosecond)); !ok || v != "v" {
		t.Fatalf("before the deadline: %q %v", v, ok)
	}
	if _, ok := m.Get("k", now.Add(time.Second)); ok {
		t.Fatal("returned at the deadline")
	}
	if len(m.entries) != 0 {
		t.Fatal("an expired entry was kept after Get")
	}
}

func TestTTLFullMapDropsExpiredEntriesFirst(t *testing.T) {
	var m TTL[int]
	now := time.Unix(1_700_000_000, 0)
	m.Put("old", 1, now.Add(time.Second), now, 2)
	m.Put("live", 2, now.Add(time.Hour), now, 2)
	later := now.Add(time.Minute)
	m.Put("new", 3, later.Add(time.Hour), later, 2)
	if _, ok := m.Get("live", later); !ok {
		t.Fatal("a live entry was dropped while an expired one could go")
	}
	if _, ok := m.Get("new", later); !ok {
		t.Fatal("the new entry was not stored")
	}
	if len(m.entries) != 2 {
		t.Fatalf("entries=%d", len(m.entries))
	}
}

func TestTTLFullMapDropsOneLiveEntry(t *testing.T) {
	var m TTL[int]
	now := time.Unix(1_700_000_000, 0)
	m.Put("a", 1, now.Add(time.Hour), now, 2)
	m.Put("b", 2, now.Add(time.Hour), now, 2)
	m.Put("c", 3, now.Add(time.Hour), now, 2)
	if len(m.entries) != 2 {
		t.Fatalf("entries=%d", len(m.entries))
	}
	if _, ok := m.Get("c", now); !ok {
		t.Fatal("the new entry was not stored")
	}
	m.Put("c", 4, now.Add(time.Hour), now, 2)
	if v, _ := m.Get("c", now); v != 4 || len(m.entries) != 2 {
		t.Fatalf("replacing a key evicted another: v=%d entries=%d", v, len(m.entries))
	}
}
