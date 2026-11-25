// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Text a machine reported (a conversation's title, a folder, the machine's own name), made inert for a card the user reads as
 * markdown: every character markdown or HTML reads as markup is escaped, and a scheme's "://" is broken so nothing autolinks. A
 * title like "[Confirm](https://x)" is shown as those characters, never as a link or a button-looking word.
 */
export function inertMd(text: string | null | undefined): string {
  return String(text ?? "")
    .replace(/[\\`*_[\]()<>|~]/g, (ch) => `\\${ch}`)
    .replace(/:\/\//g, ":/\u200b/")
    .replace(/\bwww\./gi, (m) => `${m.slice(0, 3)}\u200b.`);
}
