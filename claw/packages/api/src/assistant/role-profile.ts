// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What makes a turn an assistant turn: the one place a session's role is turned into its execute request.
 *
 * The role lives in `claw_assistants` and `claw_work_items`, server-side tables a caller cannot write. A
 * field on the session would not do: `config`, `team_role` and `parent_session_id` are caller input.
 *
 * A router turn is cut down to the assistant tools (`tools_allowlist`, which Brain enforces), given its
 * prompt and the current list of work items, and kept short. An observer turn is cut the same way, without the list. A worker turn gets its prompt and the one tool
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
import { reviewProfileSession } from "../github-review/session-tools.js";
import { RUN_BUDGET_DEFAULT_SEC } from "../tasks/run-budget.js";
import { languageToAnswerIn, withReplyLanguage } from "./language.js";
import { reviewMemoryBlock, routerMemoryParts, workerMemoryBlock } from "./memory-tools.js";
import {
  ASSISTANT_MCP_SERVER, OBSERVER_PROMPT_VERSION, ROUTER_MEMORY_PROMPT_VERSION, ROUTER_MODEL_PROMPT_VERSION, ROUTER_PROMPT_VERSION,
  ROUTER_READ_PROMPT_VERSION, ROUTER_REVIEW_PROMPT, TOOL_NAME_PREFIX, ROUTER_REVIEW_PROMPT_VERSION, WORKER_PROMPT_VERSION, WORK_EVENT_PREFIX, renderModelChoice,
  renderObserverSystem, renderReviewState, renderRouterItems, renderRouterPrompt, renderWorkerSystem, withTurnState,
  type AskedOfOtherLine, type ManifestItem,
} from "./prompts.js";
import { allowedModels, modelChoiceOn, platformModel, readModelPrefs } from "./model-choice.js";
import { rerunModelOf } from "./model-fallback.js";
import { AFTER_READ_TOOLS, routerReadTools } from "./read-tools.js";
import { askedOfOthers } from "./requester-view.js";
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
  | { role: "worker"; userId: string; itemId: string; seq: number; title: string }
  /** A scope's watcher (`observe.ts`): a router's tools, every one of which only records. */
  | { role: "observer"; userId: string; scope: string };

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
       FROM claw_work_items w WHERE w.worker_session_id = $1 AND w.kind = 'task'
     UNION ALL
     SELECT 'observer', o.user_id, NULL, NULL, o.scope
       FROM claw_assistant_scopes o WHERE o.session_id = $1`,
    [sessionId],
  )).rows as Array<{ role: string; user_id: string; item_id: string | null; seq: number | null; title: string | null }>;
  const row = rows[0];
  if (!row) return null;
  if (row.role === "router") return { role: "router", userId: row.user_id };
  if (row.role === "observer") return { role: "observer", userId: row.user_id, scope: row.title as string };
  return { role: "worker", userId: row.user_id, itemId: row.item_id as string, seq: Number(row.seq), title: row.title as string };
}

/**
 * Whether a turn of this session must skip skill selection: a router's or an observer's, which costs an LLM call they have no use for, and a review someone
 * asked of the owner, whose fixed profile has none of the owner's skills (`github-review/review-profile.ts`). Both skill entries (the
 * immediate turn and the queued one) ask here.
 */
export async function skipsSkillSelection(sessionId: string): Promise<boolean> {
  if (await reviewProfileSession(sessionId)) return true;
  if (!CLAW_ASSISTANT_ENABLED) return false;
  const role = (await sessionRole(sessionId))?.role;
  return role === "router" || role === "observer";
}

/**
 * The router's item list: every open item, and the newest items closed in the last day. Open items are never cut: the
 * prompt tells the router that an item missing from the list is closed, which holds only while all open ones are in it.
 * Their number is bounded where they are made (`insertWorkItem`: the user's own, and reviews others asked of them).
 */
export async function routerManifest(userId: string): Promise<ManifestItem[]> {
  const rows = (await db.query(
    `SELECT item_id, seq, title, summary, board_state, last_report_kind, result_version, pending_question, kind, params,
            outcome, created_at, closed_at FROM (
       (SELECT * FROM claw_work_items WHERE user_id = $1 AND board_state <> 'done')
       UNION ALL
       (SELECT * FROM claw_work_items
         WHERE user_id = $1 AND board_state = 'done' AND closed_at > NOW() - $2::interval
         ORDER BY seq DESC LIMIT $3)
     ) listed ORDER BY seq`,
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
    outcome: (r.outcome as string | null) ?? null,
    createdAt: (r.created_at as Date | null) ?? null,
    closedAt: (r.closed_at as Date | null) ?? null,
    ...(r.kind === "review" ? { review: reviewOf(r.params) } : {}),
  }));
}

/** The reviews the user asked of others, in the same window as their own items: the four facts each, read-only. */
export async function askedOfOthersManifest(userId: string): Promise<AskedOfOtherLine[]> {
  return (await askedOfOthers(db, userId, MANIFEST_CLOSED_WINDOW, MANIFEST_MAX_ITEMS)).map((a) => ({ itemId: a.item_id, view: a.view }));
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
  if (CLAW_AGENT_GUIDELINE_ENABLED && role?.role !== "router" && role?.role !== "observer") withAgentGuideline(task);
  if (!role) {
    // A review item's session is an ordinary one; what the person bound to its item is all it is shown of their memory.
    const memory = CLAW_ASSISTANT_ENABLED ? await reviewMemoryBlock(sessionId) : null;
    if (memory) withSystemAppend(task, memory);
    return;
  }
  const taskId = stringField(task, "task_id");
  const messageId = stringField(task, "message_id");
  if (!taskId || !messageId) throw new Error("assistant.role_profile_without_run_identity");
  const exp = Math.floor(Date.now() / 1000) + tokenTtlSeconds();
  const base = { sid: sessionId, mid: messageId, task_id: taskId, exp };

  let claims: AssistantTokenClaims;
  if (role.role === "observer") {
    // A router's cut, with none of the owner's own items in view: what is said here comes from other people.
    claims = { ...base, role: "observer" };
    task.tools_allowlist = [ASSISTANT_TOOLS_PATTERN];
    task.max_turns = CLAW_ASSISTANT_ROUTER_MAX_TURNS;
    task.mcp_servers = {};
    for (const field of ["skills", "tool_ids", "plugin_id", "plugin_tools"]) delete task[field];
    task.skip_platform_defaults = true;
    withSystemAppend(task, renderObserverSystem(role.scope));
    logger.info({ sessionId, taskId, scope: role.scope, prompt: OBSERVER_PROMPT_VERSION }, "assistant.observer_turn");
  } else if (role.role === "router") {
    claims = { ...base, role: "router" };
    // The read-only tools of the deployment's assistant plugin (`read-tools.ts`), and nothing else of it: no skills, rules or write
    // tools. A plugin the message named is not one the read list can vouch for, so it gives the router nothing.
    const read = await routerReadTools(role.userId);
    task.tools_allowlist = [ASSISTANT_TOOLS_PATTERN, ...(read?.allowlist ?? [])];
    task.max_turns = CLAW_ASSISTANT_ROUTER_MAX_TURNS;
    // Only the assistant's own server and the plugin's read servers: any other is a connection made and a tool never offered.
    task.mcp_servers = {};
    for (const field of ["skills", "tool_ids", "plugin_id", "plugin_tools"]) delete task[field];
    if (read) {
      task.plugin_id = read.pluginId;
      task.plugin_tools = read.pluginTools;
      // Once it has read one of their results, the turn no longer acts for the person: Brain refuses the acting tools.
      task.read_taint = { sources: read.allowlist, allow_after: AFTER_READ_TOOLS.map((t) => `${TOOL_NAME_PREFIX}${t}`) };
    }
    // Neither the deployment's default MCP servers nor its default skills: the hint that lists them would follow the user's message.
    task.skip_platform_defaults = true;
    // The system prompt is the same on every turn, so it and the history after it come from the prompt cache. What changes
    // from turn to turn (the item list, what waits for the user, what the channel sent) goes with the message instead.
    withSystemAppend(task, renderRouterPrompt(read?.servers ?? []));
    const state = [renderRouterItems(await routerManifest(role.userId), await askedOfOthersManifest(role.userId))];
    if (CLAW_ASSISTANT_TOOLS) {
      withSystemAppend(task, ROUTER_REVIEW_PROMPT);
      const review = await reviewContextFor(role.userId, sessionId, messageId);
      const ctx = review.message?.context;
      state.push(renderReviewState({
        confirmations: review.confirmations, reviewMode: review.reviewMode,
        people: ctx?.people ?? [], actions: ctx?.actions ?? [], repos: ctx?.repos ?? [],
      }));
    }
    const memory = await routerMemoryParts(role.userId, sessionId);
    if (memory) {
      withSystemAppend(task, memory.prompt);
      if (memory.entries) state.push(memory.entries);
    }
    const choice = modelChoiceOn();
    if (choice) {
      // The allow-list with its labels and the user's own defaults, so that "the fast one" becomes a name the tools take. In the
      // system prompt: it changes only when the user changes a default, not from turn to turn.
      const prefs = await readModelPrefs((t, p) => db.query(t, p), role.userId);
      withSystemAppend(task, renderModelChoice({
        models: allowedModels(), defaultModel: prefs.default_model, reviewModel: prefs.review_model,
        platformTask: platformModel("task"), platformReview: platformModel("review"),
      }));
      // A turn the gateway refused for want of a key binding, run again on the fallback (`model-fallback.ts`): this turn only.
      const rerun = await rerunModelOf(sessionId, messageId);
      if (rerun) task.model = rerun;
    }
    await addReplyLanguage(task, sessionId);
    // Even with no words (a turn the system starts): the list is what the prompt says to answer from.
    task.prompt = withTurnState(stringField(task, "prompt"), state);
    logger.info({
      sessionId, taskId, prompt: CLAW_ASSISTANT_TOOLS ? ROUTER_REVIEW_PROMPT_VERSION : ROUTER_PROMPT_VERSION, base: ROUTER_PROMPT_VERSION,
      ...(memory ? { memory: ROUTER_MEMORY_PROMPT_VERSION } : {}), ...(choice ? { models: ROUTER_MODEL_PROMPT_VERSION } : {}),
      ...(read ? { read: ROUTER_READ_PROMPT_VERSION, readServers: read.servers, pluginId: read.pluginId } : {}),
    }, "assistant.router_turn");
  } else {
    const started = await startWorkerRun(sessionId, taskId);
    if (!started) throw new Error("assistant.worker_item_missing");
    claims = { ...base, role: "worker", item_id: started.itemId, gen: started.generation };
    // With model choice on, the worker's session holds the model chosen for its item (`model-choice.ts`), and the deployment's worker
    // model only fills in for a session that names none. Off, it is every worker turn's model, as it always was.
    if (CLAW_ASSISTANT_WORKER_MODEL && !(modelChoiceOn() && stringField(task, "model"))) task.model = CLAW_ASSISTANT_WORKER_MODEL;
    withSystemAppend(task, renderWorkerSystem({ seq: started.seq, title: started.title }));
    const memory = await workerMemoryBlock(role.userId, started.itemId, sessionId);
    if (memory) withSystemAppend(task, memory);
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
