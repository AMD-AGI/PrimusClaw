// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The token a turn's tool calls carry. It names one session, its owner (the
 * requester) and the user the session acts as, and is signed with the API's own
 * secret, so the endpoint that serves the tools needs no user credential and the
 * tools cannot be called for a session the token was not minted for.
 *
 * It is not a GitHub credential and opens nothing by itself: every call is
 * checked against the session row again, and every gate runs inside the tool.
 */
import { createHmac } from "node:crypto";
import { constantTimeEquals } from "@claw/utils";

export interface SessionToolClaims {
  sessionId: string;
  requesterUserId: string;
  actorUserId: string;
}

const VERSION = 1;

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(`claw-github-review.v${VERSION}.${body}`).digest("base64url");
}

export function mintSessionToolToken(claims: SessionToolClaims, secret: string, ttlSeconds: number, nowMs: number = Date.now()): string {
  if (!secret) throw new Error("no secret to sign with");
  const body = Buffer.from(JSON.stringify({
    v: VERSION, sid: claims.sessionId, req: claims.requesterUserId, act: claims.actorUserId,
    exp: Math.floor(nowMs / 1000) + ttlSeconds,
  }), "utf8").toString("base64url");
  return `${body}.${sign(secret, body)}`;
}

export type SessionTokenVerdict =
  | { ok: true; claims: SessionToolClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifySessionToolToken(presented: string, secret: string, nowMs: number = Date.now()): SessionTokenVerdict {
  const dot = presented.lastIndexOf(".");
  if (dot <= 0 || !secret) return { ok: false, reason: "malformed" };
  const body = presented.slice(0, dot);
  if (!constantTimeEquals(presented.slice(dot + 1), sign(secret, body))) return { ok: false, reason: "bad_signature" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const p = parsed as Record<string, unknown> | null;
  if (!p || typeof p !== "object" || p.v !== VERSION
      || typeof p.sid !== "string" || !p.sid || typeof p.req !== "string" || !p.req
      || typeof p.act !== "string" || !p.act || typeof p.exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (p.exp * 1000 <= nowMs) return { ok: false, reason: "expired" };
  return { ok: true, claims: { sessionId: p.sid, requesterUserId: p.req, actorUserId: p.act } };
}
