// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package api

import "testing"

func TestFormatAndParseSandboxID(t *testing.T) {
	t.Parallel()
	id := FormatSandboxID("ns", "sb-1")
	if id != "ns/sb-1" {
		t.Fatalf("FormatSandboxID = %q", id)
	}
	ns, name, ok := ParseSandboxID(id)
	if !ok || ns != "ns" || name != "sb-1" {
		t.Fatalf("ParseSandboxID(%q) = %q, %q, %v", id, ns, name, ok)
	}
}

func TestParseSandboxIDRejectsInvalid(t *testing.T) {
	t.Parallel()
	cases := []string{"", "noslash", "/onlyname", "onlyns/", "a/b/c", "  "}
	for _, in := range cases {
		if _, _, ok := ParseSandboxID(in); ok {
			t.Errorf("ParseSandboxID(%q) ok=true, want false", in)
		}
	}
}
