// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The two pairing routes (`pairing.ts`):
 *
 *   POST /v1/remote-agents/pairings        the signed-in person: a new code and the command line that uses it.
 *   POST /v1/remote-agents/pairings/claim  anonymous (the code is the credential): `{code, name}` → `{token}`, once.
 *
 * Every refusal of a claim is the same `invalid_code`. Wrong claims are throttled per caller, and only failures count, so a person
 * with a right code is never held back by anyone else's wrong ones. The caller is the whole forwarded chain as received together
 * with the socket address (`callerKey`): behind the ingress the socket address alone is the ingress's own hop, which everyone
 * shares, and the first `X-Forwarded-For` entry alone is whatever the caller wrote. A proxy that appends puts the caller's real
 * address at the end of the chain and one that overwrites leaves only it, so nobody can make their key another caller's. A caller
 * can make up new keys by varying the entries it writes, so what this process spends on claims is bounded apart from the keys:
 * the table of keys holds at most {@link MAX_CALLERS} (the oldest go first), and at most {@link CLAIM_CONCURRENCY} claims reach the
 * database at once, with at most {@link CLAIM_QUEUE} waiting; beyond that a claim is answered `503 busy`, which passes once the
 * flood does. What bounds guessing is the code (60 bits, ten minutes, one claim).
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
  /** Wrong claims one caller may make per minute. */
  claimsPerMinute?: number;
  /** Claims that reach the database at once, and claims that may wait for that. */
  claimConcurrency?: number;
  claimQueue?: number;
  /** Codes one person may ask for per minute. */
  codesPerMinute?: number;
  /**
   * Start the hourly prune here (`startPairingPrune`). Defaults to true; `routes/remote-agents.ts` passes false and starts it
   * with its other loops, so CLAW_API_BACKGROUND=off leaves it off.
   */
  pruneUnboundGrants?: boolean;
}

const CLAIM_PER_MINUTE = 10;
export const MAX_CALLERS = 10_000;
export const CLAIM_CONCURRENCY = 4;
export const CLAIM_QUEUE = 64;

/**
 * Failures counted in a fixed one-minute window per key, in this process: `full(key)` before, `count(key)` after a failure. At most
 * `maxKeys` keys are kept: past that, expired windows go, then the oldest.
 */
export function failureWindow(perMinute: number, maxKeys: number = MAX_CALLERS): {
  full: (key: string, now?: number) => boolean; count: (key: string, now?: number) => void; size: () => number;
} {
  const seen = new Map<string, { start: number; n: number }>();
  const live = (key: string, now: number) => {
    const w = seen.get(key);
    return w && now - w.start < 60_000 ? w : null;
  };
  return {
    full: (key, now = Date.now()) => (live(key, now)?.n ?? 0) >= perMinute,
    count: (key, now = Date.now()) => {
      const w = live(key, now);
      if (w) { w.n += 1; return; }
      seen.delete(key);
      if (seen.size >= maxKeys) {
        for (const [k, v] of seen) if (now - v.start >= 60_000) seen.delete(k);
        for (const k of seen.keys()) { if (seen.size < maxKeys) break; seen.delete(k); }
      }
      seen.set(key, { start: now, n: 1 });
    },
    size: () => seen.size,
  };
}

/** At most `concurrency` holders at once and `queue` waiting; `enter` answers false when the queue is full too. */
export class Gate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly concurrency: number, private readonly queue: number) {}
  async enter(): Promise<boolean> {
    if (this.active < this.concurrency) { this.active += 1; return true; }
    if (this.waiting.length >= this.queue) return false;
    await new Promise<void>((r) => this.waiting.push(r));
    return true;
  }
  leave(): void {
    const next = this.waiting.shift();
    if (next) next(); else this.active -= 1;
  }
}

/** Who is claiming, as far as this process can tell (see the module's comment): the forwarded chain and the socket address. */
export function callerKey(req: FastifyRequest): string {
  const h = req.headers["x-forwarded-for"];
  const chain = (Array.isArray(h) ? h.join(",") : h ?? "").replace(/\s+/g, "").slice(0, 512);
  return `${chain}|${req.ip}`;
}

const fail = (reply: FastifyReply, status: number, error: string) => reply.status(status).send({ ok: false, error });

function clientLabel(req: FastifyRequest): string | null {
  const h = req.headers["x-claw-client"];
  const v = Array.isArray(h) ? h[0] : h;
  return typeof v === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(v) ? v : null;
}

export async function registerPairingRoutes(app: FastifyInstance, opts: PairingRouteOptions = {}): Promise<void> {
  const perCaller = failureWindow(opts.claimsPerMinute ?? CLAIM_PER_MINUTE);
  const gate = new Gate(opts.claimConcurrency ?? CLAIM_CONCURRENCY, opts.claimQueue ?? CLAIM_QUEUE);
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
    const caller = callerKey(req);
    if (perCaller.full(caller)) return fail(reply, 429, "rate_limited");
    const body = (req.body ?? {}) as { code?: unknown; name?: unknown; alternate_name?: unknown };
    if (!(await gate.enter())) return fail(reply, 503, "busy");
    let out: Awaited<ReturnType<typeof claimPairing>>;
    try { out = await claimPairing(body.code, body.name, new Date(), body.alternate_name); } finally { gate.leave(); }
    if (!out.ok) {
      perCaller.count(caller);
      return fail(reply, 400, out.error);
    }
    logger.info({ owner: out.owner, grantId: out.grantId }, "remote_agents.pairing_claimed");
    // name: what the machine is called (a connector that sent an alternate name pairs under the one given here).
    return reply.status(201).send({ ok: true, data: { token: out.token, server, ...(out.name ? { name: out.name } : {}) } });
  });

  if (opts.pruneUnboundGrants ?? true) startPairingPrune(app);
}

/** Claimed codes that never registered, and old codes. Hourly on every replica; idempotent. Stops with the server. */
export function startPairingPrune(app: FastifyInstance): void {
  const timer = setInterval(() => {
    pruneUnboundGrants().catch((err) => logger.warn({ err: (err as Error)?.message }, "remote_agents.pairing_prune_failed"));
  }, 60 * 60 * 1000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
}
