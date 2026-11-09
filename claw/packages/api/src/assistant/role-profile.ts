// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What makes a turn an assistant turn: the one place a session's role is turned into its execute request.
 *
 * The role lives in `claw_assistants` and `claw_work_items`, server-side tables a caller cannot write. A
 * field on the session would not do: `config`, `team_role` and `parent_session_id` are caller input.
 *
 * A router turn is cut down to the assistant tools and its read-only lookups (`tools_allowlist`, which Brain enforces; `read-tools.ts`), given its
 * prompt and the current list of work items, and kept short. An observer turn is cut the same way, without the list. A worker turn gets its prompt and the one tool
 * it reports through. Both get a bearer for the assistant MCP service that names this turn.
 *
 * Applied wherever a turn's request is finished: when it is dispatched on the wire, when a queued message is
 * replayed, and when a doorbell is claimed. The claim is the one that matters most, since the row is written
 * at send time and the bearer expires, and the item list must be the one of that moment.
 */
import pino from "pino";
import { REMOTE_AGENT_TIMING } from "@claw/protocol";
import {
  CLAW_AGENT_GUIDELINE_ENABLED, CLAW_ASSISTANT_DECISION_WAIT_SEC, CLAW_ASSISTANT_ENABLED, CLAW_ASSISTANT_ROUTER_MAX_TURNS,
  CLAW_ASSISTANT_TOKEN_KEY, CLAW_ASSISTANT_TOOLS, CLAW_ASSISTANT_WORKER_MODEL, CLAW_REMOTE_AGENTS_ENABLED, INTERNAL_BACKEND_URL,
} from "../config.js";
import { db } from "../infra/db.js";
import { withAgentGuideline } from "../sessions/agent-guideline.js";
import { readGithubMcpSettings } from "../github-mcp/settings.js";
import { reviewProfileSession } from "../github-review/session-tools.js";
import { RUN_BUDGET_DEFAULT_SEC } from "../tasks/run-budget.js";
import { languageToAnswerIn, withReplyLanguage } from "./language.js";
import { memoryTurnRecallOn, reviewMemoryBlock, routerMemoryParts, routerTurnRecall, workerMemoryBlock } from "./memory-tools.js";
import {
  ASSISTANT_MCP_SERVER, confirmationRef, OBSERVER_PROMPT_VERSION, ROUTER_MEMORY_PROMPT_VERSION, ROUTER_MODEL_PROMPT_VERSION, ROUTER_PROMPT_VERSION,
  ROUTER_CITE_PROMPT_VERSION, ROUTER_READ_PROMPT_VERSION, ROUTER_REVIEW_PROMPT, TOOL_NAME_PREFIX, ROUTER_REVIEW_PROMPT_VERSION, WORKER_PROMPT_VERSION, WORK_EVENT_PREFIX, ROUTER_DISCIPLINE_PROMPT_VERSION, WORKER_DISCIPLINE_PROMPT_VERSION, renderModelChoice,
  renderObserverSystem, renderReviewState, renderRouterItems, renderRouterPrompt, renderWorkerSystem, withTurnState,
  ROUTER_DEVENV_PROMPT_VERSION, renderAttachedState, renderRouterDevenvSection,
  type AskedOfOtherLine, type ManifestItem,
} from "./prompts.js";
import { allowedModels, modelChoiceOn, platformModel, readModelPrefs } from "./model-choice.js";
import { rerunModelOf } from "./model-fallback.js";
import { AFTER_READ_TOOLS, routerLookups } from "./read-tools.js";
import { heldForPersonManifest, renderHeldForPerson } from "./holds.js";
import { triggerToolSettings } from "../triggers/mcp.js";
import { askedOfOthers, askedOfOthersTotals, type AskedOfOthersTotals } from "./requester-view.js";
import { reviewContextFor } from "./review-tools.js";
import { toldRefs } from "./told.js";
import { earlierFilesOf, promptImagesOf, renderFilesState } from "./files.js";
import { turnMessage } from "./inbound.js";
import { startWorkerRun } from "./run-started.js";
import { githubEventsEnabled } from "./github-events.js";
import { jobHttpSources, jobWatchesEnabled } from "./job-watch.js";
import { renderRouterProactiveSection, ROUTER_PROACTIVE_PROMPT_VERSION } from "./proactive-prompt.js";
import { renderRouterWritingSection, ROUTER_WRITING_PROMPT_VERSION } from "./writing-prompt.js";
import { devenvToolsOn } from "./devenv-tools.js";
import { remoteManifest } from "./remote-items.js";
import { renderRouterSelfSection, ROUTER_SELF_PROMPT_VERSION, selfStatusOn } from "./self-status.js";
import { assistantSchedulesOn, renderScheduleState } from "./schedules.js";
import { commandLanguage } from "./typed-commands.js";
import { mintAssistantToken, type AssistantTokenClaims } from "./token.js";
import { disciplineOn } from "./discipline.js";
import { applyRouterTurnSpeed, streamTextOn } from "./router-speed.js";
import { routerCite } from "./citations.js";
import { applyWorkerResearch, assistantResearchOn, RESEARCH_PROMPT_VERSION, ROUTER_RESEARCH_PROMPT } from "./research.js";

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
 * A closed development environment item (`kind = 'remote'`) whose machine is no longer one of the user's is not listed. A machine is
 * the user's while a connector of theirs that is not revoked has its name (a machine set up again under its name is theirs: the old
 * row is revoked, and the new one has the name), which is exactly what `devenv_list` names. The name of one that is not was the only
 * trace of it in the router's context, and an answer about the user's machines took it for one of theirs: "之前的 dev-box-1 已离线"
 * with no machine connected (DM21-zms-a, 2026-11-07). Only where remote agents are on: their tables exist only then.
 */
const CLOSED_ITEM_OF_REMOVED_MACHINE = `AND NOT (w.kind = 'remote' AND NOT EXISTS (
           SELECT 1 FROM claw_remote_connectors c
            WHERE c.owner_user_id = w.user_id AND c.revoked_at IS NULL
              AND (c.connector_id::text = w.params->>'connector_id'
                   OR left(btrim(regexp_replace(c.name, '[[:cntrl:][:space:]]+', ' ', 'g')), 60) = w.params->>'machine')))`;

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
       (SELECT w.* FROM claw_work_items w
         WHERE w.user_id = $1 AND w.board_state = 'done' AND w.closed_at > NOW() - $2::interval
           ${CLAW_REMOTE_AGENTS_ENABLED ? CLOSED_ITEM_OF_REMOVED_MACHINE : ""}
         ORDER BY w.seq DESC LIMIT $3)
     ) listed ORDER BY seq`,
    [userId, MANIFEST_CLOSED_WINDOW, MANIFEST_MAX_ITEMS],
  )).rows as Array<Record<string, unknown>>;
  // Development environment items: where each runs, and whether that machine is online now (`remote-items.ts`).
  const remote = await remoteManifest(userId, rows as Array<{ item_id: string; kind: string; params: unknown }>, REMOTE_AGENT_TIMING.onlineWindowMs);
  // The pull requests each item watches, and whether the user turned on automatic replies there: the router must not promise an
  // approval card for an answer that goes out without one.
  const watches = githubEventsEnabled() ? await itemWatches(userId, rows.map((r) => String(r.item_id))) : new Map<string, NonNullable<ManifestItem["watches"]>>();
  return rows.map((r) => ({
    itemId: String(r.item_id),
    seq: Number(r.seq),
    title: remote.get(String(r.item_id))?.title ?? String(r.title),
    boardState: String(r.board_state),
    summary: String(r.summary ?? ""),
    lastReportKind: (r.last_report_kind as string | null) ?? null,
    resultVersion: Number(r.result_version),
    pendingQuestion: (r.pending_question as string | null) ?? null,
    outcome: (r.outcome as string | null) ?? null,
    createdAt: (r.created_at as Date | null) ?? null,
    closedAt: (r.closed_at as Date | null) ?? null,
    ...(r.kind === "review" ? { review: reviewOf(r.params) } : {}),
    ...(remote.has(String(r.item_id)) ? { remote: remote.get(String(r.item_id)) } : {}),
    ...(watches.has(String(r.item_id)) ? { watches: watches.get(String(r.item_id)) } : {}),
  }));
}

/** The active pull request watches of these items of the user's, by item. */
async function itemWatches(userId: string, itemIds: string[]): Promise<Map<string, NonNullable<ManifestItem["watches"]>>> {
  const out = new Map<string, NonNullable<ManifestItem["watches"]>>();
  if (!itemIds.length) return out;
  const rows = (await db.query(
    `SELECT item_id, owner, repo, number, reply_allowed FROM claw_work_item_subscriptions
      WHERE user_id = $1 AND state = 'active' AND item_id = ANY($2::text[]) ORDER BY id`,
    [userId, itemIds],
  )).rows as Array<{ item_id: string; owner: string; repo: string; number: number; reply_allowed: boolean }>;
  for (const r of rows) {
    const list = out.get(r.item_id) ?? [];
    list.push({ pr: `${r.owner}/${r.repo}#${r.number}`, autoReply: r.reply_allowed === true });
    out.set(r.item_id, list);
  }
  return out;
}

/** The reviews the user asked of others, in the same window as their own items: the four facts each, read-only. */
export async function askedOfOthersManifest(userId: string): Promise<AskedOfOtherLine[]> {
  return (await askedOfOthers(db, userId, MANIFEST_CLOSED_WINDOW, MANIFEST_MAX_ITEMS)).map((a) => ({ itemId: a.item_id, view: a.view }));
}

/** The counts of those reviews in the same window, without the list's limit (`renderRouterItems` says them before the latest). */
export async function askedOfOthersTotalsManifest(userId: string): Promise<AskedOfOthersTotals> {
  return askedOfOthersTotals(db, userId, MANIFEST_CLOSED_WINDOW);
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
async function replyLanguageOf(task: Record<string, unknown>, sessionId: string): Promise<string | null> {
  const prompt = stringField(task, "prompt");
  if (!prompt) return null;
  return languageToAnswerIn(prompt.startsWith(WORK_EVENT_PREFIX) ? null : prompt, () => earlierUserMessages(sessionId));
}

/** The line `replyLanguageOf` worked out, put beside the message. */
function addReplyLanguage(task: Record<string, unknown>, language: string | null): void {
  const prompt = stringField(task, "prompt");
  if (prompt && language) task.prompt = withReplyLanguage(prompt, language);
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
    // What the router may look up itself (`read-tools.ts`): the read-only tools of the deployment's assistant plugin, and nothing
    // else of it but its reply-style rule (no skills or write tools; a plugin the message named is not one the read list can vouch
    // for, so it gives the router nothing); the reads of the user's own GitHub; their scheduled tasks; and the web.
    const lookups = await routerLookups(role.userId, sessionId, { mcpServers: task.mcp_servers, messageId, taskId, triggerKey: triggerToolSettings.key });
    const read = lookups.plugin;
    task.tools_allowlist = [ASSISTANT_TOOLS_PATTERN, ...lookups.allowlist];
    task.max_turns = CLAW_ASSISTANT_ROUTER_MAX_TURNS;
    // A turn that used every step on lookups still answers: Brain asks the model once more, for text only, and that text is delivered
    // as the turn's answer (`router-turn-end.ts`). Without it the person heard nothing (2026-11-06, bczh-202: 11 web lookups, no reply).
    task.report_at_turn_cap = true;
    // Only the assistant's own server, the plugin's read servers, the user's GitHub and the turn's own scheduled tasks: any other is
    // a connection made and a tool never offered. The GitHub entry is built here from the session, as `githubMcpServers` builds a
    // worker's; the `schedules` one is kept only when this API minted its bearer for this turn (`ownTriggerServer`).
    task.mcp_servers = { ...lookups.servers };
    // The plugin's log reads: bounded to their last lines, and masked before the model reads them (Brain, `log-reads.ts`).
    if (lookups.logReads) task.log_reads = lookups.logReads;
    else delete task.log_reads;
    for (const field of ["skills", "tool_ids", "plugin_id", "plugin_tools"]) delete task[field];
    if (read) {
      task.plugin_id = read.pluginId;
      task.plugin_tools = read.pluginTools;
    }
    // Once it has read one of their results, the turn no longer acts for the person: Brain refuses the acting tools. A GitHub or
    // web lookup that failed read nothing, and leaves the turn free to start the work instead.
    task.read_taint = {
      sources: lookups.allowlist, allow_after: AFTER_READ_TOOLS.map((t) => `${TOOL_NAME_PREFIX}${t}`), clean_failures: lookups.cleanFailures,
    };
    // Its say may cite what the lookups returned (`citations.ts`): Brain keeps their sources and hands say the ones it names.
    const cite = routerCite(lookups.githubServers, stringField(task, "prompt"), undefined, read?.servers ?? []);
    if (cite) task.cite = cite;
    else delete task.cite;
    // A router's deliver_text is its own writing, delivered at once: never checked as a worker's research report is.
    delete task.cite_check;
    // Neither the deployment's default MCP servers nor its default skills: the hint that lists them would follow the user's message.
    task.skip_platform_defaults = true;
    // The system prompt is the same on every turn, so it and the history after it come from the prompt cache. What changes
    // from turn to turn (the item list, what waits for the user, what the channel sent) goes with the message instead.
    const github = lookups.githubTools.length > 0;
    // The routing discipline (`discipline.ts`): per user while it is a canary, so the prompt stays the same from turn to turn for each.
    const discipline = disciplineOn(role.userId);
    withSystemAppend(task, renderRouterPrompt(
      { servers: read?.servers ?? [], github: lookups.githubTools, cite: cite !== null, githubBinding: readGithubMcpSettings().binding }, { discipline },
    ));
    // What it writes itself (a document, a draft, a translation), and how a file or a comment of its reaches the user (`writing-prompt.ts`).
    withSystemAppend(task, renderRouterWritingSection({ comment: assistantSchedulesOn() }));
    // A research report is a work item, never text the router writes from what it knows: after the writing section, which it narrows.
    const research = assistantResearchOn(role.userId);
    if (research) withSystemAppend(task, ROUTER_RESEARCH_PROMPT);
    // The language this turn answers in (`language.ts`), worked out once: beside the message, and in every command the turn's state
    // tells the router the user can type back (`typed-commands.ts`), so that a hint repeated to the user is in their language.
    const replyLanguage = await replyLanguageOf(task, sessionId);
    const commands = commandLanguage(replyLanguage);
    const asked = await askedOfOthersManifest(role.userId);
    const state = [renderRouterItems(await routerManifest(role.userId), asked, new Date(), asked.length ? await askedOfOthersTotalsManifest(role.userId) : undefined)];
    // What a worker holds for the person (a write to approve, a question to answer): theirs to answer on its card, and the router's to point at.
    const held = renderHeldForPerson(await heldForPersonManifest(role.userId));
    if (held) state.push(held);
    // What the person sent beside their words (`files.ts`): the router is told what came, and is shown the pictures itself (Brain
    // reads them from this session's uploads), since it has no sandbox to open them in.
    const message = await turnMessage((t, p) => db.query(t, p), sessionId, messageId);
    const files = message?.context.files ?? [];
    // And what they sent earlier in the conversation, which a new item gets too (`earlierFilesOf`): a follow-up is about those.
    const earlier = message ? await earlierFilesOf((t, p) => db.query(t, p), sessionId, messageId, files) : [];
    if (files.length || earlier.length) state.push(renderFilesState(files, earlier));
    // Which session the chat the message came from is attached to, when the channel said (`channel_context.attached`).
    if (message?.context.attached !== undefined) state.push(renderAttachedState(message.context.attached));
    if (files.length) {
      const images = promptImagesOf(files);
      if (images.length) task.prompt_images = images;
    }
    if (CLAW_ASSISTANT_TOOLS) {
      withSystemAppend(task, ROUTER_REVIEW_PROMPT);
      const review = await reviewContextFor(role.userId, sessionId, messageId);
      const ctx = review.message?.context;
      const told = await toldRefs((t, p) => db.query(t, p), role.userId,
        review.confirmations.map((c) => ({ ref: confirmationRef(c.id), since: c.created_at })));
      state.push(renderReviewState({
        confirmations: review.confirmations.map((c) => ({ ...c, told_at: told.get(confirmationRef(c.id)) ?? null })), reviewMode: review.reviewMode,
        people: ctx?.people ?? [], actions: ctx?.actions ?? [], repos: ctx?.repos ?? [], commands,
      }));
    }
    const memory = await routerMemoryParts(role.userId, sessionId);
    if (memory) {
      withSystemAppend(task, memory.prompt);
      if (memory.entries) state.push(memory.entries);
    }
    // The entries the person's message is about, in full, beside the index (`CLAW_MEMORY_TURN_RECALL`): only where the index is shown.
    const recall = memory?.entries && message?.content && memoryTurnRecallOn(role.userId)
      ? await routerTurnRecall(role.userId, sessionId, message.content)
      : null;
    if (recall) state.push(recall.text);
    const devenv = devenvToolsOn();
    if (devenv) withSystemAppend(task, renderRouterDevenvSection({ actions: CLAW_ASSISTANT_TOOLS, send: true }));
    // Who it is (Clawy, with claw_self_status) and how to count what a lookup returned: the same on every turn, so it stays cached.
    const self = selfStatusOn();
    withSystemAppend(task, renderRouterSelfSection(self));
    const proactive = {
      schedules: assistantSchedulesOn(), jobs: jobWatchesEnabled(), pullRequests: githubEventsEnabled(),
      jobKinds: jobHttpSources().map((k) => ({ kind: k.kind, description: k.description })),
    };
    const proactiveSection = renderRouterProactiveSection(proactive);
    if (proactiveSection) withSystemAppend(task, proactiveSection);
    if (proactive.schedules) state.push(await renderScheduleState(role.userId, commands));
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
    // Little thinking, and the say streamed while it is written (`router-speed.ts`); for the users who have it, the turn's own text
    // too, when it answers them (a worker's report is not theirs: what the turn writes then is not for them).
    applyRouterTurnSpeed(task, undefined, streamTextOn(role.userId) && !stringField(task, "prompt").startsWith(WORK_EVENT_PREFIX));
    addReplyLanguage(task, replyLanguage);
    // Even with no words (a turn the system starts): the list is what the prompt says to answer from.
    task.prompt = withTurnState(stringField(task, "prompt"), state);
    logger.info({
      sessionId, taskId, prompt: CLAW_ASSISTANT_TOOLS ? ROUTER_REVIEW_PROMPT_VERSION : ROUTER_PROMPT_VERSION, base: ROUTER_PROMPT_VERSION,
      ...(memory ? { memory: ROUTER_MEMORY_PROMPT_VERSION } : {}), ...(recall ? { turnRecall: recall.ids } : {}),
      ...(choice ? { models: ROUTER_MODEL_PROMPT_VERSION } : {}),
      ...(proactiveSection ? { proactive: ROUTER_PROACTIVE_PROMPT_VERSION } : {}),
      ...(devenv ? { devenv: ROUTER_DEVENV_PROMPT_VERSION } : {}),
      read: ROUTER_READ_PROMPT_VERSION, write: ROUTER_WRITING_PROMPT_VERSION, github, ...(read ? { readServers: read.servers, pluginId: read.pluginId } : {}),
      ...(cite ? { cite: ROUTER_CITE_PROMPT_VERSION } : {}), self: ROUTER_SELF_PROMPT_VERSION, selfStatus: self,
      ...(discipline ? { discipline: ROUTER_DISCIPLINE_PROMPT_VERSION } : {}),
      ...(research ? { research: RESEARCH_PROMPT_VERSION } : {}),
      ...(task.stream_text_as ? { streamText: true } : {}),
    }, "assistant.router_turn");
  } else {
    const started = await startWorkerRun(sessionId, taskId);
    if (!started) throw new Error("assistant.worker_item_missing");
    claims = { ...base, role: "worker", item_id: started.itemId, gen: started.generation };
    // With model choice on, the worker's session holds the model chosen for its item (`model-choice.ts`), and the deployment's worker
    // model only fills in for a session that names none. Off, it is every worker turn's model, as it always was.
    if (CLAW_ASSISTANT_WORKER_MODEL && !(modelChoiceOn() && stringField(task, "model"))) task.model = CLAW_ASSISTANT_WORKER_MODEL;
    const discipline = disciplineOn(role.userId);
    withSystemAppend(task, renderWorkerSystem({ seq: started.seq, title: started.title }, { discipline }));
    // A worker does its item's work in the sandbox, so Brain opens it beside the turn's first model call rather than after it.
    task.sandbox_prestart = true;
    // A write it holds, or a question it asks, waits for a person who is told on their channel and may be away: not Brain's minutes.
    if (CLAW_ASSISTANT_DECISION_WAIT_SEC > 0) task.decision_wait_ms = CLAW_ASSISTANT_DECISION_WAIT_SEC * 1000;
    const memory = await workerMemoryBlock(role.userId, started.itemId, sessionId);
    if (memory) withSystemAppend(task, memory);
    // A research report: its method, and its deliver_text checked against its citations by Brain before the file is stored.
    const research = applyWorkerResearch(task, (text) => withSystemAppend(task, text), assistantResearchOn(role.userId));
    logger.info({
      sessionId, taskId, itemId: started.itemId, generation: started.generation,
      prompt: discipline ? WORKER_DISCIPLINE_PROMPT_VERSION : WORKER_PROMPT_VERSION,
      ...(research ? { research: RESEARCH_PROMPT_VERSION } : {}),
    }, "assistant.worker_turn");
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
