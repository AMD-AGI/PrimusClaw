// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package cmdlog formats command argv values for bounded structured logs.
package cmdlog

import "strings"

const defaultPreviewBytes = 512

// Preview returns a single-line, length-bounded rendering of argv for logs.
func Preview(argv []string, limit int) string {
	if limit <= 0 {
		limit = defaultPreviewBytes
	}
	out := strings.Join(argv, " ")
	out = strings.Map(func(r rune) rune {
		switch r {
		case '\n', '\r', '\t':
			return ' '
		default:
			return r
		}
	}, out)
	out = strings.Join(strings.Fields(out), " ")

	// Folding rather than escaping is deliberate: argv routinely spans lines,
	// and rendering a heredoc on one line is the whole point of a preview.
	//
	// Nothing else is escaped here. Everything that logs a Preview logs it
	// through pkg/logx, which escapes every string it is given, and doing it
	// in both places is worse than doing it in neither: this function escaped
	// its own output for a while, logx escaped that, and slog's handler quoted
	// the result, so one quote in a command line reached the log as six
	// backslashes and a quote.

	if len(out) <= limit {
		return out
	}
	if limit <= 3 {
		return cutAtRuneBoundary(out, limit)
	}
	return cutAtRuneBoundary(out, limit-3) + "..."
}
