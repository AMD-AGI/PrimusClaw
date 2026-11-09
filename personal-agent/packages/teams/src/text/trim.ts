// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Trimming a set of characters off either end in one linear scan. (`/x+$/` looks like the same thing, but a regular
 * expression anchored only at its end is tried at every position of a long run that is not at the end: quadratic on
 * text from outside.)
 */

/** `text` without the characters of `chars` at its end (Python's `text.rstrip(chars)`). */
export function stripTrailing(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text.charAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

/** `text` without the characters of `chars` at its start (Python's `text.lstrip(chars)`). */
export function stripLeading(text: string, chars: string): string {
  let start = 0;
  while (start < text.length && chars.includes(text.charAt(start))) start += 1;
  return text.slice(start);
}
