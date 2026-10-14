// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package injected

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPathInPrefersAnExecutableBesideEnvd(t *testing.T) {
	dir := t.TempDir()
	tool := filepath.Join(dir, "iptables")
	if err := os.WriteFile(tool, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := pathIn(dir, "iptables"); got != tool {
		t.Fatalf("pathIn = %q, want %q", got, tool)
	}
}

func TestPathInFallsBackToTheBareName(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "plain"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "adir"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"absent", "plain", "adir"} {
		if got := pathIn(dir, name); got != name {
			t.Fatalf("pathIn(%q) = %q, want the bare name", name, got)
		}
	}
}

// Path looks beside the running binary: here, the test binary.
func TestPathLooksBesideTheRunningBinary(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Skip("no executable path:", err)
	}
	name := "injected-test-tool"
	tool := filepath.Join(filepath.Dir(exe), name)
	if err := os.WriteFile(tool, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Skip("cannot write beside the test binary:", err)
	}
	t.Cleanup(func() { _ = os.Remove(tool) })
	if got := Path(name); got != tool {
		t.Fatalf("Path = %q, want %q", got, tool)
	}
	if got := Path("not-" + name); got != "not-"+name {
		t.Fatalf("Path of an absent tool = %q, want the bare name", got)
	}
}
