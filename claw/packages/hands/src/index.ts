// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// First, and before anything that reads process.env at import time: this
// applies the per-request environment Brain wrote into the sandbox.
import { APPLIED_ENV_KEYS } from "./runtime/env-file.js";

import Fastify from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { constantTimeEquals, verifyScopeCredential, type CredentialScope } from "@claw/utils";
import { tools } from "./tools/index.js";
import {
  shutdownAllShells, shutdownRunShells, runningShellCount, resolveShell,
} from "./tools/shell/bg-manager.js";
import {
  NO_RUN, OWNER_HEADER, RUN_HEADER, normalizeOwner, normalizeRun, withCaller,
} from "./runtime/owner-context.js";
import {
  mintEpoch, processStartToken, readEpochMarker, readRecord, stateRoot, subtreeReadable,
} from "./runtime/shell-records.js";
import { MAX_TIMEOUT_SEC } from "./tools/shell/bash.js";
import { BG_SHELL_ENABLED, INTERNAL_TOKEN, MCP_PORT } from "./config.js";

/**
 * Exported so route tests can reach the routes with `app.inject()` instead of
 * binding a port. Importing this module is only safe for that under
 * `--self-check`, which is what the listen at the bottom is gated on.
 */
export const app = Fastify({ logger: true });

/**
 * Every route here can start or kill processes in the sandbox, so each one
 * proves it is Brain first. Replies with the status to send, or null to proceed.
 */
function authFailure(req: { headers: Record<string, unknown> }): { status: number; error: string } | null {
  if (!INTERNAL_TOKEN) return { status: 401, error: "auth_failed_missing_internal_token" };
  if (!constantTimeEquals(presentedCredential(req), INTERNAL_TOKEN)) {
    return { status: 401, error: "unauthorized" };
  }
  return null;
}

function presentedCredential(req: { headers: Record<string, unknown> }): string {
  return String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
}

type ScopeFailure = { status: number; error: string; field?: string };

/**
 * Which scope this caller has proved, taken from the credential alone.
 *
 * The routes below used to read the owner from one body field and the run from
 * another behind a token bound to no scope, so any holder could count another
 * owner's shells or terminate another run's. A request still carrying either
 * field is refused naming it rather than quietly ignored, because a caller that
 * believes it is addressing a scope must not be answered about a different one.
 */
function callerScope(
  req: { headers: Record<string, unknown>; body?: Record<string, unknown> },
): { scope: CredentialScope } | { failure: ScopeFailure } {
  for (const field of ["owner", "run"]) {
    if (req.body && field in req.body) {
      return { failure: { status: 400, error: "scope_not_in_body", field } };
    }
  }
  if (!INTERNAL_TOKEN) {
    return { failure: { status: 401, error: "auth_failed_missing_internal_token" } };
  }
  const verified = verifyScopeCredential(presentedCredential(req), INTERNAL_TOKEN);
  if (!verified.ok) return { failure: { status: 401, error: verified.error } };
  return { scope: verified.scope };
}

/** Create a fresh McpServer with all tools — one per request to avoid shared state. */
function createMcpServer(): McpServer {
  const mcp = new McpServer({ name: "hands", version: "1.0.0" });
  for (const tool of tools) {
    mcp.tool(tool.name, tool.description, tool.zodSchema, tool.execute as any);
  }
  return mcp;
}

app.get("/health", async () => ({
  status: "ok",
  service: "hands",
  tools: tools.map((t) => t.name),
  // What this sandbox actually booted with. The tool list above is identical
  // in both switch states, so it is not a capability signal and a gate reading
  // it would pass on a sandbox with the feature off. A running sandbox's
  // environment is not visible from outside any other way.
  bgShellEnabled: BG_SHELL_ENABLED,
  bashMaxTimeoutSec: MAX_TIMEOUT_SEC,
  // Whether this process files durable shell records, which is what decides
  // how Brain addresses it: a process that files none partitions its shells by
  // owner alone, and the run half of the address has to travel inside the id
  // instead. Absent on every build predating the records, which is exactly the
  // population that needs the other treatment.
  bgShellRecords: readEpochMarker() !== null,
}));

/**
 * What the records say about one shell, for a Brain resolving a possible replay.
 *
 * Read-only and starts nothing, so it is safe to ask before deciding whether a
 * start is a first call. The three answers are kept apart deliberately: a
 * determinate absence beneath a readable marker says no claim landed, while an
 * unreadable subtree or a missing marker says nothing was observed at all, and
 * only the first of those may lead to a start being sent.
 */
app.post<{ Body?: Record<string, unknown> }>(
  "/internal/shells/record",
  async (req, reply) => {
    const resolved = callerScope(req);
    if ("failure" in resolved) return sendScopeFailure(reply, resolved.failure);

    const shellId = typeof req.body?.shell_id === "string" ? req.body.shell_id : "";
    if (!shellId) return reply.status(400).send({ error: "shell_id_required" });

    const marker = readEpochMarker() !== null;
    const readable = subtreeReadable();
    let present = false;
    if (marker && readable) {
      try {
        present = readRecord(resolved.scope.owner, resolved.scope.run, shellId) !== null;
      } catch {
        return { marker, subtreeReadable: false, present: false };
      }
    }
    return { marker, subtreeReadable: readable, present };
  },
);

/**
 * The class of one shell, without touching a byte of its output.
 *
 * A caller deciding whether to block on a `wait` has to know first: parking a
 * run for a shell that can never produce an exit event costs the pod's
 * execution slot for the whole timeout. Separate from the poll for that reason
 * -- the poll advances the read offset, and a preflight that consumed the
 * bytes the wait owes its caller would be worse than no preflight at all.
 */
app.post<{ Body?: Record<string, unknown> }>(
  "/internal/shells/class",
  async (req, reply) => {
    const resolved = callerScope(req);
    if ("failure" in resolved) return sendScopeFailure(reply, resolved.failure);

    const shellId = typeof req.body?.shell_id === "string" ? req.body.shell_id : "";
    if (!shellId) return reply.status(400).send({ error: "shell_id_required" });

    const answer = resolveShell(resolved.scope.owner, resolved.scope.run ?? NO_RUN, shellId);
    return { shell_class: answer.cls, collector_live: answer.collectorLive };
  },
);

function sendScopeFailure(
  reply: { status: (code: number) => { send: (body: unknown) => unknown } },
  failure: ScopeFailure,
): unknown {
  return reply.status(failure.status).send(
    failure.field ? { error: failure.error, field: failure.field } : { error: failure.error },
  );
}

app.all("/mcp", async (req, reply) => {
  const denied = authFailure(req);
  if (denied) return reply.status(denied.status).send({ error: denied.error });
  // `enableJsonResponse: true` switches the streamable-HTTP server transport from
  // its default SSE streaming reply to a plain JSON reply: the POST /mcp handler
  // awaits all tool results, then returns a single `Content-Type: application/json`
  // response. This avoids the SSE controller / @hono/node-server bridge deadlock
  // we hit under fastify where `streamController.close()` did not finalize the
  // Node response, leaving Brain's MCP client awaiting indefinitely. Brain's
  // StreamableHTTPClientTransport already accepts `application/json` responses
  // (see sdk/client/streamableHttp.js handlePostResponse), so this is a server-
  // side-only switch.
  const mcp = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined as any,
    enableJsonResponse: true,
  });
  await mcp.connect(transport);
  // `enableJsonResponse` makes handleRequest await every tool result, so tools
  // run inside this async context and can read who is calling without being
  // handed it. An absent or malformed owner collapses to the shared `unowned`
  // bucket, and an absent run means no run will reap what this call starts.
  await withCaller(
    { owner: normalizeOwner(req.headers[OWNER_HEADER]), run: normalizeRun(req.headers[RUN_HEADER]) },
    () => transport.handleRequest(req.raw, reply.raw, req.body),
  );
});

/**
 * How much background work is still running in this sandbox.
 *
 * Brain asks when a task reaches a terminal state, because "the turn ended" and
 * "this sandbox is free" are not the same thing: a background shell is expected
 * to outlive the turn that started it, and the sandbox has to stay alive while
 * one is running or the control plane reclaims it out from under the work.
 *
 * Read-only, and internal rather than an MCP tool for the same reason the reap
 * is: this is Brain's bookkeeping, not something the model should be able to ask
 * on its own behalf or about another caller.
 */
app.post<{ Body?: Record<string, unknown> }>("/internal/shells/active", async (req, reply) => {
  const resolved = callerScope(req);
  if ("failure" in resolved) return sendScopeFailure(reply, resolved.failure);

  const running = runningShellCount(resolved.scope.owner);
  if (running === null) {
    // The durable state this process files could not be read, so how much work
    // is live is unknown. Answering zero here is what marks a sandbox full of
    // orphaned work idle; the caller's own unanswered-probe path keeps it.
    return reply.status(503).send({ error: "shell_liveness_indeterminate" });
  }
  return { running };
});

/**
 * End the background shells a finished run started.
 *
 * Brain calls this instead of doing it through a tool because by the time it
 * knows a run is over the model is no longer being asked anything, and because
 * the decision is Brain's: a batch node's shells go, a conversation's stay. Not
 * an MCP tool, so the model cannot invoke it on itself or on another run.
 */
app.post<{ Body?: Record<string, unknown> }>("/internal/shells/reap", async (req, reply) => {
  const resolved = callerScope(req);
  if ("failure" in resolved) return sendScopeFailure(reply, resolved.failure);

  // A credential proving no run identity authorises no reap: the absent-run
  // bucket holds every shell started without one, which is precisely the set
  // nothing is entitled to end by run.
  const run = resolved.scope.run;
  if (!run) return reply.status(400).send({ error: "run_required" });

  const stopped = await shutdownRunShells(run);
  app.log.info({ run, stopped }, "hands.reap_run_shells");
  return { stopped };
});

/**
 * Take the background shells down with us.
 *
 * Without this, SIGTERM ended Hands and left every detached process group it
 * had started running in the sandbox, unreachable: the registry that knew their
 * pids died with the process. Installing a handler also means Node no longer
 * exits on the signal by itself, so the exit is explicit.
 */
let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    const stopped = await shutdownAllShells();
    app.log.info({ signal, stopped }, "hands.shutdown");
  } catch (e) {
    app.log.error({ signal, err: (e as Error).message }, "hands.shutdown_failed");
  }
  await app.close().catch(() => {});
  process.exit(0);
}

if (process.argv.includes("--self-check")) {
  process.stdout.write(`hands self-check ok (${tools.length} tools)\n`);
} else {
  // Minted before anything can be started, and fatal when it cannot be: the
  // marker is what says this process files durable records, and a Hands
  // serving shells it files no record of would leave every later destroy gate
  // reading an empty count as an empty sandbox.
  try {
    mintEpoch({ pid: process.pid, startToken: processStartToken(process.pid) });
  } catch (e) {
    app.log.fatal(
      { err: (e as Error).message, stateRoot: stateRoot() },
      "hands.epoch_mint_failed",
    );
    process.exit(1);
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  app.listen({ host: "0.0.0.0", port: MCP_PORT }, (err) => {
    if (err) { app.log.fatal(err); process.exit(1); }
    app.log.info(
      { port: MCP_PORT, tools: tools.length, envKeys: APPLIED_ENV_KEYS.length },
      "hands MCP server ready",
    );
  });
}
