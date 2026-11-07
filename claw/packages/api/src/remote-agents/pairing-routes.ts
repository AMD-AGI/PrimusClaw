// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The two pairing routes (`pairing.ts`):
 *
 *   POST /v1/remote-agents/pairings        the signed-in person: a new code and the command line that uses it.
 *   POST /v1/remote-agents/pairings/claim  anonymous (the code is the credential): `{code, name}` → `{token}`, once.
 *
 * A claim is throttled per address, and every refusal is the same `invalid_code`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pino from "pino";
import { getUser } from "../auth/middleware.js";
import { getAuthMethod } from "../auth/request-credential.js";
import { CONNECTOR_TOKEN_METHOD } from "../auth/connector-token.js";
import { CONNECTOR_GRANT_METHOD } from "../auth/connector-grant.js";
import { PAIRING_TTL_MS, claimPairing, createPairing, pairCommand, pruneUnboundGrants } from "./pairing.js";

const logger = pino({ name: "remote-agents-pairing" });

export interface PairingRouteOptions {
  /** The Claw API address a connector is told to use (CLAW_PUBLIC_URL by default). */
  publicUrl?: string;
  /** Claims one address may make per minute. */
  claimsPerMinute?: number;
  /** Codes one person may ask for per minute. */
  codesPerMinute?: number;
}

const CLAIM_PER_MINUTE = 10;
const CODES_PER_MINUTE = 6;

/** A fixed one-minute window per key, in this process. Enough against guessing: a code has 60 bits and lives ten minutes. */
function windowLimiter(perMinute: number): (key: string, now?: number) => boolean {
  const seen = new Map<string, { start: number; n: number }>();
  return (key, now = Date.now()) => {
    if (seen.size > 10_000) for (const [k, v] of seen) if (now - v.start >= 60_000) seen.delete(k);
    const w = seen.get(key);
    if (!w || now - w.start >= 60_000) { seen.set(key, { start: now, n: 1 }); return true; }
    w.n += 1;
    return w.n <= perMinute;
  };
}

const fail = (reply: FastifyReply, status: number, error: string) => reply.status(status).send({ ok: false, error });

function clientLabel(req: FastifyRequest): string | null {
  const h = req.headers["x-claw-client"];
  const v = Array.isArray(h) ? h[0] : h;
  return typeof v === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(v) ? v : null;
}

export async function registerPairingRoutes(app: FastifyInstance, opts: PairingRouteOptions = {}): Promise<void> {
  const claimAllowed = windowLimiter(opts.claimsPerMinute ?? CLAIM_PER_MINUTE);
  const codeAllowed = windowLimiter(opts.codesPerMinute ?? CODES_PER_MINUTE);
  const server = (opts.publicUrl ?? process.env.CLAW_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");

  app.post("/v1/remote-agents/pairings", async (req, reply) => {
    const owner = getUser(req)?.userId;
    if (!owner || owner === "default") return fail(reply, 403, "remote_agents_require_authenticated_user");
    const method = getAuthMethod(req);
    // A connector cannot mint codes for more connectors.
    if (method === CONNECTOR_TOKEN_METHOD || method === CONNECTOR_GRANT_METHOD) return fail(reply, 403, "connector_token_not_accepted");
    if (!server) return fail(reply, 503, "pairing_unavailable");
    if (!codeAllowed(owner)) return fail(reply, 429, "rate_limited");
    const { code, expires_at } = await createPairing(owner, clientLabel(req));
    return reply.status(201).send({
      ok: true,
      data: { code, expires_at, expires_in: Math.round(PAIRING_TTL_MS / 1000), server, command: pairCommand(server, code) },
    });
  });

  app.post("/v1/remote-agents/pairings/claim", async (req, reply) => {
    if (!claimAllowed(`ip:${req.ip}`)) return fail(reply, 429, "rate_limited");
    const body = (req.body ?? {}) as { code?: unknown; name?: unknown };
    const out = await claimPairing(body.code, body.name);
    if (!out.ok) return fail(reply, 400, out.error);
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
