// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// First, and before anything that reads process.env at import time: this
// applies the per-request environment Brain wrote into the sandbox.
import { APPLIED_ENV_KEYS } from "./runtime/env-file.js";

import Fastify from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { constantTimeEquals } from "@claw/utils";
import { tools } from "./tools/index.js";
import { shutdownAllShells, shutdownRunShells, runningShellCount } from "./tools/shell/bg-manager.js";
import { OWNER_HEADER, RUN_HEADER, UNOWNED, normalizeOwner, normalizeRun, withCaller } from "./runtime/owner-context.js";
import { INTERNAL_TOKEN, MCP_PORT } from "./config.js";

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
  const presented = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!constantTimeEquals(presented, INTERNAL_TOKEN)) return { status: 401, error: "unauthorized" };
  return null;
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
}));

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
app.post<{ Body?: { owner?: unknown } }>("/internal/shells/active", async (req, reply) => {
  const denied = authFailure(req);
  if (denied) return reply.status(denied.status).send({ error: denied.error });

  // `!owner` would never fire: normalizeOwner substitutes the shared `unowned`
  // bucket for everything it cannot use -- absent, blank, over-long, control
  // characters -- and that string is truthy. Answering anyway is the part that
  // matters: `unowned` holds the shells of every caller that sent no owner
  // header, so a malformed question would be answered with somebody else's
  // work, and a pod kept alive for a session that has nothing running in it.
  //
  // A caller naming the bucket explicitly is asking a real question and is
  // answered; a value that only landed there by failing normalization is not.
  const raw = req.body?.owner;
  const owner = normalizeOwner(raw);
  if (owner === UNOWNED && raw !== UNOWNED) {
    return reply.status(400).send({ error: "owner_required" });
  }

  return { running: runningShellCount(owner) };
});

/**
 * End the background shells a finished run started.
 *
 * Brain calls this instead of doing it through a tool because by the time it
 * knows a run is over the model is no longer being asked anything, and because
 * the decision is Brain's: a batch node's shells go, a conversation's stay. Not
 * an MCP tool, so the model cannot invoke it on itself or on another run.
 */
app.post<{ Body?: { run?: unknown } }>("/internal/shells/reap", async (req, reply) => {
  const denied = authFailure(req);
  if (denied) return reply.status(denied.status).send({ error: denied.error });

  const run = normalizeRun(req.body?.run);
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
