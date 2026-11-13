// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envdversion

import (
	"strconv"
	"strings"
	"testing"
)

func parse(t *testing.T, v string) [3]int {
	t.Helper()
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		t.Fatalf("version %q", v)
	}
	var out [3]int
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			t.Fatalf("version %q: %v", v, err)
		}
		out[i] = n
	}
	return out
}

func less(a, b [3]int) bool {
	for i := range a {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

// Every gate at or below Version is served, and Version is the last gate before
// the first one that is not: the SDK unlocks all of them at once.
func TestVersionUnlocksOnlyServedGates(t *testing.T) {
	if Version != "0.5.2" {
		t.Fatalf("Version=%q", Version)
	}
	v := parse(t, Version)
	var prev [3]int
	lastServed := ""
	firstUnserved := ""
	for i, g := range Gates {
		gv := parse(t, g.Version)
		if i > 0 && !less(prev, gv) {
			t.Fatalf("gates out of order at %s", g.Version)
		}
		prev = gv
		if g.Feature == "" || g.Why == "" {
			t.Fatalf("gate %s has no feature or reason", g.Version)
		}
		if !less(v, gv) && !g.Served {
			t.Fatalf("Version %s unlocks gate %s (%s), which is not served: %s", Version, g.Version, g.Feature, g.Why)
		}
		if g.Served && firstUnserved == "" {
			lastServed = g.Version
		}
		if !g.Served && firstUnserved == "" {
			firstUnserved = g.Version
		}
	}
	if lastServed != Version {
		t.Fatalf("Version=%s, highest served gate before %s is %s", Version, firstUnserved, lastServed)
	}
}
