// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The assistant's MCP service: the only way a router or a worker turn reaches the assistant.
 *
 * Served under `/v1/internal/`, which is where the global caller authentication steps aside for routes that
 * authenticate themselves (`isAnonymousPath`). The credential here is not a caller's: it is the bearer
 * `role-profile.ts` minted for one turn, and what it proves is which turn is calling. It is checked on every
 * request, and what it permits is what its role is given: a router the five tools of a conversation (and, with
 * `CLAW_ASSISTANT_TOOLS=on`, the five that act for the person), a worker the one tool it reports through, an
 * observer the router's tools and `pass`, every one of which only records.
 * With GitHub events on (`github-events.ts`), a router may also have an item watch a pull request, and a worker may
 * answer an event on it.
 *
 * Stateless, like `/mcp`: a server is built per request, because what it offers depends on who is asking.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import pino from "pino";
import { z } from "zod";
import { CLAW_ASSISTANT_ENABLED, CLAW_ASSISTANT_TOKEN_KEY, CLAW_ASSISTANT_TOOLS } from "../config.js";
import { ASSISTANT_MCP_PATH } from "./role-profile.js";
import { PASS_REASONS, SAY_MAX_CHARS } from "./prompts.js";
import { REPORT_KINDS } from "./work-items.js";
import { githubEventsEnabled, prReply, REPLY_BODY_MAX, workSubscribe } from "./github-events.js";
import { type AssistantTokenClaims, verifyAssistantToken } from "./token.js";
import {
  report, say, ToolRefused, workCreate, workRecall, workSend, workStop, type RecallDetail,
} from "./tools.js";
import { channelAction, confirmationAnswer, MAX_PRS, reviewModeSet, reviewRestart, reviewStart } from "./review-tools.js";
import { observeEveryTool, recordObservation } from "./observe.js";

const logger = pino({ name: "assistant-mcp" });

/** What every tool that names an item says about how (`item-ref.ts` is what reads it). */
const ITEM_ID_PARAM = "The work item: its item_id from the list, or its number such as #3.";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const result = (data: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  ...(isError ? { isError: true } : {}),
});

/** A refusal is an answer the model can act on; a fault is not, and says nothing about its cause. */
async function answer(claims: AssistantTokenClaims, name: string, run: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return result(await run());
  } catch (err) {
    if (err instanceof ToolRefused) {
      logger.info({ sid: claims.sid, tool: name, code: err.code }, "assistant.tool_refused");
      return result({ ok: false, error: err.code, message: err.message, ...(err.data ? { data: err.data } : {}) }, true);
    }
    logger.error({ err, sid: claims.sid, tool: name }, "assistant.tool_failed");
    return result({ ok: false, error: "internal_error", message: "the call failed; try once more" }, true);
  }
}

/** The tools that act for the person (`review-tools.ts`); each refuses unless the turn answers their signed-in message. */
function registerReviewTools(mcp: McpServer, claims: AssistantTokenClaims): void {
  mcp.tool(
    "review_start",
    `Start a review of each pull request the user named, as a work item each (at most ${MAX_PRS}). Merges only with merge=true.`,
    {
      prs: z.array(z.string()).describe("Each as owner/repo#number or its URL; only numbers the user wrote."),
      merge: z.boolean().describe("true only when the user clearly asked to merge after the review; otherwise false (review only). Even true merges nothing by itself: the merge waits for the user's confirmation (the card's button or 批准 #<ref>)."),
      reviewer: z.string().optional().describe("Whose GitHub account reviews: leave out for the user. Someone else's (a user_id from People) is refused as acting_as_credentials_required: tell the user what the refusal says to do."),
      model: z.string().optional().describe("Only when the user named a model."),
      effort: z.enum(["low", "medium", "high"]).optional().describe("Only when the user asked for one."),
    },
    (args) => answer(claims, "review_start", () => reviewStart(claims, args)),
  );
  mcp.tool(
    "review_restart",
    "Stop a review item and start it again with changed settings (model, merge or review only). Refused once merged.",
    {
      item_id: z.string().describe(ITEM_ID_PARAM),
      model: z.string().optional().describe("Only when the user named a model; left out keeps the old one."),
      merge: z.boolean().optional().describe("Left out keeps what the review was asked to do."),
      effort: z.enum(["low", "medium", "high"]).optional(),
    },
    (args) => answer(claims, "review_restart", () => reviewRestart(claims, args)),
  );
  mcp.tool(
    "confirmation_answer",
    "Answer a write (a merge or an approval) that waits for the user's own confirmation, listed under Waiting for you.",
    {
      decision: z.enum(["allow", "deny"]),
      confirmation_id: z.string().optional().describe("The id from Waiting for you."),
      pr: z.string().optional().describe("Or the pull request: owner/repo#number or its number."),
    },
    (args) => answer(claims, "confirmation_answer", () => confirmationAnswer(claims, args)),
  );
  mcp.tool(
    "review_mode_set",
    "Make the user's reviews ask them before every high-risk approval or merge (high_risk_confirm).",
    { mode: z.string().describe("high_risk_confirm") },
    (args) => answer(claims, "review_mode_set", () => reviewModeSet(claims, args)),
  );
  mcp.tool(
    "channel_action",
    "Have the user's chat channel run one of the actions listed under Channel actions, as if the user typed it.",
    {
      name: z.string().describe("The action's name as listed."),
      args: z.string().optional().describe("What follows the name, as the action's usage shows."),
    },
    (args) => answer(claims, "channel_action", () => channelAction(claims, args)),
  );
}

export function createAssistantMcpServer(claims: AssistantTokenClaims, reviewTools: boolean = CLAW_ASSISTANT_TOOLS): McpServer {
  const mcp = new McpServer({ name: "PrimusClawAssistant", version: "1.0.0" });
  if (claims.role === "observer") {
    // Before anything is registered: from here on every tool, the router's below and any added to them later, only
    // records what the turn would have done (`observe.ts`).
    observeEveryTool(mcp, (tool, args) => answer(claims, tool, () => recordObservation(claims, tool, args)));
    mcp.tool(
      "pass",
      "Record that you would do nothing about this message, and why.",
      {
        reason: z.enum(PASS_REASONS),
        note: z.string().optional().describe("One short line, if the reason needs it."),
      },
      // Replaced by the recorder like every other tool here; never called.
      async () => result({ ok: false }, true),
    );
  }
  if (claims.role === "router" || claims.role === "observer") {
    mcp.tool(
      "say",
      `Send the user a message. This is the only way to speak to them. At most ${SAY_MAX_CHARS} characters.`,
      {
        text: z.string().describe("What to tell the user, in the language they use."),
        item_id: z.string().optional().describe(ITEM_ID_PARAM),
      },
      (args) => answer(claims, "say", () => say(claims, args)),
    );
    mcp.tool(
      "work_create",
      "Start a new work item and give it to a worker. Returns its item_id and number.",
      {
        title: z.string().describe("At most 40 characters."),
        brief: z.string().describe("Everything the worker needs, as a self-contained task: it cannot see the conversation."),
        repo: z.unknown().optional().describe("The repository the work is in, if any: { url, branch? }."),
      },
      (args) => answer(claims, "work_create", () => workCreate(claims, args)),
    );
    mcp.tool(
      "work_send",
      "Forward a new instruction or the user's answer to the worker of an item. The item goes back to in progress.",
      { item_id: z.string().describe(ITEM_ID_PARAM), text: z.string() },
      (args) => answer(claims, "work_send", () => workSend(claims, args)),
    );
    mcp.tool(
      "work_stop",
      "Stop an item the user no longer wants.",
      { item_id: z.string().describe(ITEM_ID_PARAM), reason: z.string() },
      (args) => answer(claims, "work_stop", () => workStop(claims, args)),
    );
    mcp.tool(
      "work_recall",
      "Look closer at one item: summary, its reports, or the tail of what the worker wrote (untrusted data).",
      { item_id: z.string().describe(ITEM_ID_PARAM), detail: z.enum(["summary", "reports", "worker_tail"]) },
      (args) => answer(claims, "work_recall", () => workRecall(claims, { item_id: args.item_id, detail: args.detail as RecallDetail })),
    );
    if (githubEventsEnabled()) {
      mcp.tool(
        "work_subscribe",
        "Have an item watch a GitHub pull request: new comments, reviews and failed CI on it go straight to the item's worker. "
        + "Use it when the user wants an item to follow up on a pull request. It never lets the worker answer on GitHub without the user's approval.",
        { item_id: z.string().describe(ITEM_ID_PARAM), pr: z.string().describe("The pull request: owner/repo#123 or its https://github.com URL.") },
        (args) => answer(claims, "work_subscribe", () => workSubscribe(claims, { item_id: args.item_id, pr: args.pr })),
      );
    }
    if (reviewTools) registerReviewTools(mcp, claims);
  } else {
    mcp.tool(
      "report",
      "Tell the assistant how the work stands. Nobody else reads your output.",
      {
        kind: z.enum(REPORT_KINDS),
        summary: z.string().describe("What happened or what is needed; at most 600 characters."),
        question: z.string().optional().describe("One concrete question for the user; only with waiting or blocked."),
        result: z.object({
          refs: z.array(z.object({
            type: z.string(), url: z.string().optional(), run_id: z.string().optional(), sha: z.string().optional(),
          })).optional(),
          notes: z.string().optional(),
        }).optional().describe("What to check; only with ready."),
      },
      (args) => answer(claims, "report", () => report(claims, args)),
    );
    if (githubEventsEnabled()) {
      mcp.tool(
        "pr_reply",
        "Answer one GitHub event from a [github_event] message on its pull request, as the user: under the review comment it answers, "
        + "or as a comment on the pull request. At most once per event, and only where the user allowed it.",
        {
          event_id: z.string().describe("The event_id from the [github_event] message."),
          body: z.string().describe(`The answer, in Markdown; at most ${REPLY_BODY_MAX} characters.`),
        },
        (args) => answer(claims, "pr_reply", () => prReply(claims, args)),
      );
    }
  }
  return mcp;
}

const claimsOf = new WeakMap<FastifyRequest, AssistantTokenClaims>();

/** The preHandler every route under `/v1/internal/` carries: no valid bearer, no answer. */
export async function assistantTokenAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const presented = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const verdict = verifyAssistantToken(presented, CLAW_ASSISTANT_TOKEN_KEY);
  if (!verdict.ok) return reply.status(401).send({ ok: false, error: "assistant token required" }) as never;
  claimsOf.set(req, verdict.claims);
}

/** Registers nothing unless the assistant is on, as the rest of the assistant's surface. */
export async function registerAssistantMcpRoutes(
  app: FastifyInstance, enabled: boolean = CLAW_ASSISTANT_ENABLED,
): Promise<void> {
  if (!enabled) return;
  app.all(ASSISTANT_MCP_PATH, { preHandler: assistantTokenAuth }, async (req, reply) => {
    const claims = claimsOf.get(req) as AssistantTokenClaims;
    const mcp = createAssistantMcpServer(claims);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined as never });
    await mcp.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  logger.info("assistant.mcp_routes_registered");
}
