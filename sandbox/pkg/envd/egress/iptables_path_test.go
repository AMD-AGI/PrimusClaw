// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package egress

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/coreos/go-iptables/iptables"

	"sigs.k8s.io/agent-sandbox/pkg/envd/injected"
)

// writeFakeIptables writes an executable that answers --version as the given
// iptables build would.
func writeFakeIptables(t *testing.T, path, version string) {
	t.Helper()
	script := "#!/bin/sh\necho '" + version + "'\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
}

// injectFrom makes dir the directory envd's injected tools are looked up in,
// for the duration of the test: a directory the test owns, so nothing it
// writes outlives it.
func injectFrom(t *testing.T, dir string) {
	t.Helper()
	prev := injectedPath
	injectedPath = func(tool string) string { return injected.PathIn(dir, tool) }
	t.Cleanup(func() { injectedPath = prev })
}

// The sandbox's PATH puts an image's iptables ahead of the injected one. EnvD
// must still run the injected copy beside it, not the image's.
func TestNewIPTablesUsesTheInjectedBinaryOverPATH(t *testing.T) {
	beside := t.TempDir()
	injectFrom(t, beside)
	imageBin := t.TempDir()
	t.Setenv("PATH", imageBin)

	// Each injected tool answers with its own patch version, so running the
	// IPv4 one for IPv6 shows too.
	for _, tc := range []struct {
		proto iptables.Protocol
		tool  string
		patch int
	}{{iptables.ProtocolIPv4, "iptables", 7}, {iptables.ProtocolIPv6, "ip6tables", 6}} {
		writeFakeIptables(t, filepath.Join(imageBin, tc.tool), tc.tool+" v1.8.9 (nf_tables)")
		writeFakeIptables(t, filepath.Join(beside, tc.tool), fmt.Sprintf("%s v1.8.%d (legacy)", tc.tool, tc.patch))

		ipt, err := newIPTables(tc.proto)
		if err != nil {
			t.Fatalf("%s: %v", tc.tool, err)
		}
		if major, minor, patch := ipt.GetIptablesVersion(); major != 1 || minor != 8 || patch != tc.patch {
			t.Fatalf("%s: ran version %d.%d.%d, want the injected 1.8.%d", tc.tool, major, minor, patch, tc.patch)
		}
	}
}

// Without an injected copy it resolves through PATH, as before.
func TestNewIPTablesFallsBackToPATH(t *testing.T) {
	injectFrom(t, t.TempDir())
	imageBin := t.TempDir()
	t.Setenv("PATH", imageBin)
	writeFakeIptables(t, filepath.Join(imageBin, "iptables"), "iptables v1.8.9 (nf_tables)")
	ipt, err := newIPTables(iptables.ProtocolIPv4)
	if err != nil {
		t.Fatal(err)
	}
	if major, minor, patch := ipt.GetIptablesVersion(); major != 1 || minor != 8 || patch != 9 {
		t.Fatalf("ran version %d.%d.%d, want PATH's 1.8.9", major, minor, patch)
	}
}

// Production looks beside the running envd binary.
func TestInjectedPathIsTheProductionLookup(t *testing.T) {
	if fmt.Sprintf("%p", injectedPath) != fmt.Sprintf("%p", injected.Path) {
		t.Fatal("newIPTables does not look up tools with injected.Path")
	}
}
