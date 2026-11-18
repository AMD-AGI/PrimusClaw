// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package envdversion is the E2B envd version this EnvD serves. The control
// plane reports it as envdVersion when a sandbox is created or connected, and
// the E2B SDKs decide from it which envd features they may use.
package envdversion

// Version is the highest E2B envd version whose SDK-gated features this EnvD
// serves with the semantics the SDK expects. Gates lists every gate the E2B
// SDKs (Python and JS 2.63) apply, and Served says whether this EnvD meets it.
//
// Raising Version unlocks every gate at or below it in the SDK. Do not raise
// it past a gate whose Served is false: the SDK would then call a path that
// does not exist here, or rely on behaviour this EnvD does not have.
const Version = "0.5.2"

// Gate is one envd version check in the E2B SDKs.
type Gate struct {
	Version string
	// Feature is what the SDK enables at or above Version.
	Feature string
	// Served reports whether this EnvD and its control plane serve Feature.
	Served bool
	// Why says how Served was decided.
	Why string
}

// Gates are the E2B SDK envd version gates, oldest first.
var Gates = []Gate{
	{"0.1.0", "create accepted at all (older envd is killed by the SDK)", true,
		"the minimum the SDK accepts"},
	{"0.1.4", "filesystem watch_dir(recursive=True) is attempted instead of refused in the SDK", true,
		"WatchDir is not served at any depth; the call reaches EnvD and fails as unimplemented, the same as a non-recursive watch does today"},
	{"0.1.5", "get_metrics calls GET /sandboxes/{id}/metrics instead of refusing in the SDK", true,
		"the control plane answers 501 unimplemented, so the SDK raises instead of reporting an empty series"},
	{"0.2.4", "get_metrics stops warning that disk metrics are missing", true,
		"same route as 0.1.5; no metrics are reported, the call fails"},
	{"0.3.0", "commands.run(stdin=False) is accepted instead of refused in the SDK", true,
		"Start takes the stdin field; false or omitted starts the command with stdin closed"},
	{"0.4.0", "the SDK stops sending the default user \"user\" (Basic auth header and the files username parameter)", true,
		"EnvD ignores both: commands and file operations always run as the EnvD user, and the Router replaces Authorization with its own token"},
	{"0.5.2", "commands.close_stdin / closeStdin is allowed", true,
		"/process.Process/CloseStdin closes the stdin pipe, which the command reads as EOF"},
	{"0.5.7", "files.write sends application/octet-stream bodies, gzip-compressed with Content-Encoding: gzip when asked", false,
		"/files takes a raw body but does not decode Content-Encoding, so a gzip upload would be stored compressed"},
	{"0.6.2", "files.write with metadata", false, "file metadata is not stored"},
	{"0.6.3", "watch events with entry info", false, "WatchDir is not served"},
	{"0.6.4", "watching network mounts", false, "WatchDir is not served"},
}
