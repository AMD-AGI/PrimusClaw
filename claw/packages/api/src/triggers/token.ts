// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The bearer a turn presents to the trigger tools (`triggers/mcp.ts`).
 *
 * It names one turn: the session, the turn's message id and its run. Whose triggers the tools read and write is
 * the owner of that session, asked of the database on every call while the turn is still the live one; nothing a
 * tool call carries can name another user. Minted when the turn's request is finished and never stored.
 */
import { createHmac } from "node:crypto";
import { constantTimeEquals } from "@claw/utils";

export interface TriggerTokenClaims {
  sid: string;
  mid: string;
  task_id: string;
  /** Unix seconds. */
  exp: number;
}

export type TriggerTokenVerdict =
  | { ok: true; claims: TriggerTokenClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

const VERSION = "t1";
/** Mixed into the signed bytes so a signature made for another purpose under the same key proves nothing here. */
const DOMAIN = "claw-trigger-tools-token";
export const MIN_TRIGGER_TOKEN_KEY_LENGTH = 32;

/** Refuse to start with tools nobody could authenticate: they would fail on every call, out of sight. */
export function assertTriggerToolsConfig(enabled: boolean, triggersEnabled: boolean, key: string): void {
  if (!enabled) return;
  if (!triggersEnabled) throw new Error("CLAW_TRIGGER_TOOLS_ENABLED needs CLAW_TRIGGERS_ENABLED");
  if (key.length < MIN_TRIGGER_TOKEN_KEY_LENGTH) {
    throw new Error(`CLAW_TRIGGER_TOOLS_ENABLED needs CLAW_TRIGGER_TOOLS_TOKEN_KEY of at least ${MIN_TRIGGER_TOKEN_KEY_LENGTH} characters`);
  }
}

function sign(key: string, body: string): string {
  return createHmac("sha256", key).update(`${DOMAIN}.${VERSION}.${body}`).digest("base64url");
}

export function mintTriggerToken(claims: TriggerTokenClaims, key: string): string {
  if (!key) throw new Error("trigger tools token key is not configured");
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${VERSION}.${body}.${sign(key, body)}`;
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function verifyTriggerToken(
  presented: string, key: string, nowSeconds: number = Math.floor(Date.now() / 1000),
): TriggerTokenVerdict {
  const parts = presented.split(".");
  if (!key || parts.length !== 3 || parts[0] !== VERSION || !parts[1] || !parts[2]) return { ok: false, reason: "malformed" };
  if (!constantTimeEquals(parts[2], sign(key, parts[1]))) return { ok: false, reason: "bad_signature" };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!raw || typeof raw !== "object" || !nonEmpty(raw.sid) || !nonEmpty(raw.mid) || !nonEmpty(raw.task_id)
      || !Number.isInteger(raw.exp)) {
    return { ok: false, reason: "malformed" };
  }
  if ((raw.exp as number) <= nowSeconds) return { ok: false, reason: "expired" };
  return { ok: true, claims: { sid: raw.sid, mid: raw.mid, task_id: raw.task_id, exp: raw.exp as number } };
}
