// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Best-effort masking of credential-shaped strings before an event leaves the
 * machine. The same rule set as the chat bot's redactor, so a value hidden there
 * is hidden here. A net, not a guarantee: the server masks again on arrival.
 */
export const MASK = "[hidden]";

const B64 = "[A-Za-z0-9+/=_-]";
const RULES: Array<[RegExp, number]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, 0],
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
  // A long opaque value right after a word like token/secret/key/password.
  [new RegExp(`(?:token|secret|api[_-]?key|password|passwd|\\bkey)[\\w-]*["']?\\s*(?::|=|\\bis\\b)\\s*["']?(?=${B64}*\\d)(?=${B64}*[A-Za-z])(${B64}{32,})`, "gi"), 1],
];

export function redactText(text: string): { text: string; masked: boolean } {
  let masked = false;
  let out = text;
  for (const [re, group] of RULES) {
    out = out.replace(re, (...args: unknown[]) => {
      masked = true;
      const match = args[0] as string;
      if (group === 0) return MASK;
      const value = args[group] as string;
      const at = match.lastIndexOf(value);
      return match.slice(0, at) + MASK + match.slice(at + value.length);
    });
  }
  return { text: out, masked };
}

/** A copy of `value` with every string inside it masked; keys are left alone. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactText(value).text as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}
