// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package cmdlog

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// maxLoggedValueLen caps a single request-derived value in a log record.
const maxLoggedValueLen = 256

// Value makes a request-derived string safe to place in a log record.
//
// Client IP, session id, user agent, request path, template name, upstream URL
// -- all of these are caller-controlled bytes. A newline in one of them forges
// a second, fully-formed log line, and an unbounded one pushes real records out
// of a size-capped log.
//
// Almost nothing calls this directly. pkg/logx applies it to every string that
// reaches a log record, which is where the decision belongs; this is the
// escaping, not the policy.
//
// # Why markers and not backslash escapes
//
// The obvious escaping is fmt's %q, and it was used here first. It is wrong one
// layer down: slog's handlers quote the values they render, so every backslash
// this function emitted was escaped again on the way out, and a value carrying
// a CRLF reached the log as `\\r\\n`. Preview escaping on top of it made that
// `\\\\\\"` for a quote. Escaping that compounds per layer is how a log stops
// being read.
//
// `<CR>` and `<LF>` carry no backslash, so the handler has nothing to double.
// They also say what was removed, which a space would not: a value that
// contained a newline and one that contained a space are not the same evidence.
//
// The first two substitutions are strings.ReplaceAll on "\n" and "\r"
// specifically. That is not incidental -- it is the one shape CodeQL's
// log-injection query recognises as a barrier, so any caller of this function
// is analyzable without a suppression.
func Value(v string) string {
	v = strings.ReplaceAll(v, "\n", "<LF>")
	v = strings.ReplaceAll(v, "\r", "<CR>")
	v = unsafeRunes.Replace(v)
	if len(v) > maxLoggedValueLen {
		v = cutAtRuneBoundary(v, maxLoggedValueLen) + "...(truncated)"
	}
	return v
}

// Err is Value for an error, and nil-safe: an error's message routinely quotes
// the input that caused it, so it carries the same bytes the value did.
func Err(err error) string {
	if err == nil {
		return ""
	}
	return Value(err.Error())
}

// unsafeRunes replaces what is left after CR and LF: the rest of the C0
// controls, DEL, and the non-ASCII characters that break a line or reorder one
// without being controls at all.
//
// U+2028 ends a line in JSON string literals, in browsers and in several log
// viewers, so it forges a record in the places most likely to be reading one.
// U+0085 is a newline under Unicode's line-breaking rules. U+202A..U+202E
// reorder the rest of the line visually without changing a byte, and U+200B
// hides a word boundary. None of them is below 0x20, so a guard written against
// the C0 range alone -- the obvious way to write one -- lets all of them past.
var unsafeRunes = newUnsafeReplacer()

func newUnsafeReplacer() *strings.Replacer {
	var pairs []string
	named := map[rune]string{
		0x00: "<NUL>", 0x07: "<BEL>", 0x08: "<BS>", 0x09: "<TAB>",
		0x0b: "<VT>", 0x0c: "<FF>", 0x1b: "<ESC>", 0x7f: "<DEL>",
	}
	add := func(r rune) {
		name, ok := named[r]
		if !ok {
			name = fmt.Sprintf("<U+%04X>", r)
		}
		pairs = append(pairs, string(r), name)
	}
	for r := rune(0); r < 0x20; r++ {
		if r == '\n' || r == '\r' { // already replaced, and replacing them
			continue // here instead would not be a recognised barrier
		}
		add(r)
	}
	add(0x7f)
	for _, r := range []rune{0x85, 0x200b, 0x200e, 0x200f, 0x2028, 0x2029,
		0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0xfeff} {
		add(r)
	}
	return strings.NewReplacer(pairs...)
}

// cutAtRuneBoundary returns v shortened to at most limit bytes, backing up to a
// rune boundary so the cut cannot leave half a rune behind.
func cutAtRuneBoundary(v string, limit int) string {
	if len(v) <= limit {
		return v
	}
	for limit > 0 && !utf8.RuneStart(v[limit]) {
		limit--
	}
	return v[:limit]
}
