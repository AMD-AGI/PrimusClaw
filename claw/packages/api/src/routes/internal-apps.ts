// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Brain -> API surface for the AppRunner's own state (hosting design 5.3.2).
 *
 *   GET   /v1/internal/app-runs/:taskId           the run row plus what it was asked to do
 *   GET   /v1/internal/app-runs/:taskId/secrets   the MCP token and grant keys, opened
 *   PATCH /v1/internal/app-runs/:taskId           fenced state update (lease holder + claim epoch), including
 *                                                 the event-forwarding cursor (5.7)
 *   PUT   /v1/internal/app-runs/:taskId/mcp       record where the app's session MCP answers (fenced)
 *   DELETE /v1/internal/app-runs/:taskId/mcp      remove that record (fenced; brain_id, claim_count in the query)
 *
 * Authentication is the cluster internal token, like the claim surface: there
 * is no per-run token because a Brain taking a run over does not yet hold one,
 * and the fence on writes is the lease: `brain_id` must be the holder, the lease live,
 * and `claim_count` the epoch the caller took the run at.
 *
 * The secrets are a separate GET, not part of the row read, so the AppRunner
 * asks for them once, at the point it builds the application's environment, and
 * the ordinary state read that runs every few seconds never carries them.
 */
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { APP_EVENT_ID, APP_EVENT_SEGMENT_NAME } from "@claw/protocol";
import { internalTokenAuth } from "../auth/middleware.js";
import { MCP_URL_MAX, SANDBOX_SESSION_ID_MAX, recordSessionAppMcp, removeSessionAppMcp } from "../tasks/session-app-mcp.js";
import {
  APP_RUN_STATES, LAST_EXIT_MAX_BYTES, patchAppRun, readAppRun, readAppRunSecrets,
  type AppRunPatch, type AppRunState,
} from "../tasks/app-run-state.js";

const logger = pino({ name: "internal-apps" });

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const STATES = new Set<string>(APP_RUN_STATES);
const STATE_DIR_MAX = 4096;
const WORKLOAD_ID_MAX = 200;
const RESTARTS_MAX = 1_000_000;
const OFFSET_MAX = 2 ** 53 - 1;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const PATCH_KEYS = new Set(["brain_id", "claim_count", "expect_state", "state", "restarts", "last_exit", "events_cursor", "state_dir", "sandbox_workload_id", "grant_expires_at", "grant_revoked"]);

/** The patch in `body`, or the reason it was refused. */
export function parseAppRunPatch(
  body: unknown,
): { ok: true; brainId: string; claimCount: number; expect?: AppRunState; patch: AppRunPatch } | { ok: false; error: string } {
  if (!isObj(body)) return { ok: false, error: "body_must_be_object" };
  for (const key of Object.keys(body)) if (!PATCH_KEYS.has(key)) return { ok: false, error: `unknown_field:${key}` };
  const brainId = typeof body.brain_id === "string" ? body.brain_id.trim() : "";
  if (!brainId) return { ok: false, error: "brain_id_required" };
  const claimCount = body.claim_count;
  if (typeof claimCount !== "number" || !Number.isInteger(claimCount) || claimCount < 0 || claimCount > 2_000_000_000) {
    return { ok: false, error: "claim_count_required" };
  }

  const patch: AppRunPatch = {};
  let expect: AppRunState | undefined;
  if (body.expect_state !== undefined) {
    if (typeof body.expect_state !== "string" || !STATES.has(body.expect_state)) return { ok: false, error: "expect_state_invalid" };
    expect = body.expect_state as AppRunState;
  }
  if (body.state !== undefined) {
    if (typeof body.state !== "string" || !STATES.has(body.state)) return { ok: false, error: "state_invalid" };
    patch.state = body.state as AppRunState;
  }
  if (body.restarts !== undefined) {
    const n = body.restarts;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > RESTARTS_MAX) return { ok: false, error: "restarts_invalid" };
    patch.restarts = n;
  }
  if (body.state_dir !== undefined) {
    const d = body.state_dir;
    if (typeof d !== "string" || !d.startsWith("/") || d.length > STATE_DIR_MAX || /[\0\n\r]/.test(d)) {
      return { ok: false, error: "state_dir_invalid" };
    }
    patch.state_dir = d;
  }
  if (body.sandbox_workload_id !== undefined) {
    const w = body.sandbox_workload_id;
    if (w !== null && (typeof w !== "string" || !w || w.length > WORKLOAD_ID_MAX)) return { ok: false, error: "sandbox_workload_id_invalid" };
    patch.sandbox_workload_id = w as string | null;
  }
  if (body.grant_expires_at !== undefined) {
    const t = body.grant_expires_at;
    if (typeof t !== "string" || t.length > 64 || !ISO_TIME.test(t) || Number.isNaN(Date.parse(t))) {
      return { ok: false, error: "grant_expires_at_invalid" };
    }
    patch.grant_expires_at = t;
  }
  if (body.grant_revoked !== undefined) {
    if (body.grant_revoked !== true) return { ok: false, error: "grant_revoked_invalid" };
    patch.grant_revoked = true;
  }
  if (body.events_cursor !== undefined) {
    const c = body.events_cursor;
    if (!isObj(c)) return { ok: false, error: "events_cursor_invalid" };
    for (const key of Object.keys(c)) if (key !== "segment" && key !== "offset" && key !== "last_id" && key !== "epoch" && key !== "reset_pending") return { ok: false, error: "events_cursor_invalid" };
    if (c.segment !== undefined && (typeof c.segment !== "string" || !APP_EVENT_SEGMENT_NAME.test(c.segment))) return { ok: false, error: "events_cursor_invalid" };
    if (c.offset !== undefined && (typeof c.offset !== "number" || !Number.isInteger(c.offset) || c.offset < 0 || c.offset > OFFSET_MAX)) {
      return { ok: false, error: "events_cursor_invalid" };
    }
    if (c.last_id !== undefined && (typeof c.last_id !== "string" || !APP_EVENT_ID.test(c.last_id))) return { ok: false, error: "events_cursor_invalid" };
    if (c.epoch !== undefined && (typeof c.epoch !== "number" || !Number.isInteger(c.epoch) || c.epoch < 0 || c.epoch > 1_000_000)) {
      return { ok: false, error: "events_cursor_invalid" };
    }
    if (c.reset_pending !== undefined && c.reset_pending !== true) return { ok: false, error: "events_cursor_invalid" };
    patch.events_cursor = c;
  }
  if (body.last_exit !== undefined) {
    const e = body.last_exit;
    if (e !== null && !isObj(e)) return { ok: false, error: "last_exit_invalid" };
    if (e !== null && Buffer.byteLength(JSON.stringify(e), "utf8") > LAST_EXIT_MAX_BYTES) return { ok: false, error: "last_exit_too_large" };
    patch.last_exit = e as Record<string, unknown> | null;
  }
  return { ok: true, brainId, claimCount, expect, patch };
}

const REFUSALS = {
  not_found: { status: 404, error: "not_found" },
  not_holder: { status: 409, error: "not_holder" },
  state_mismatch: { status: 409, error: "state_mismatch" },
  grant_refused: { status: 409, error: "grant_refused" },
  ended: { status: 409, error: "ended" },
  empty: { status: 400, error: "empty_patch" },
} as const;

const MCP_REFUSALS = {
  not_found: { status: 404, error: "not_found" },
  not_holder: { status: 409, error: "not_holder" },
  ended: { status: 409, error: "ended" },
  no_mcp: { status: 409, error: "no_mcp" },
} as const;

function parseFence(brainId: unknown, claimCount: unknown): { brainId: string; claimCount: number } | null {
  if (typeof brainId !== "string" || !brainId || brainId.length > 200) return null;
  if (typeof claimCount !== "number" || !Number.isInteger(claimCount) || claimCount < 0) return null;
  return { brainId, claimCount };
}

/** http(s), a host, no credentials in the URL. */
function isCleanHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.host && !u.username && !u.password;
  } catch {
    return false;
  }
}

export async function registerInternalAppRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { taskId: string } }>(
    "/v1/internal/app-runs/:taskId",
    { preHandler: internalTokenAuth },
    async (req, reply) => {
      const run = await readAppRun(req.params.taskId);
      if (!run) return reply.status(404).send({ ok: false, error: "not_found" });
      return { ok: true, run };
    },
  );

  app.get<{ Params: { taskId: string } }>(
    "/v1/internal/app-runs/:taskId/secrets",
    { preHandler: internalTokenAuth },
    async (req, reply) => {
      let secrets;
      try {
        secrets = await readAppRunSecrets(req.params.taskId);
      } catch (err) {
        // Not the error's text: it is the one place a failed open could name a value.
        logger.error({ taskId: req.params.taskId, errorClass: (err as Error)?.constructor?.name }, "app_run.secrets_open_failed");
        return reply.status(500).send({ ok: false, error: "secrets_unavailable" });
      }
      if (!secrets) return reply.status(404).send({ ok: false, error: "not_found" });
      return { ok: true, ...secrets };
    },
  );

  app.patch<{ Params: { taskId: string }; Body: unknown }>(
    "/v1/internal/app-runs/:taskId",
    { preHandler: internalTokenAuth },
    async (req, reply) => {
      const parsed = parseAppRunPatch(req.body);
      if (!parsed.ok) return reply.status(400).send({ ok: false, error: parsed.error });
      const outcome = await patchAppRun(req.params.taskId, { brainId: parsed.brainId, claimCount: parsed.claimCount }, parsed.patch, parsed.expect);
      if (outcome.ok) {
        logger.info({ taskId: req.params.taskId, state: outcome.run.state, restarts: outcome.run.restarts }, "app_run.patched");
        return { ok: true, run: outcome.run };
      }
      const refusal = REFUSALS[outcome.reason];
      return reply.status(refusal.status).send({ ok: false, error: refusal.error, current_state: outcome.current });
    },
  );
  app.put<{ Params: { taskId: string }; Body: unknown }>(
    "/v1/internal/app-runs/:taskId/mcp",
    { preHandler: internalTokenAuth },
    async (req, reply) => {
      const b = isObj(req.body) ? req.body : {};
      const fence = parseFence(b.brain_id, b.claim_count);
      if (!fence) return reply.status(400).send({ ok: false, error: "fence_invalid" });
      const { url, sandbox_session_id: sid } = b;
      if (typeof url !== "string" || url.length > MCP_URL_MAX || !isCleanHttpUrl(url)) return reply.status(400).send({ ok: false, error: "url_invalid" });
      if (typeof sid !== "string" || !sid || sid.length > SANDBOX_SESSION_ID_MAX) return reply.status(400).send({ ok: false, error: "sandbox_session_id_invalid" });
      const out = await recordSessionAppMcp(req.params.taskId, fence, { url, sandbox_session_id: sid });
      if (out.ok) return { ok: true };
      return reply.status(MCP_REFUSALS[out.reason].status).send({ ok: false, error: MCP_REFUSALS[out.reason].error });
    },
  );

  app.delete<{ Params: { taskId: string }; Querystring: { brain_id?: string; claim_count?: string } }>(
    "/v1/internal/app-runs/:taskId/mcp",
    { preHandler: internalTokenAuth },
    async (req, reply) => {
      const fence = parseFence(req.query.brain_id, /^\d+$/.test(req.query.claim_count ?? "") ? Number(req.query.claim_count) : undefined);
      if (!fence) return reply.status(400).send({ ok: false, error: "fence_invalid" });
      const out = await removeSessionAppMcp(req.params.taskId, fence);
      if (out.ok) return { ok: true, removed: out.removed ?? 0 };
      return reply.status(MCP_REFUSALS[out.reason].status).send({ ok: false, error: MCP_REFUSALS[out.reason].error });
    },
  );
}
