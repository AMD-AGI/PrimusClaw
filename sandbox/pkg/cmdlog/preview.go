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
	if len(out) <= limit {
		return out
	}
	if limit <= 3 {
		return out[:limit]
	}
	return out[:limit-3] + "..."
}
