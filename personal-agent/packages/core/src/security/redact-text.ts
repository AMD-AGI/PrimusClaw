// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Best-effort masking of credential-shaped strings in what is posted to a group chat. In a group everything the model
 * prints reaches every member, and an agent that reads a workload's environment can put API keys into its answer. It is
 * a net, not a guarantee: a secret in a shape it does not know, or split across messages, gets through.
 */
import { B_END, B_START, S, W } from "./py-regex.js";

/** What a masked value is replaced with. */
export const MASK = "[hidden]";

/**
 * The one line a channel adds to a message it masked (the Python worker's text, byte for byte). Masking an outbound
 * activity or card is the channel's (the Teams package's), with `redactText` and this note.
 */
export const NOTE = "Some sensitive-looking values were hidden. Ask me in a 1:1 chat if you need them.";

/** Under Python's `re.I`, `i` and `I` also match the dotted and dotless i (`İ`, `ı`); JavaScript's `iu` does not. */
const DOTTED_I = "\u0130\u0131";
/** `B64` and the letters `[A-Za-z]` as an `re.I` pattern reads them. */
const B64_I = `[A-Za-z${DOTTED_I}0-9+/=_\\-]`;
const ALPHA_I = `[A-Za-z${DOTTED_I}]`;
/** The letter i in a word an `re.I` pattern matches. */
const I = `[iI${DOTTED_I}]`;

/** A rule: the pattern (global, Unicode) and whether only its last group is masked (else the whole match). */
interface Rule {
  readonly pattern: RegExp;
  readonly lastGroupOnly: boolean;
}

function rule(source: string, flags = "", lastGroupOnly = false): Rule {
  return { pattern: new RegExp(source, `gu${flags}`), lastGroupOnly };
}

const RULES: readonly Rule[] = [
  // A PEM private key block, to its end or, cut off, to the end of the text (Python `re.S` and `\Z`).
  rule("-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)"),
  rule(`${B_START}(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})`),
  rule(`${B_START}Bearer${S}+[A-Za-z${DOTTED_I}0-9._~+/=\\-]{16,}`, "i"),
  rule(`${B_START}ak-[A-Za-z0-9_\\-]{16,}`), // platform API keys
  rule(`${B_START}sk-[A-Za-z0-9_\\-]{16,}`),
  rule(`${B_START}(?:AKIA|ASIA)[A-Z0-9]{16}${B_END}`),
  rule(`${B_START}xox[abposr]-[A-Za-z0-9\\-]{10,}`), // Slack
  rule(`${B_START}glpat-[A-Za-z0-9_\\-]{16,}`), // GitLab
  rule(`${B_START}AIza[A-Za-z0-9_\\-]{30,}`), // Google API
  rule(`${B_START}npm_[A-Za-z0-9]{30,}`), // npm
  rule(`${B_START}[sr]k_(?:live|test)_[A-Za-z0-9]{16,}`), // Stripe
  rule(`${B_START}eyJ[A-Za-z0-9_\\-]{5,}\\.[A-Za-z0-9_\\-]{5,}\\.[A-Za-z0-9_\\-]{5,}`), // JWT
  // A long opaque value right after a word like token/secret/key/password (NAME=value, "name": "value", name is value).
  rule(
    `(?:token|secret|ap${I}[_\\-]?key|password|passwd|${B_START}key)(?:${W}|-)*["']?${S}*` +
      `(?::|=|${B_START}${I}s${B_END})${S}*["']?(?=${B64_I}*\\p{Nd})(?=${B64_I}*${ALPHA_I})(${B64_I}{32,})`,
    "i",
    true,
  ),
];

/** `text` with credential-shaped values masked, and whether anything was masked. */
export function redactText(text: string): { text: string; masked: boolean } {
  let masked = false;
  let out = text;
  for (const { pattern, lastGroupOnly } of RULES) {
    out = out.replace(pattern, (match: string, ...rest: unknown[]) => {
      masked = true;
      if (!lastGroupOnly) return MASK;
      // The value is the pattern's last group and ends the match: what precedes it (the word, `=`, a quote) stays.
      const value = typeof rest[0] === "string" ? rest[0] : "";
      return match.slice(0, match.length - value.length) + MASK;
    });
  }
  return { text: out, masked };
}

// In a log line only: the value of a URL query parameter that is a credential by its name (SharePoint's `tempauth`, an
// Azure SAS `sig`, an OAuth `access_token` or `code`, a signed S3 or GCS link). The value can have any shape, so the name
// decides. Not applied to chat messages, where a link the person shares is their own.
const URL_SECRET_NAMES = [
  "tempauth",
  "access_token",
  "id_token",
  "refresh_token",
  "token",
  "code",
  "sig",
  "signature",
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-security-token",
  "x-goog-signature",
  "x-goog-credential",
]
  .join("|")
  .replaceAll("i", I);
const URL_SECRET_PARAM = new RegExp(`([?&](?:${URL_SECRET_NAMES})=)([^&#${S.slice(1, -1)}"'<>]+)`, "giu");

/** A log line with credential shapes masked, and the values of credential-named URL query parameters. */
export function redactLogLine(text: string): string {
  return redactText(text).text.replace(URL_SECRET_PARAM, (_match: string, name: string) => name + MASK);
}
