// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The two pairing routes (`pairing.ts`):
 *
 *   POST /v1/remote-agents/pairings        the signed-in person: a new code and the command line that uses it.
 *   POST /v1/remote-agents/pairings/claim  anonymous (the code is the credential): `{code, name}` → `{token}`, once.
 *
 * Every refusal of a claim is the same `invalid_code`. Wrong codes are throttled per client address (only failures count, so a
 * person with a right code is never held back by someone else's wrong ones) and, as a ceiling, per replica. The address is the
 * first `X-Forwarded-For` entry when there is one: behind the ingress `req.ip` is the ingress's own hop, which every caller shares.
 * That entry is the client's say, so a caller can spread its guesses over made-up addresses: what bounds guessing is the code
 * (60 bits, ten minutes, one claim) and the per-replica ceiling, not this key; what this key buys is that nobody else's junk
 * claims can lock a real one out.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pino from "pino";
import { getUser } from "../auth/middleware.js";
import { getAuthMethod } from "../auth/request-credential.js";
import { CONNECTOR_TOKEN_METHOD } from "../auth/connector-token.js";
import { CONNECTOR_GRANT_METHOD } from "../auth/connector-grant.js";
import { CODES_PER_MINUTE, PAIRING_TTL_MS, PairingRateLimited, claimPairing, createPairing, pairCommand, pruneUnboundGrants } from "./pairing.js";

const logger = pino({ name: "remote-agents-pairing" });

export interface PairingRouteOptions {
  /** The Claw API address a connector is told to use (CLAW_PUBLIC_URL by default). */
  publicUrl?: string;
  /** Wrong claims one client address may make per minute. */
  claimsPerMinute?: number;
  /** Wrong claims this replica takes per minute from everyone together. */
  claimFailuresPerMinute?: number;
  /** Codes one person may ask for per minute. */
  codesPerMinute?: number;
}

const CLAIM_PER_MINUTE = 10;
const CLAIM_FAILURES_PER_MINUTE = 600;

/** Failures counted in a fixed one-minute window per key, in this process: `full(key)` before, `count(key)` after a failure. */
function failureWindow(perMinute: number): { full: (key: string, now?: number) => boolean; count: (key: string, now?: number) => void } {
  const seen = new Map<string, { start: number; n: number }>();
  const live = (key: string, now: number) => {
    const w = seen.get(key);
    return w && now - w.start < 60_000 ? w : null;
  };
  return {
    full: (key, now = Date.now()) => (live(key, now)?.n ?? 0) >= perMinute,
    count: (key, now = Date.now()) => {
      if (seen.size > 10_000) for (const [k, v] of seen) if (now - v.start >= 60_000) seen.delete(k);
      const w = live(key, now);
      if (w) w.n += 1; else seen.set(key, { start: now, n: 1 });
    },
  };
}

/** The client's address as the ingress passed it on (the first `X-Forwarded-For` entry), else the socket's. */
export function clientAddress(req: FastifyRequest): string {
  const h = req.headers["x-forwarded-for"];
  const first = (Array.isArray(h) ? h[0] : h)?.split(",")[0]?.trim();
  return first && first.length <= 64 ? first : req.ip;
}

const fail = (reply: FastifyReply, status: number, error: string) => reply.status(status).send({ ok: false, error });

function clientLabel(req: FastifyRequest): string | null {
  const h = req.headers["x-claw-client"];
  const v = Array.isArray(h) ? h[0] : h;
  return typeof v === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(v) ? v : null;
}

export async function registerPairingRoutes(app: FastifyInstance, opts: PairingRouteOptions = {}): Promise<void> {
  const perAddress = failureWindow(opts.claimsPerMinute ?? CLAIM_PER_MINUTE);
  const perReplica = failureWindow(opts.claimFailuresPerMinute ?? CLAIM_FAILURES_PER_MINUTE);
  const server = (opts.publicUrl ?? process.env.CLAW_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");

  app.post("/v1/remote-agents/pairings", async (req, reply) => {
    const owner = getUser(req)?.userId;
    if (!owner || owner === "default") return fail(reply, 403, "remote_agents_require_authenticated_user");
    const method = getAuthMethod(req);
    // A connector cannot mint codes for more connectors.
    if (method === CONNECTOR_TOKEN_METHOD || method === CONNECTOR_GRANT_METHOD) return fail(reply, 403, "connector_token_not_accepted");
    if (!server) return fail(reply, 503, "pairing_unavailable");
    let got: { code: string; expires_at: string };
    try {
      got = await createPairing(owner, clientLabel(req), new Date(), opts.codesPerMinute ?? CODES_PER_MINUTE);
    } catch (err) {
      if (err instanceof PairingRateLimited) return fail(reply, 429, "rate_limited");
      throw err;
    }
    const { code, expires_at } = got;
    return reply.status(201).send({
      ok: true,
      data: { code, expires_at, expires_in: Math.round(PAIRING_TTL_MS / 1000), server, command: pairCommand(server, code) },
    });
  });

  app.post("/v1/remote-agents/pairings/claim", async (req, reply) => {
    const addr = `ip:${clientAddress(req)}`;
    if (perAddress.full(addr) || perReplica.full("all")) return fail(reply, 429, "rate_limited");
    const body = (req.body ?? {}) as { code?: unknown; name?: unknown };
    const out = await claimPairing(body.code, body.name);
    if (!out.ok) {
      perAddress.count(addr);
      perReplica.count("all");
      return fail(reply, 400, out.error);
    }
    logger.info({ owner: out.owner, grantId: out.grantId }, "remote_agents.pairing_claimed");
    return reply.status(201).send({ ok: true, data: { token: out.token, server } });
  });

  // Claimed codes that never registered, and old codes. Hourly on every replica; idempotent.
  const timer = setInterval(() => {
    pruneUnboundGrants().catch((err) => logger.warn({ err: (err as Error)?.message }, "remote_agents.pairing_prune_failed"));
  }, 60 * 60 * 1000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
}
