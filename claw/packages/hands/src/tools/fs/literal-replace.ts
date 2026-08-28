// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Replace the first occurrence of `needle` with `replacement`, treating the
 * replacement as literal text.
 *
 * `String.prototype.replace` gives `$` special meaning in the replacement even
 * when the pattern is a plain string: `$&`, `` $` ``, `$'`, `$$` and `$1`-`$99`
 * expand instead of being inserted. Edit tools carry arbitrary file content, so
 * a replacement containing e.g. `$&` (shell), `$1` (regex, awk) or `$$`
 * (Makefile) would be silently corrupted. A replacer function bypasses all
 * `$` expansion.
 */
export function replaceLiteralOnce(haystack: string, needle: string, replacement: string): string {
  return haystack.replace(needle, () => replacement);
}
