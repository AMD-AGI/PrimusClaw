// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// TEMPORARY (W5 until W2 lands): the credential-shape masking of teams_agent/redact.py, which W2 owns. Drop this file and import
// W2's module when its branch is merged.

export const MASK = "[hidden]";

const B64 = "[A-Za-z0-9+/=_-]";
/** (pattern, group to mask; 0 = the whole match) */
const RULES: readonly (readonly [RegExp, number])[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$(?![\s\S]))/g, 0],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, 0],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 0],
  [/\bak-[A-Za-z0-9_-]{16,}/g, 0],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 0],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, 0],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, 0],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, 0],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, 0],
  [/\bnpm_[A-Za-z0-9]{30,}/g, 0],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, 0],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, 0],
  [
    new RegExp(
      `((?:token|secret|api[_-]?key|password|passwd|\\bkey)[\\w-]*["']?\\s*(?::|=|\\bis\\b)\\s*["']?)(?=${B64}*\\d)(?=${B64}*[A-Za-z])(${B64}{32,})`,
      "gi",
    ),
    2,
  ],
];

export interface Redacted {
  readonly text: string;
  readonly masked: boolean;
}

/** `text` with credential-shaped values masked, and whether anything was masked. */
export function redactText(text: string): Redacted {
  let masked = false;
  let out = text;
  for (const [pattern, group] of RULES) {
    out = out.replace(pattern, (...m: unknown[]) => {
      masked = true;
      return group === 0 ? MASK : `${String(m[1])}${MASK}`;
    });
  }
  return { text: out, masked };
}
