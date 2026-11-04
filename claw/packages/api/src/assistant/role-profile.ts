// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What makes a turn an assistant turn: the one place a session's role is turned into its execute request.
 *
 * The role lives in `claw_assistants` and `claw_work_items`, server-side tables a caller cannot write. A
 * field on the session would not do: `config`, `team_role` and `parent_session_id` are caller input.
 *
 * A router turn is cut down to the assistant tools (`tools_allowlist`, which Brain enforces), given its
 * prompt and the current list of work items, and kept short. A worker turn gets its prompt and the one tool
 * it reports through. Both get a bearer for the assistant MCP service that names this turn.
 *
 * Applied wherever a turn's request is finished: when it is dispatched on the wire, when a queued message is
 * replayed, and when a doorbell is claimed. The claim is the one that matters most, since the row is written
 * at send time and the bearer expires, and the item list must be the one of that moment.
 */
import pino from "pino";
import {
  CLAW_AGENT_GUIDELINE_ENABLED, CLAW_ASSISTANT_ENABLED, CLAW_ASSISTANT_ROUTER_MAX_TURNS, CLAW_ASSISTANT_TOKEN_KEY,
  CLAW_ASSISTANT_TOOLS, CLAW_ASSISTANT_WORKER_MODEL, INTERNAL_BACKEND_URL,
} from "../config.js";
import { db } from "../infra/db.js";
import { withAgentGuideline } from "../sessions/agent-guideline.js";
import { RUN_BUDGET_DEFAULT_SEC } from "../tasks/run-budget.js";
import { languageToAnswerIn, withReplyLanguage } from "./language.js";
import {
  ASSISTANT_MCP_SERVER, ROUTER_PROMPT_VERSION, ROUTER_REVIEW_PROMPT_VERSION, WORKER_PROMPT_VERSION, WORK_EVENT_PREFIX,
  renderReviewContext, renderRouterSystem, renderWorkerSystem, type ManifestItem,
} from "./prompts.js";
import { reviewContextFor } from "./review-tools.js";
import { startWorkerRun } from "./run-started.js";
import { mintAssistantToken, type AssistantTokenClaims } from "./token.js";

const logger = pino({ name: "assistant-role" });

export { ASSISTANT_MCP_SERVER };
export const ASSISTANT_MCP_PATH = "/v1/internal/assistant-mcp";
/** Every tool of the assistant MCP service, as Brain names them. */
export const ASSISTANT_TOOLS_PATTERN = `mcp__${ASSISTANT_MCP_SERVER}__*`;

/** Closed work items the Router still sees, so "what happened with #3?" has an answer. */
const MANIFEST_CLOSED_WINDOW = "24 hours";
const MANIFEST_MAX_ITEMS = 20;
/** A token outlives the longest turn a row can hold; whether the turn is still live is asked on every call. */
const TOKEN_GRACE_SEC = 60 * 60;
const TOKEN_FALLBACK_TTL_SEC = 7 * 24 * 60 * 60;

export type SessionRole =
  | { role: "router"; userId: string }
  | { role: "worker"; userId: string; itemId: string; seq: number; title: string };

/**
 * Null for every session that is neither a user's assistant nor a task item's worker. A review item's session is an ordinary session that
 * acts as a user: it gets no report tool, no worker prompt and no worker model, and its item's state is read off what it did.
 */
export async function sessionRole(sessionId: string): Promise<SessionRole | null> {
  const rows = (await db.query(
    `SELECT 'router' AS role, a.user_id, NULL AS item_id, NULL::int AS seq, NULL AS title
       FROM claw_assistants a WHERE a.session_id = $1
     UNION ALL
     SELECT 'worker', w.user_id, w.item_id, w.seq, w.title
       FROM claw_work_items w WHERE w.worker_session_id = $1 AND w.kind = 'task'`,
    [sessionId],
  )).rows as Array<{ role: string; user_id: string; item_id: string | null; seq: number | null; title: string | null }>;
  const row = rows[0];
  if (!row) return null;
  if (row.role === "router") return { role: "router", userId: row.user_id };
  return { role: "worker", userId: row.user_id, itemId: row.item_id as string, seq: Number(row.seq), title: row.title as string };
}

/** Whether a turn of this session must skip skill selection, which costs an LLM call a router has no use for. */
export async function skipsSkillSelection(sessionId: string): Promise<boolean> {
  if (!CLAW_ASSISTANT_ENABLED) return false;
  return (await sessionRole(sessionId))?.role === "router";
}

export async function routerManifest(userId: string): Promise<ManifestItem[]> {
  const rows = (await db.query(
    `SELECT item_id, seq, title, summary, board_state, last_report_kind, result_version, pending_question, kind, params FROM (
       SELECT * FROM claw_work_items
        WHERE user_id = $1
          AND (board_state <> 'done' OR closed_at > NOW() - $2::interval)
        ORDER BY seq DESC LIMIT $3
     ) newest ORDER BY seq`,
    [userId, MANIFEST_CLOSED_WINDOW, MANIFEST_MAX_ITEMS],
  )).rows as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    itemId: String(r.item_id),
    seq: Number(r.seq),
    title: String(r.title),
    boardState: String(r.board_state),
    summary: String(r.summary ?? ""),
    lastReportKind: (r.last_report_kind as string | null) ?? null,
    resultVersion: Number(r.result_version),
    pendingQuestion: (r.pending_question as string | null) ?? null,
    ...(r.kind === "review" ? { review: reviewOf(r.params) } : {}),
  }));
}

function reviewOf(params: unknown): NonNullable<ManifestItem["review"]> {
  const p = (params && typeof params === "object" ? params : {}) as Record<string, any>;
  const pr = p.pr && typeof p.pr === "object" ? `${p.pr.owner}/${p.pr.repo}#${p.pr.number}` : "?";
  return {
    pr,
    actingAsName: typeof p.acting_as_name === "string" ? p.acting_as_name : null,
    model: typeof p.model === "string" ? p.model : null,
    reviewOnly: p.review_only !== false,
  };
}

/** How far back the user's own messages are read for a language, when the current one does not show it. */
const LANGUAGE_LOOKBACK_MESSAGES = 5;

/** What the user wrote to this assistant before, newest first. A worker's report is not theirs. */
async function earlierUserMessages(sessionId: string): Promise<string[]> {
  const rows = (await db.query(
    `SELECT content FROM claw_conversation_turns
      WHERE session_id = $1 AND role = 'user' AND deleted_at IS NULL AND NOT starts_with(content, $2)
      ORDER BY turn_index DESC LIMIT $3`,
    [sessionId, WORK_EVENT_PREFIX, LANGUAGE_LOOKBACK_MESSAGES],
  )).rows as Array<{ content: string }>;
  return rows.map((r) => r.content);
}

/**
 * Say in which language to answer, beside the message being answered (`language.ts`). The message the turn starts
 * with is the user's own, or a worker's report that woke the assistant; a report says nothing about the user's
 * language, so for it the language is the one they last wrote in. Only the request changes: the turn that is stored
 * and shown is the user's words as they sent them.
 */
async function addReplyLanguage(task: Record<string, unknown>, sessionId: string): Promise<void> {
  const prompt = stringField(task, "prompt");
  if (!prompt) return;
  const language = await languageToAnswerIn(
    prompt.startsWith(WORK_EVENT_PREFIX) ? null : prompt, () => earlierUserMessages(sessionId),
  );
  if (language) task.prompt = withReplyLanguage(prompt, language);
}

export function tokenTtlSeconds(): number {
  const budget = RUN_BUDGET_DEFAULT_SEC.chat;
  return budget > 0 ? budget + TOKEN_GRACE_SEC : TOKEN_FALLBACK_TTL_SEC;
}

function stringField(task: Record<string, unknown>, name: string): string {
  const v = task[name];
  return typeof v === "string" ? v : "";
}

function withSystemAppend(task: Record<string, unknown>, text: string): void {
  const existing = stringField(task, "system_append");
  task.system_append = existing ? `${existing}\n\n${text}` : text;
}

/**
 * Finish the execute request of a turn: the working guideline for every turn that does the user's work, when
 * it is switched on, and an assistant session's role. A Router turn only dispatches, under its own prompt, so
 * it gets no guideline.
 *
 * Fails closed: a router turn whose profile could not be applied would run with every tool Brain has, so
 * an error here ends the dispatch or the claim and is retried, never skipped.
 */
export async function applySessionRoleToTask(task: Record<string, unknown>, sessionId: string): Promise<void> {
  const role = CLAW_ASSISTANT_ENABLED ? await sessionRole(sessionId) : null;
  if (CLAW_AGENT_GUIDELINE_ENABLED && role?.role !== "router") withAgentGuideline(task);
  if (!role) return;
  const taskId = stringField(task, "task_id");
  const messageId = stringField(task, "message_id");
  if (!taskId || !messageId) throw new Error("assistant.role_profile_without_run_identity");
  const exp = Math.floor(Date.now() / 1000) + tokenTtlSeconds();
  const base = { sid: sessionId, mid: messageId, task_id: taskId, exp };

  let claims: AssistantTokenClaims;
  if (role.role === "router") {
    claims = { ...base, role: "router" };
    task.tools_allowlist = [ASSISTANT_TOOLS_PATTERN];
    task.max_turns = CLAW_ASSISTANT_ROUTER_MAX_TURNS;
    // Only the assistant's own server: every other one is a connection made and a tool never offered.
    task.mcp_servers = {};
    for (const field of ["skills", "tool_ids", "plugin_id", "plugin_tools"]) delete task[field];
    withSystemAppend(task, renderRouterSystem(await routerManifest(role.userId)));
    if (CLAW_ASSISTANT_TOOLS) {
      const review = await reviewContextFor(role.userId, sessionId, messageId);
      const ctx = review.message?.context;
      withSystemAppend(task, renderReviewContext({
        confirmations: review.confirmations, reviewMode: review.reviewMode,
        people: ctx?.people ?? [], actions: ctx?.actions ?? [], repos: ctx?.repos ?? [],
      }));
    }
    await addReplyLanguage(task, sessionId);
    logger.info({ sessionId, taskId, prompt: CLAW_ASSISTANT_TOOLS ? ROUTER_REVIEW_PROMPT_VERSION : ROUTER_PROMPT_VERSION }, "assistant.router_turn");
  } else {
    const started = await startWorkerRun(sessionId, taskId);
    if (!started) throw new Error("assistant.worker_item_missing");
    claims = { ...base, role: "worker", item_id: started.itemId, gen: started.generation };
    if (CLAW_ASSISTANT_WORKER_MODEL) task.model = CLAW_ASSISTANT_WORKER_MODEL;
    withSystemAppend(task, renderWorkerSystem({ seq: started.seq, title: started.title }));
    logger.info({ sessionId, taskId, itemId: started.itemId, generation: started.generation, prompt: WORKER_PROMPT_VERSION }, "assistant.worker_turn");
  }

  // Replaces a server of the same name that the request carried: the user's own session config must not
  // be able to point the assistant at another address.
  task.mcp_servers = {
    ...(task.mcp_servers as Record<string, Record<string, unknown>> | undefined),
    [ASSISTANT_MCP_SERVER]: {
      type: "http",
      url: `${INTERNAL_BACKEND_URL}${ASSISTANT_MCP_PATH}`,
      token: mintAssistantToken(claims, CLAW_ASSISTANT_TOKEN_KEY),
    },
  };
}
