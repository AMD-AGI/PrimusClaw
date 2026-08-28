// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { ClawTaskRow } from "../tasks/types.js";
import { isSensitiveKey, redactSecrets } from "@claw/utils";

/**
 * Deep-copy a JSON-compatible value while masking credential-bearing fields.
 *
 * `isSensitiveKey` is shared with brain's `redactPersistedEvent`, which masks
 * the same agent-loop events on their way into NATS. This pass is not
 * redundant with it: `sanitizeSessionEvent` runs it again on the way out, and
 * it also covers payloads brain never saw (task rows, workbench input).
 */
export function redactPublicJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPublicJson);
  if (typeof value === "string") {
    return redactSecrets(value).text.replace(
      /(Bearer\s+)[^\s"',;]+/gi,
      "$1<redacted>",
    );
  }
  if (!value || typeof value !== "object") return value;

  const safe: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // An absent value has nothing to leak, and replacing it would turn a null
    // a client tests for into a string. Matches brain's redactValue.
    const empty = child === null || child === undefined || child === "";
    safe[key] = isSensitiveKey(key) && !empty ? "[REDACTED]" : redactPublicJson(child);
  }
  return safe;
}

export function publicSessionRow(row: Record<string, unknown>): Record<string, unknown> {
  const {
    brain_id: _brainId,
    hands_id: _handsId,
    brain_url: _brainUrl,
    hands_url: _handsUrl,
    ...publicFields
  } = row;
  return redactPublicJson(publicFields) as Record<string, unknown>;
}

export type PublicTaskRow = Omit<
  ClawTaskRow,
  "internal_token_hash" | "callback_url" | "backend_mcp_url"
>;

export function publicTaskRow(row: ClawTaskRow): PublicTaskRow {
  const {
    internal_token_hash: _internalTokenHash,
    callback_url: _callbackUrl,
    backend_mcp_url: _backendMcpUrl,
    ...publicFields
  } = row;
  return redactPublicJson(publicFields) as PublicTaskRow;
}
