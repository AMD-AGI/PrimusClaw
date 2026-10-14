// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package egress

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/coreos/go-iptables/iptables"
)

// writeFakeIptables writes an executable that answers --version as the given
// iptables build would.
func writeFakeIptables(t *testing.T, path, version string) {
	t.Helper()
	script := "#!/bin/sh\necho '" + version + "'\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Skip("cannot write a stand-in iptables:", err)
	}
}

// The sandbox's PATH puts an image's iptables ahead of the injected one. EnvD
// must still run the injected copy beside it (the test binary stands in for
// envd here), not the image's.
func TestNewIPTablesUsesTheInjectedBinaryOverPATH(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Skip("no executable path:", err)
	}
	beside := filepath.Dir(exe)
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
		injectedTool := filepath.Join(beside, tc.tool)
		writeFakeIptables(t, injectedTool, fmt.Sprintf("%s v1.8.%d (legacy)", tc.tool, tc.patch))
		t.Cleanup(func() { _ = os.Remove(injectedTool) })

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
	imageBin := t.TempDir()
	t.Setenv("PATH", imageBin)
	writeFakeIptables(t, filepath.Join(imageBin, "iptables"), "iptables v1.8.9 (nf_tables)")
	if exe, err := os.Executable(); err == nil {
		if _, err := os.Stat(filepath.Join(filepath.Dir(exe), "iptables")); err == nil {
			t.Skip("an iptables sits beside the test binary")
		}
	}
	ipt, err := newIPTables(iptables.ProtocolIPv4)
	if err != nil {
		t.Fatal(err)
	}
	if major, minor, patch := ipt.GetIptablesVersion(); major != 1 || minor != 8 || patch != 9 {
		t.Fatalf("ran version %d.%d.%d, want PATH's 1.8.9", major, minor, patch)
	}
}
