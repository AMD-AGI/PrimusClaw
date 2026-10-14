// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package injected

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestPathInPrefersAnExecutableBesideEnvd(t *testing.T) {
	dir := t.TempDir()
	tool := filepath.Join(dir, "iptables")
	if err := os.WriteFile(tool, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := PathIn(dir, "iptables"); got != tool {
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
		if got := PathIn(dir, name); got != name {
			t.Fatalf("PathIn(%q) = %q, want the bare name", name, got)
		}
	}
}

// Path looks beside the running binary.
func TestPathLooksBesideTheRunningBinary(t *testing.T) {
	dir := t.TempDir()
	prev := executable
	executable = func() (string, error) { return filepath.Join(dir, "envd"), nil }
	t.Cleanup(func() { executable = prev })
	name := "injected-test-tool"
	tool := filepath.Join(dir, name)
	if err := os.WriteFile(tool, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := Path(name); got != tool {
		t.Fatalf("Path = %q, want %q", got, tool)
	}
	if got := Path("not-" + name); got != "not-"+name {
		t.Fatalf("Path of an absent tool = %q, want the bare name", got)
	}
}

// A copy this process may not execute falls back to PATH. The realistic case
// is the injector's copy left 0700 root under a non-root image USER: as root,
// the check runs in a child process as nobody; otherwise the file is one whose
// exec bits all belong to classes other than its owner, this process.
func TestPathInFallsBackWhenThisUIDCannotExecute(t *testing.T) {
	if dir := os.Getenv(notMineDirEnv); dir != "" {
		if got := PathIn(dir, "tool"); got != "tool" {
			t.Fatalf("uid %d: pathIn = %q, want the bare name", os.Geteuid(), got)
		}
		return
	}
	dir := t.TempDir()
	tool := filepath.Join(dir, "tool")
	if os.Geteuid() != 0 {
		if err := os.WriteFile(tool, []byte("#!/bin/sh\n"), 0o611); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(tool, 0o611); err != nil {
			t.Fatal(err)
		}
		if got := PathIn(dir, "tool"); got != "tool" {
			t.Fatalf("pathIn = %q, want the bare name", got)
		}
		return
	}
	if err := os.WriteFile(tool, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	// Let nobody reach the directory, not the file.
	for d := dir; d != filepath.Dir(d) && d != os.TempDir(); d = filepath.Dir(d) {
		if err := os.Chmod(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	exe, err := os.Executable()
	if err != nil {
		t.Skip("no executable path:", err)
	}
	// nobody cannot reach the build cache, so run a copy from the open directory.
	bin, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	child := filepath.Join(dir, "injected.test")
	if err := os.WriteFile(child, bin, 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(child, "-test.run=^TestPathInFallsBackWhenThisUIDCannotExecute$", "-test.count=1")
	cmd.Env = append(os.Environ(), notMineDirEnv+"="+dir)
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 65534, Gid: 65534}}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("as nobody: %v\n%s", err, out)
	} else if !strings.Contains(string(out), "PASS") {
		t.Fatalf("as nobody, the check did not run:\n%s", out)
	}
}

const notMineDirEnv = "INJECTED_TEST_NOT_MINE_DIR"
