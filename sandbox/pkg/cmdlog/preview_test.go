// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package cmdlog

import (
	"strings"
	"testing"
)

// Preview does not escape, and that is the contract.
//
// It escaped for a while, and the layer below escaped its output again, and
// slog's handler quoted the result: one quote in a command line reached the log
// as six backslashes. Escaping belongs in exactly one place, and pkg/logx --
// which every caller of Preview logs through -- is that place.
//
// So this pins the boundary rather than the escaping: Preview folds the
// whitespace that would break a record into one line, and leaves every other
// byte for the seam. A control byte surviving here is correct; the same byte
// surviving a logx call is not, and pkg/logx's tests cover that.
func TestPreviewFoldsButDoesNotEscape(t *testing.T) {
	got := Preview([]string{"echo", "a\x1bb"}, 0)
	if !strings.ContainsRune(got, 0x1b) {
		t.Errorf("Preview escaped a control byte; that is logx's job now, and "+
			"doing it here too compounds the escaping: %q", got)
	}
	if strings.Contains(got, `\`) {
		t.Errorf("Preview introduced a backslash: %q", got)
	}
}

// The point of Preview is a readable one-line rendering. Escaping that mangles
// an ordinary command line costs more than it saves.
func TestPreviewKeepsAnOrdinaryCommandLineReadable(t *testing.T) {
	if got, want := Preview([]string{"bash", "-c", "ls -la /tmp"}, 0), `bash -c ls -la /tmp`; got != want {
		t.Errorf("Preview = %q, want %q", got, want)
	}
}

// Newlines still collapse to a space rather than becoming a visible escape:
// argv routinely spans lines, and a heredoc rendered as one line is the whole
// point of a preview.
func TestPreviewFoldsWhitespaceRatherThanEscapingIt(t *testing.T) {
	got := Preview([]string{"sh", "-c", "one\ntwo\tthree"}, 0)
	if strings.Contains(got, `\n`) || strings.Contains(got, `\t`) {
		t.Errorf("Preview escaped whitespace instead of folding it: %q", got)
	}
	if got != "sh -c one two three" {
		t.Errorf("Preview = %q, want %q", got, "sh -c one two three")
	}
}

func TestPreviewBoundsLength(t *testing.T) {
	got := Preview([]string{strings.Repeat("x", 4096)}, 64)
	if len(got) > 64 {
		t.Errorf("Preview returned %d bytes for a limit of 64: %q", len(got), got)
	}
}
