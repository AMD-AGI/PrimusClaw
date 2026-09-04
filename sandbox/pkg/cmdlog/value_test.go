// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package cmdlog

import (
	"os"
	"strings"
	"testing"
)

func TestValueNeutralizesForgedRecords(t *testing.T) {
	// The attack this exists for: a value that closes the current record and
	// opens a convincing second one. Both halves must survive as text.
	forged := "10.0.0.1\nlevel=ERROR msg=\"admin deleted everything\""
	got := Value(forged)
	if strings.ContainsAny(got, "\n\r") {
		t.Fatalf("a raw line break survived: %q", got)
	}
	if !strings.Contains(got, "<LF>") {
		t.Errorf("the break must be visible as a marker, not dropped: %q", got)
	}
	if strings.Contains(got, `\`) {
		t.Errorf("no backslash may appear: slog's handler escapes backslashes "+
			"again when it quotes, and the escaping compounds per layer: %q", got)
	}
	if !strings.Contains(got, "admin deleted everything") {
		t.Errorf("the value must still be readable, not censored: %q", got)
	}
}

func TestValueEscapesEveryControlByte(t *testing.T) {
	// Newline is the famous one; a bare CR rewrites a line on a terminal and
	// ESC starts a control sequence. The rule is the class, not the example.
	for r := rune(0); r < 0x20; r++ {
		if out := Value(string(r)); strings.ContainsRune(out, r) {
			t.Errorf("control byte %#x survived as itself: %q", r, out)
		}
	}
	if out := Value("\x7f"); strings.Contains(out, "\x7f") {
		t.Errorf("DEL survived as itself: %q", out)
	}
}

func TestValueBoundsLength(t *testing.T) {
	// An unbounded value pushes real records out of a size-capped log, which
	// destroys evidence without ever looking like an attack.
	out := Value(strings.Repeat("a", maxLoggedValueLen*3))
	if len(out) > maxLoggedValueLen+32 {
		t.Errorf("length not bounded: %d bytes", len(out))
	}
	if !strings.Contains(out, "truncated") {
		t.Error("truncation must be visible, or the record reads as complete")
	}
}

func TestErrIsNilSafeAndNeutralizing(t *testing.T) {
	if got := Err(nil); got != "" {
		t.Errorf("nil error must be empty, got %q", got)
	}
	// An error message routinely quotes the input that caused it, so it carries
	// the same bytes -- logging err.Error() raw is the same defect one step
	// removed, and it is the one that survived the first pass at this file.
	got := Err(&quotingError{"parse failed: \n level=ERROR msg=forged"})
	if strings.ContainsAny(got, "\n\r") {
		t.Errorf("a break survived inside an error: %q", got)
	}
}

type quotingError struct{ s string }

func (e *quotingError) Error() string { return e.s }

func TestEscapingUsesTheReplaceShapeCodeQLRecognizes(t *testing.T) {
	// Not a behavioural property: several escapings produce a correct string,
	// so exercising Value cannot catch a change from one to another. It is a
	// dataflow property, and the analyzer is what reads it.
	//
	// CodeQL treats the result of strings.ReplaceAll on "\n" or "\r" as a
	// barrier for log injection, and treats a value rebuilt through a
	// strings.Builder or a strings.Map as still carrying its input's taint --
	// both measured on this tree. A Replacer is not recognised either, which
	// is why CR and LF are handled by ReplaceAll here and everything else is
	// left to the Replacer afterwards: the barrier is established first.
	src, err := os.ReadFile("value.go")
	if err != nil {
		t.Fatalf("read value.go: %v", err)
	}
	body := string(src)
	fn := body[strings.Index(body, "func Value("):]
	fn = fn[:strings.Index(fn, "\n}\n")]

	for _, want := range []string{`strings.ReplaceAll(v, "\n"`, `strings.ReplaceAll(v, "\r"`} {
		if !strings.Contains(fn, want) {
			t.Errorf("Value no longer contains %s; that call is the one shape "+
				"CodeQL recognises as a log-injection barrier", want)
		}
	}
	lines := strings.Split(fn, "\n")
	first := -1
	for n, line := range lines {
		if strings.Contains(line, "strings.ReplaceAll") {
			first = n
			break
		}
	}
	if first < 0 {
		return
	}
	for _, line := range lines[:first] {
		if strings.HasPrefix(line, "\treturn ") {
			t.Errorf("Value returns before the barrier is established: %s",
				strings.TrimSpace(line))
		}
	}
}

// A control byte is not the only way to forge a record. U+2028 LINE SEPARATOR
// is a line break to a great many readers -- JSON string literals, browsers,
// and several log viewers -- so a value carrying one splits its record in the
// places most likely to be reading it. U+202E RIGHT-TO-LEFT OVERRIDE reorders
// the rest of the line visually without changing a byte of it, U+200B hides a
// word boundary, and U+0085 is a newline under Unicode's line-breaking rules.
// None of them is below 0x20, so a guard written against the C0 range alone
// lets all five through.
//
// Written as code points rather than literals: a test for invisible characters
// must not itself contain any, or a reviewer cannot see what it asserts.
func TestValueEscapesTheNonASCIISeparatorsToo(t *testing.T) {
	for name, r := range map[string]rune{
		"U+0085 next line":              0x0085,
		"U+200B zero-width space":       0x200b,
		"U+2028 line separator":         0x2028,
		"U+2029 paragraph separator":    0x2029,
		"U+202E right-to-left override": 0x202e,
	} {
		got := Value("before" + string(r) + "after")
		if strings.ContainsRune(got, r) {
			t.Errorf("%s reached the log as itself: %q", name, got)
		}
		if !strings.Contains(got, "before") || !strings.Contains(got, "after") {
			t.Errorf("%s: escaping swallowed the value around it: %q", name, got)
		}
	}
}

// Printable text must survive readable, or the escaping has made the log worse
// than the injection it prevents. Non-ASCII is ordinary here: namespaces and
// template names carry it.
func TestValueLeavesPrintableTextReadable(t *testing.T) {
	for _, v := range []string{"sandbox-7f3a", "a b c", "10.0.0.1", "命名空间"} {
		if got := Value(v); got != v {
			t.Errorf("Value(%q) = %q, want it unchanged", v, got)
		}
	}
}
