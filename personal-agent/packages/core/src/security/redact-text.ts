// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Best-effort masking of credential-shaped strings in what is posted to a group chat. In a group everything the model
 * prints reaches every member, and an agent that reads a workload's environment can put API keys into its answer. It is
 * a net, not a guarantee: a secret in a shape it does not know, or split across messages, gets through.
 */
import { pyRegExp } from "../text/py-regex.js";
import { MASK, maskJwts, maskSecretValues } from "./redact-scan.js";

export { MASK };

/**
 * The one line a channel adds to a message it masked (the Python worker's text, byte for byte). Masking an outbound
 * activity or card is the channel's (the Teams package's), with `redactText` and this note.
 */
export const NOTE = "Some sensitive-looking values were hidden. Ask me in a 1:1 chat if you need them.";

/** A rule: the text with what it masks replaced, and whether it masked anything. */
type Rule = (text: string) => { text: string; masked: boolean };

/** `source` is the Python worker's pattern as written there; `pyRegExp` gives it Python's meaning. */
function rule(source: string, flags = ""): Rule {
  const pattern = pyRegExp(source, `g${flags}`);
  return (text) => {
    let hit = false;
    const out = text.replace(pattern, () => {
      hit = true;
      return MASK;
    });
    return { text: out, masked: hit };
  };
}

const RULES: readonly Rule[] = [
  rule(
    String.raw`-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----.*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|\Z)`,
    "s",
  ),
  rule(String.raw`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})`),
  rule(String.raw`\bBearer\s+[A-Za-z0-9._~+/=-]{16,}`, "i"),
  rule(String.raw`\bak-[A-Za-z0-9_-]{16,}`), // platform API keys
  rule(String.raw`\bsk-[A-Za-z0-9_-]{16,}`),
  rule(String.raw`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`),
  rule(String.raw`\bxox[abposr]-[A-Za-z0-9-]{10,}`), // Slack
  rule(String.raw`\bglpat-[A-Za-z0-9_-]{16,}`), // GitLab
  rule(String.raw`\bAIza[A-Za-z0-9_-]{30,}`), // Google API
  rule(String.raw`\bnpm_[A-Za-z0-9]{30,}`), // npm
  rule(String.raw`\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}`), // Stripe
  maskJwts, // JWT: \beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}, scanned (redact-scan.ts)
  // A long opaque value right after a word like token/secret/key/password (NAME=value, "name": "value", name is value),
  // scanned (redact-scan.ts): as a regular expression it backtracks polynomially.
  maskSecretValues,
];

/** `text` with credential-shaped values masked, and whether anything was masked. */
export function redactText(text: string): { text: string; masked: boolean } {
  let masked = false;
  let out = text;
  for (const apply of RULES) {
    const done = apply(out);
    out = done.text;
    masked ||= done.masked;
  }
  return { text: out, masked };
}

// In a log line only: the value of a URL query parameter that is a credential by its name (SharePoint's `tempauth`, an
// Azure SAS `sig`, an OAuth `access_token` or `code`, a signed S3 or GCS link). The value can have any shape, so the name
// decides. Not applied to chat messages, where a link the person shares is their own.
const URL_SECRET_PARAM = pyRegExp(
  String.raw`(?i)([?&](?:tempauth|access_token|id_token|refresh_token|token|code|sig|signature|x-amz-signature|x-amz-credential` +
    String.raw`|x-amz-security-token|x-goog-signature|x-goog-credential)=)([^&#\s"'<>]+)`,
  "g",
);

/** A log line with credential shapes masked, and the values of credential-named URL query parameters. */
export function redactLogLine(text: string): string {
  return redactText(text).text.replace(URL_SECRET_PARAM, (_match: string, name: string) => name + MASK);
}
