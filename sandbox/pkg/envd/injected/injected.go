// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package injected finds the tools the envd-injector initContainer copies in
// beside envd.
package injected

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// Path returns the copy of tool beside the running envd binary, or tool itself,
// for the caller to resolve through PATH, when there is none.
//
// A sandbox's PATH is the image's with the injector's directory after it, so a
// bare name finds an image's binary of the same name first. That is right for
// the commands envd runs for the workload. It is not right for envd's own
// tools: the injected iptables is the legacy backend that works under Kata,
// where an image's nft-backed one can fail and stop the egress setup.
func Path(tool string) string {
	exe, err := executable()
	if err != nil {
		return tool
	}
	return PathIn(filepath.Dir(exe), tool)
}

// executable is os.Executable; tests point it at a directory of their own
// rather than writing into the one the test binary was built in.
var executable = os.Executable

// PathIn returns dir/tool when it is a regular file this process may execute,
// otherwise tool. The kernel answers for the effective uid and groups, so a
// copy only root may run (0700 root, say) under a non-root image USER falls
// back to PATH rather than being returned only to fail with EACCES.
func PathIn(dir, tool string) string {
	p := filepath.Join(dir, tool)
	fi, err := os.Stat(p)
	if err != nil || !fi.Mode().IsRegular() {
		return tool
	}
	if unix.Faccessat(unix.AT_FDCWD, p, unix.X_OK, unix.AT_EACCESS) != nil {
		return tool
	}
	return p
}
