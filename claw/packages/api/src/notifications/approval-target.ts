// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What an approval notification says is being approved.
 *
 * The text lands in somebody's chat, so it is built to be read there and to leak
 * nothing: the command (for bash) or the tool's name with its salient inputs
 * (for anything else), with credentials masked FIRST and the length cut AFTER,
 * so a secret that straddles the cut is masked rather than half shown.
 *
 * `redactPublicJson` knows the vendor token shapes, a Bearer header and a URL's
 * userinfo, and masks values under credential-looking keys. A command line
 * carries other shapes that nothing else covers (`GH_TOKEN=abc`, `--token abc`,
 * `curl -u user:pass`), so those are masked here, for this text only.
 */
import { redactPublicJson } from "../events/redaction.js";

/** The longest `approval.target`, ellipsis included. */
export const APPROVAL_TARGET_MAX = 300;
/** More than anyone reads; the masking works on this much, then the text is cut. */
const SCAN_MAX = 20_000;
const MAX_FIELDS = 6;
const VALUE_MAX = 80;

const NAME_WITH_SECRET = /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Za-z0-9_]*)(\s*=\s*)("[^"]*"|'[^']*'|\S+)/gi;
const SECRET_FLAG = /(\s--?(?:token|password|passwd|secret|api[-_]?key|access[-_]?key|auth(?:orization)?|bearer)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi;
const BASIC_AUTH_FLAG = /(\s(?:-u|--user|--proxy-user)(?:=|\s+))("[^":]*:[^"]*"|'[^':]*:[^']*'|[^\s:]+:\S+)/g;
const PASSWORD_FIELD = /(["']?(?:password|passwd|secret|token|api_?key)["']?\s*:\s*)("[^"]*"|'[^']*')/gi;

/** Mask the credential shapes a command line carries. Idempotent. */
export function redactCommandSecrets(text: string): string {
  const shapes = String(redactPublicJson(text) ?? "");
  return shapes
    .replace(NAME_WITH_SECRET, "$1$2<redacted>")
    .replace(SECRET_FLAG, "$1<redacted>")
    .replace(BASIC_AUTH_FLAG, "$1<redacted>")
    .replace(PASSWORD_FIELD, "$1\"<redacted>\"");
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function salientInput(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  // Keys that look like credentials are masked by value, and kept, so the reader
  // sees that one was passed.
  const safe = redactPublicJson(input) as Record<string, unknown>;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(safe)) {
    if (parts.length >= MAX_FIELDS) break;
    if (value === null || value === undefined || value === "") continue;
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    parts.push(`${key}=${clip(oneLine(text), VALUE_MAX)}`);
  }
  return parts.join(" ");
}

/**
 * The redacted, clipped (<= 300 characters) summary of what a held tool call
 * would do: the command for `bash`, otherwise the tool's name and its salient
 * inputs.
 */
export function approvalTarget(tool: unknown, input: unknown): string {
  const name = typeof tool === "string" ? tool : "";
  let raw: string;
  if (name.toLowerCase() === "bash") {
    const command = input && typeof input === "object" ? (input as Record<string, unknown>).command : undefined;
    raw = typeof command === "string" ? command : name;
  } else {
    const salient = salientInput(input);
    raw = salient ? `${name} ${salient}` : name;
  }
  return clip(oneLine(redactCommandSecrets(raw.slice(0, SCAN_MAX))), APPROVAL_TARGET_MAX);
}
