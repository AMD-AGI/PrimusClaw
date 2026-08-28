// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// routes/admin.ts
//
// Brain-side `/admin/checkpoint/*` HTTP endpoints (checkpoint-architecture-
// redesign §12.4). Mounted by brain/src/index.ts main() onto the same
// Fastify instance that already serves /health + /metrics + the
// internal hands-binary route.
//
// Security model (full details in security-design.md §2.3 S1..S6): off by
// default (404 unless CLAW_ADMIN_TOKEN is set), token mismatch returns 404
// instead of 401 to avoid leaking route existence, every request is audit
// logged with a token hash (never the raw token), session ids in responses
// are hashed, and the route is internal-only (not exposed via ingress) and
// strictly read-only.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { KV } from "nats";
import { createHash, timingSafeEqual } from "crypto";
import pino from "pino";
import {
  BRAIN_REGISTRY_BUCKET,
  BRAIN_CHECKPOINTS_BUCKET,
} from "../config.js";

const logger = pino({ name: "admin-routes" });

// --- internal helpers --------------------------------------------------

interface Semaphore {
  readonly inflight: number;
  readonly queued: number;
  readonly capacity: number;
}

interface AdminDeps {
  workspaceSyncSemaphore: Semaphore;
  workspaceSigtermSyncSemaphore: Semaphore;
  // Injected by brain/src/index.ts main() — brain holds kv / kvCkpt
  // as module-level variables and has no infra/nats.ts wrapper module, so
  // we pass them in explicitly rather than importing.
  kv: KV;
  kvCkpt: KV;
  // Optional NATS string codec; only needed for decoding checkpoint
  // payloads on the /recent route. We accept the encoder/decoder
  // function pair rather than the nats StringCodec object itself to
  // keep the dependency surface minimal.
  decode: (data: Uint8Array) => string;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

// constant-time string compare; falls back to a length-mismatch fast
// path so the timing leak is bounded to "token length" only (which
// authorized operators already know).
function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function extractBearer(req: FastifyRequest): string | null {
  const raw = (req.headers.authorization || "").trim();
  if (!raw) return null;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function deny404(reply: FastifyReply): FastifyReply {
  return reply.status(404).type("text/plain").send("Not Found");
}

// Returns true if the request is authorized to access the admin
// endpoint; false otherwise. The boolean is the only signal returned
// — callers must immediately deny404() on false and never branch on
// the specific reason (S2).
function authorize(req: FastifyRequest, route: string): boolean {
  const expected = process.env.CLAW_ADMIN_TOKEN || "";
  const presented = extractBearer(req) || "";
  if (!expected) {
    // S1: endpoint disabled when no token configured. Still log so an
    // accidental probe is visible.
    logger.warn({ route, ip: req.ip }, "admin.deny.token_not_configured");
    return false;
  }
  if (!presented) {
    logger.warn({ route, ip: req.ip, token_id: null }, "admin.deny.no_token");
    return false;
  }
  if (!constantTimeEquals(presented, expected)) {
    // S3 / S4: log only token hash, never the token itself.
    logger.warn(
      { route, ip: req.ip, token_id: shortHash(presented) },
      "admin.deny.bad_token",
    );
    return false;
  }
  logger.info(
    { route, ip: req.ip, token_id: shortHash(presented) },
    "admin.allow",
  );
  return true;
}

// --- KV bucket status probe -------------------------------------------
//
// Probe both Plan Y v2 buckets to confirm they exist and (when the
// underlying server exposes status) their config has not drifted away
// from the values C1 declared. We accept "ok" as the cheap success
// path and only report config_drift when we have actual config back
// to compare; this avoids a noisy "drift" reading when the NATS API
// has not surfaced status yet.

type BucketState = "ok" | "missing" | "config_drift";

async function probeBucket(kv: KV, name: string): Promise<BucketState> {
  try {
    // Each KV instance is already bound to a single bucket (created via
    // js.views.kv(name, ...)). The cheapest "does my bucket exist + is
    // it responsive" check available without reaching back into the
    // JetStream manager is .status() on this instance. If the bound
    // bucket name (when exposed by the status payload) does not match
    // the value C1 declared, surface "config_drift" — typically caused
    // by an operator mutating BRAIN_REGISTRY_BUCKET env after rollout.
    const status = await kv.status().catch(() => null);
    if (!status) return "missing";
    const reportedBucket = (status as { bucket?: string }).bucket;
    if (reportedBucket && reportedBucket !== name) {
      logger.warn(
        { expected: name, actual: reportedBucket },
        "admin.bucket_probe_name_mismatch",
      );
      return "config_drift";
    }
    return "ok";
  } catch (e) {
    logger.warn({ err: e, bucket: name }, "admin.bucket_probe_failed");
    return "missing";
  }
}

// --- per-session checkpoint snapshot ----------------------------------

async function listRecentCheckpoints(
  kvCkpt: KV,
  decode: (data: Uint8Array) => string,
  limit: number,
): Promise<Array<{
  session_id_hash: string;
  message_id_hash: string;
  turns_completed: number;
  has_workspace_sync: boolean;
  last_sync_turn: number;
  age_seconds: number;
}>> {
  const out: Array<ReturnType<typeof toSummary>> = [];
  try {
    // Key prefix MUST match the value writeKvCheckpoint() uses
    // (brain/src/tasks/runner.ts checkpointKey: `task-ckpt.<sid>.<messageId>`).
    // A drift here returns an empty admin /recent listing while
    // production checkpoints are perfectly healthy — silent dashboard
    // bug, no error log. The reaper module already encodes the same
    // prefix in workspace/reaper.ts; keep all three call sites in sync.
    // `>` rather than `*` because the key spans more than one token now.
    const iter = await kvCkpt.keys("task-ckpt.>");
    let i = 0;
    for await (const key of iter) {
      if (i++ >= limit) break;
      const entry = await kvCkpt.get(key).catch(() => null);
      if (!entry) continue;
      try {
        const ckpt = JSON.parse(decode(entry.value)) as Record<string, unknown>;
        // The session id comes from the payload rather than from parsing the
        // key, so the listing no longer breaks when the key shape changes.
        out.push(toSummary(String(ckpt.session_id ?? ""), ckpt));
      } catch {
        // best-effort; skip undecodable rows
      }
    }
  } catch (e) {
    logger.warn({ err: e }, "admin.list_checkpoints_failed");
  }
  return out;
}

function toSummary(sessionId: string, ckpt: Record<string, unknown>): {
  session_id_hash: string;
  message_id_hash: string;
  turns_completed: number;
  has_workspace_sync: boolean;
  last_sync_turn: number;
  age_seconds: number;
} {
  const checkpointedAt = Number(ckpt.checkpointed_at ?? 0);
  return {
    session_id_hash: shortHash(sessionId),
    message_id_hash: shortHash(String(ckpt.message_id ?? "")),
    turns_completed: Number(ckpt.turns_completed ?? 0),
    has_workspace_sync: Boolean(ckpt.has_workspace_sync ?? false),
    last_sync_turn: Number(ckpt.last_sync_turn ?? 0),
    age_seconds: checkpointedAt > 0
      ? Math.round((Date.now() - checkpointedAt) / 1000)
      : -1,
  };
}

// --- public registration ----------------------------------------------

export async function registerAdminCheckpointRoutes(
  app: FastifyInstance,
  deps: AdminDeps,
): Promise<void> {
  app.get("/admin/checkpoint/health", async (req, reply) => {
    const route = "/admin/checkpoint/health";
    if (!authorize(req, route)) return deny404(reply);

    const [kvRegistryStatus, kvCheckpointsStatus] = await Promise.all([
      probeBucket(deps.kv, BRAIN_REGISTRY_BUCKET),
      probeBucket(deps.kvCkpt, BRAIN_CHECKPOINTS_BUCKET),
    ]);
    const recent = await listRecentCheckpoints(deps.kvCkpt, deps.decode, 50);

    // Aggregate distributions for the dashboard at-a-glance row.
    // Per-session detail is gated by /admin/checkpoint/recent (below).
    let workspaceSyncOn = 0;
    let totalAgeSec = 0;
    for (const r of recent) {
      if (r.has_workspace_sync) workspaceSyncOn++;
      if (r.age_seconds >= 0) totalAgeSec += r.age_seconds;
    }
    const avgAgeSec = recent.length > 0
      ? Math.round(totalAgeSec / recent.length)
      : 0;

    return reply.send({
      bucket_status: {
        kv_registry: kvRegistryStatus,
        kv_checkpoints: kvCheckpointsStatus,
      },
      sync_inflight: {
        normal: deps.workspaceSyncSemaphore.inflight,
        sigterm: deps.workspaceSigtermSyncSemaphore.inflight,
      },
      sync_queued: {
        normal: deps.workspaceSyncSemaphore.queued,
        sigterm: deps.workspaceSigtermSyncSemaphore.queued,
      },
      sync_capacity: {
        normal: deps.workspaceSyncSemaphore.capacity,
        sigterm: deps.workspaceSigtermSyncSemaphore.capacity,
      },
      checkpoints: {
        sampled: recent.length,
        workspace_sync_on: workspaceSyncOn,
        avg_age_seconds: avgAgeSec,
      },
      // Per-session detail kept on a separate route so the top-level
      // health probe stays cheap to poll from oncall dashboards.
    });
  });

  app.get("/admin/checkpoint/recent", async (req, reply) => {
    const route = "/admin/checkpoint/recent";
    if (!authorize(req, route)) return deny404(reply);
    const recent = await listRecentCheckpoints(deps.kvCkpt, deps.decode, 200);
    return reply.send({ count: recent.length, items: recent });
  });

  logger.info("admin.routes.registered");
}
