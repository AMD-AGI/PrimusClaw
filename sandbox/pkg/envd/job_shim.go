// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import "os"

const jobShimArg = "--job-shim"

// MaybeRunJobShim runs the per-execute subreaper when this process was spawned
// as a job shim, then returns true so the caller does not start the HTTP server.
func MaybeRunJobShim() bool {
	if len(os.Args) < 2 || os.Args[1] != jobShimArg {
		return false
	}
	runJobShim()
	return true
}
