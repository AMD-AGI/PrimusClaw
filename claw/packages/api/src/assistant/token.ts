// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The bearer a Router or Worker turn presents to the assistant MCP service.
 *
 * Minted when the turn is dispatched or claimed (`role-profile.ts`) and never stored on a row, so it carries
 * its own expiry and names the one run it is for. The service still asks the database whether that run is
 * live on every call: the token proves who the turn is, not that the turn is still the current one.
 *
 * HMAC-SHA256 under `CLAW_ASSISTANT_TOKEN_KEY`, not the `<SAFE_API_KEY>` placeholder: a kubernetes/BYOK
 * deployment has no platform key to expand.
 */
import { createHmac } from "node:crypto";
import { constantTimeEquals } from "@claw/utils";

/** `observer`: a turn of a group's or a repository's watcher, whose every tool only records what it would do (`observe.ts`). */
export type AssistantRole = "router" | "worker" | "observer";

export interface AssistantTokenClaims {
  /** The session the turn runs in: the assistant's Router session, an item's Worker session or a scope's observer session. */
  sid: string;
  role: AssistantRole;
  /** Worker only: the item the session works on, and the generation this run started under. */
  item_id?: string;
  gen?: number;
  /** The turn's message id, which is also what the session gate names while the turn holds it. */
  mid: string;
  task_id: string;
  /** Unix seconds. */
  exp: number;
}

export type TokenVerdict =
  | { ok: true; claims: AssistantTokenClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

const VERSION = "a1";
/** Mixed into the signed bytes so a signature made for another purpose under the same key proves nothing here. */
const DOMAIN = "claw-assistant-mcp-token";
export const MIN_TOKEN_KEY_LENGTH = 32;

/**
 * Refuse to start an assistant that could not authenticate its own turns. Without a key every turn would be
 * dispatched with a bearer nobody can check, and the failure would show as a model that mysteriously cannot
 * use its tools. Fatal at boot, where somebody is reading.
 */
export function assertAssistantTokenKey(enabled: boolean, key: string): void {
  if (!enabled) return;
  if (key.length < MIN_TOKEN_KEY_LENGTH) {
    throw new Error(`CLAW_ASSISTANT_ENABLED needs CLAW_ASSISTANT_TOKEN_KEY of at least ${MIN_TOKEN_KEY_LENGTH} characters`);
  }
}

function sign(key: string, body: string): string {
  return createHmac("sha256", key).update(DOMAIN).update(".").update(VERSION).update(".").update(body).digest("base64url");
}

export function mintAssistantToken(claims: AssistantTokenClaims, key: string): string {
  if (!key) throw new Error("assistant token key is not configured");
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${VERSION}.${body}.${sign(key, body)}`;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** The claims a signed token carries, checked as data: a valid signature does not make the JSON well formed. */
function parseClaims(raw: unknown): AssistantTokenClaims | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  if (c.role !== "router" && c.role !== "worker" && c.role !== "observer") return null;
  if (!isNonEmptyString(c.sid) || !isNonEmptyString(c.mid) || !isNonEmptyString(c.task_id)) return null;
  if (!Number.isInteger(c.exp)) return null;
  if (c.role === "worker") {
    if (!isNonEmptyString(c.item_id) || !Number.isInteger(c.gen)) return null;
    return {
      sid: c.sid, role: "worker", item_id: c.item_id, gen: c.gen as number,
      mid: c.mid, task_id: c.task_id, exp: c.exp as number,
    };
  }
  return { sid: c.sid, role: c.role, mid: c.mid, task_id: c.task_id, exp: c.exp as number };
}

export function verifyAssistantToken(
  presented: string, key: string, nowSeconds: number = Math.floor(Date.now() / 1000),
): TokenVerdict {
  const parts = presented.split(".");
  if (!key || parts.length !== 3 || parts[0] !== VERSION || !parts[1] || !parts[2]) {
    return { ok: false, reason: "malformed" };
  }
  if (!constantTimeEquals(parts[2], sign(key, parts[1]))) return { ok: false, reason: "bad_signature" };
  let claims: AssistantTokenClaims | null;
  try {
    claims = parseClaims(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!claims) return { ok: false, reason: "malformed" };
  if (claims.exp <= nowSeconds) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}
