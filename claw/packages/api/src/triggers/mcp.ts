// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The model's trigger tools as an MCP service of this API, and the server entry a turn is given to reach it.
 *
 * Built the way the assistant's service is (`assistant/mcp.ts`): served under `/v1/internal/`, which the global
 * authentication leaves to the route, and authenticated by a bearer minted for one turn (`token.ts`). What the
 * bearer proves is which turn is calling; whose triggers those are is read from that turn's session. Creating a
 * trigger is held for the user's decision (`requires_approval`), which shows them the whole prompt and schedule:
 * a scheduled run acts on their behalf later with nobody watching.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import pino from "pino";
import { z } from "zod";
import { tokenTtlSeconds } from "../assistant/role-profile.js";
import {
  CLAW_TRIGGER_TOOLS_ENABLED, CLAW_TRIGGER_TOOLS_TOKEN_KEY, INTERNAL_BACKEND_URL, TRIGGER_MIN_INTERVAL_MINUTES,
} from "../config.js";
import { db } from "../infra/db.js";
import { mintTriggerToken, verifyTriggerToken, type TriggerTokenClaims } from "./token.js";
import { ToolRefused, triggerCancel, triggerCreate, triggerList } from "./tools.js";

const logger = pino({ name: "trigger-mcp" });

export const TRIGGER_MCP_SERVER = "schedules";
export const TRIGGER_MCP_PATH = "/v1/internal/trigger-mcp";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const result = (data: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  ...(isError ? { isError: true } : {}),
});

async function answer(claims: TriggerTokenClaims, name: string, run: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return result(await run());
  } catch (err) {
    if (err instanceof ToolRefused) {
      logger.info({ sid: claims.sid, tool: name, code: err.code }, "trigger_tools.refused");
      return result({ ok: false, error: err.code, message: err.message }, true);
    }
    logger.error({ err, sid: claims.sid, tool: name }, "trigger_tools.failed");
    return result({ ok: false, error: "internal_error", message: "the call failed; try once more" }, true);
  }
}

export function createTriggerMcpServer(claims: TriggerTokenClaims): McpServer {
  const mcp = new McpServer({ name: "PrimusClawSchedules", version: "1.0.0" });
  mcp.tool(
    "trigger_create",
    "Schedule a task that runs later, on its own, as the user: a recurring job or a watch that checks something until "
    + "it is done. Each run receives `prompt` and nothing of this conversation, so make it self-contained. The user is "
    + `asked to approve it first. Runs at most every ${TRIGGER_MIN_INTERVAL_MINUTES} minutes. Bound a watch with until or max_runs.`,
    {
      name: z.string().describe("A short name the user recognises, at most 120 characters."),
      prompt: z.string().describe("The complete instruction each run receives."),
      schedule: z.string().describe("A five-field cron expression, e.g. \"0 8 * * 1-5\" for 08:00 on weekdays."),
      timezone: z.string().describe("The user's IANA timezone, e.g. \"Asia/Shanghai\"."),
      until: z.string().optional().describe("ISO 8601 time after which it no longer runs."),
      max_runs: z.number().int().optional().describe("Stop after this many runs."),
    },
    (args) => answer(claims, "trigger_create", () => triggerCreate(claims, args)),
  );
  mcp.tool(
    "trigger_list",
    "List the user's scheduled tasks: schedule, next run, runs so far, and whether each is active or has ended.",
    {},
    () => answer(claims, "trigger_list", () => triggerList(claims)),
  );
  mcp.tool(
    "trigger_cancel",
    "Cancel one of the user's scheduled tasks for good.",
    { trigger_id: z.string().describe("The trigger_id from trigger_list or trigger_create.") },
    (args) => answer(claims, "trigger_cancel", () => triggerCancel(claims, args)),
  );
  return mcp;
}

const claimsOf = new WeakMap<FastifyRequest, TriggerTokenClaims>();

export async function triggerTokenAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const presented = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const verdict = verifyTriggerToken(presented, CLAW_TRIGGER_TOOLS_TOKEN_KEY);
  if (!verdict.ok) return reply.status(401).send({ ok: false, error: "trigger tools token required" }) as never;
  claimsOf.set(req, verdict.claims);
}

export async function registerTriggerMcpRoutes(
  app: FastifyInstance, enabled: boolean = CLAW_TRIGGER_TOOLS_ENABLED,
): Promise<void> {
  if (!enabled) return;
  app.all(TRIGGER_MCP_PATH, { preHandler: triggerTokenAuth }, async (req, reply) => {
    const mcp = createTriggerMcpServer(claimsOf.get(req) as TriggerTokenClaims);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined as never });
    await mcp.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  logger.info("trigger_tools.mcp_routes_registered");
}

/** Read per turn, so a test can flip them; the environment sets them at boot. */
export const triggerToolSettings = { enabled: CLAW_TRIGGER_TOOLS_ENABLED, key: CLAW_TRIGGER_TOOLS_TOKEN_KEY };

/**
 * Give a turn the trigger tools, with a bearer naming this turn. Applied where the turn's run row exists, before
 * the assistant's role is (`applySessionRoleToTask`), which keeps a router turn to its own tools.
 *
 * Not offered to a run a trigger started, so a scheduled run cannot schedule more of itself, nor to a session
 * without an owner. A turn does not depend on them: on any failure the tools are simply not offered.
 */
export async function applyTriggerToolsToTask(task: Record<string, unknown>, sessionId: string): Promise<void> {
  if (!triggerToolSettings.enabled) return;
  const taskId = typeof task.task_id === "string" ? task.task_id : "";
  const messageId = typeof task.message_id === "string" ? task.message_id : "";
  if (!taskId || !messageId) return;
  try {
    const row = (await db.query(
      "SELECT user_id, config FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL", [sessionId],
    )).rows[0] as { user_id: string | null; config: Record<string, unknown> | null } | undefined;
    if (!row?.user_id || row.user_id === "default" || row.config?.trigger_id) return;
    const token = mintTriggerToken(
      { sid: sessionId, mid: messageId, task_id: taskId, exp: Math.floor(Date.now() / 1000) + tokenTtlSeconds() },
      triggerToolSettings.key,
    );
    // Replaces a server of the same name the request carried: a caller cannot point these tools elsewhere.
    task.mcp_servers = {
      ...(task.mcp_servers as Record<string, Record<string, unknown>> | undefined),
      [TRIGGER_MCP_SERVER]: {
        type: "http", url: `${INTERNAL_BACKEND_URL}${TRIGGER_MCP_PATH}`, token, requires_approval: ["trigger_create"],
      },
    };
  } catch (err) {
    logger.error({ err, sessionId }, "trigger_tools.not_offered");
  }
}
