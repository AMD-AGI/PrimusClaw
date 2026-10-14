// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package injected finds the tools the envd-injector initContainer copies in
// beside envd.
package injected

import (
	"os"
	"path/filepath"
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
	exe, err := os.Executable()
	if err != nil {
		return tool
	}
	return pathIn(filepath.Dir(exe), tool)
}

// pathIn returns dir/tool when it is an executable file, otherwise tool.
func pathIn(dir, tool string) string {
	p := filepath.Join(dir, tool)
	if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() && fi.Mode().Perm()&0o111 != 0 {
		return p
	}
	return tool
}
