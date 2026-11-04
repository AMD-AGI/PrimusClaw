// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The router's tools that act for the person: start or restart a review, answer a held write, set the review mode, and
 * have a channel run one of its own settings. Offered only with `CLAW_ASSISTANT_TOOLS=on`.
 *
 * What a model says is never what lets these act. Each one asks two things of the database, in code:
 *
 *  - the person is behind this turn: the turn answers a message the route recorded as carried by an identity-provider
 *    token (`inbound.ts`), received at most `CLAW_ASSISTANT_ATTENDED_TTL_SEC` ago. A turn a worker's report started has
 *    no such message, and neither has one sent with a key, which any sandbox of the user holds;
 *  - what it names was named by the person: a pull request's number is in their message, a reviewer is them or someone
 *    the channel listed beside the message with a Claw user id, a repository or a model is in the message (or, for a
 *    repository, one the channel or their recent reviews use). Text from reports or recalled items is not their message.
 *
 * Everything past that is the review's own gates, which these call rather than repeat: creating, stopping and restarting
 * a review item is `review-items.ts`; answering a held write is the review service's `decide`, which checks the head
 * commit and every gate again.
 */
import pino from "pino";
import { parsePrRef, type PrRef } from "../github-review/github.js";
import { githubReviewService } from "../github-review/mcp.js";
import { getReviewMode, setReviewMode } from "../github-review/store.js";
import { db, inTransaction, type Querier } from "../infra/db.js";
import { deterministicEventId, enqueue, kickDelivery } from "../notifications/outbox.js";
import type { AssistantActionPayload } from "../notifications/assistant-events.js";
import { decidedViaOf, turnMessage, type AttendedVia, type TurnMessage } from "./inbound.js";
import { restartReviewItem, startReviewItems, type ReviewItemsResult } from "./review-items.js";
import type { AssistantTokenClaims } from "./token.js";
import { assertLiveRun, ToolRefused } from "./tools.js";
import { resolveWorkItemNow } from "./work-items.js";

const logger = pino({ name: "assistant-review-tools" });

/** The ways out of this module, so a test can stand in for what lies beyond the HTTP boundary of each. */
export const reviewToolPorts = {
  startReviewItems,
  restartReviewItem,
  decide: (userId: string, id: string, decision: "allow" | "deny", via: ReturnType<typeof decidedViaOf>) =>
    githubReviewService().decide(userId, id, decision, via),
  kick: (): Promise<void> => kickDelivery(),
};

export const MAX_PRS = 10;
const ACTION_ARGS_MAX = 200;
/** How far back a repository the user reviewed in counts as one they meant when they give only a number. */
const RECENT_REPO_WINDOW = "7 days";
export const LOOSER_MODE = "fully_auto";
export const REVIEW_MODES_SETTABLE = ["high_risk_confirm"] as const;

function requireRouter(claims: AssistantTokenClaims): void {
  if (claims.role !== "router") throw new ToolRefused("not_allowed", `this tool is for the router, not the ${claims.role}`);
}

/**
 * The live turn, its user, and the person's message it answers, or a refusal that says which of them is missing.
 * `q` is a transaction's: the session row stays held (`assertLiveRun`) until the write it protects is done.
 */
export async function attendedTurn(
  q: Querier, claims: AssistantTokenClaims,
): Promise<{ userId: string; message: TurnMessage; via: AttendedVia }> {
  const { userId } = await assertLiveRun(q, claims);
  const message = await turnMessage(q, claims.sid, claims.mid);
  if (!message || !message.attendedVia) {
    throw new ToolRefused(
      "not_attended",
      "this turn does not answer a message the user sent signed in (it is a report, or the message came with a key), so it cannot act for them: tell the user what you would do and ask them to say it in chat",
    );
  }
  if (!message.fresh) {
    throw new ToolRefused("attendance_expired", "the user's message is too old to act on now: ask them to confirm in a new message");
  }
  return { userId, message, via: message.attendedVia };
}

// --- Grounding: pure, so the evaluation and the tests ask the same question the tools do ------------------------

const lower = (s: string): string => s.toLowerCase();

/** Whether the number stands on its own in the text: `224`, `#224`, `224可以合入`, a pull request URL; not `1224` or `2240`. */
export function mentionsNumber(text: string, n: number): boolean {
  return new RegExp(`(?<![0-9])${n}(?![0-9])`).test(text);
}

/** Whether the repository is one the person meant: named in the message, the channel's own, or one they reviewed in lately. */
export function repoGrounded(text: string, pr: Pick<PrRef, "owner" | "repo">, channelRepos: readonly string[], recentRepos: readonly string[]): boolean {
  const full = lower(`${pr.owner}/${pr.repo}`);
  if ([...channelRepos, ...recentRepos].some((r) => lower(r) === full)) return true;
  const t = lower(text);
  if (t.includes(full)) return true;
  const name = lower(pr.repo).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9_.-])${name}(?![a-z0-9_-])`).test(t);
}

/**
 * Whether a model was asked for by name: one of the words that make its id (`opus` of `claude-opus-4-8`, `sonnet`, `gpt`)
 * is in the message. Version digits and one-letter parts say nothing on their own.
 */
export function modelGrounded(text: string, model: string): boolean {
  const t = lower(text);
  return lower(model).split(/[^a-z0-9]+/).some((part) => /^[a-z][a-z0-9]{2,}$/.test(part) && t.includes(part));
}

/** The pull requests a call names, parsed, or the refusal for the first that is not one. */
export function parsePrs(prs: unknown): PrRef[] {
  if (!Array.isArray(prs) || prs.length === 0) throw new ToolRefused("invalid_arguments", "prs needs at least one pull request, as owner/repo#number or its URL");
  if (prs.length > MAX_PRS) throw new ToolRefused("too_many_prs", `at most ${MAX_PRS} pull requests at once: ask the user which to start with`);
  const out: PrRef[] = [];
  for (const raw of prs) {
    const ref = parsePrRef(raw);
    if (!ref) throw new ToolRefused("invalid_arguments", `${String(raw).slice(0, 100)} is not owner/repo#number or a pull request URL`);
    out.push(ref);
  }
  return out;
}

async function recentReviewRepos(q: Querier, userId: string): Promise<string[]> {
  const rows = (await q(
    `SELECT DISTINCT (params->'pr'->>'owner') || '/' || (params->'pr'->>'repo') AS repo
       FROM claw_work_items WHERE user_id = $1 AND kind = 'review' AND created_at > NOW() - $2::interval`,
    [userId, RECENT_REPO_WINDOW],
  )).rows as Array<{ repo: string | null }>;
  return rows.map((r) => r.repo).filter((r): r is string => !!r);
}

function refuseUngrounded(code: string, message: string): never {
  throw new ToolRefused(code, message);
}

/** C1's answer, as the tool's: the same code, words and data, so the router reads what the interface said. */
function unwrap(result: ReviewItemsResult): Record<string, unknown> {
  if (!result.ok) throw new ToolRefused(result.error, result.message, result.data);
  return result.data;
}

// --- Tools ------------------------------------------------------------------------------------------------------

export async function reviewStart(
  claims: AssistantTokenClaims,
  args: { prs: unknown; reviewer?: string; merge: boolean; model?: string; effort?: string },
): Promise<Record<string, unknown>> {
  requireRouter(claims);
  const prs = parsePrs(args.prs);
  if (typeof args.merge !== "boolean") throw new ToolRefused("invalid_arguments", "merge must be true or false: true only when the user clearly asked to merge");
  // Asked here, so a refusal costs the review service nothing; the turn is asked again inside its write (`guard`).
  const ready = await inTransaction(async (q) => {
    const { userId, message, via } = await attendedTurn(q, claims);
    const recent = await recentReviewRepos(q, userId);
    for (const pr of prs) {
      if (!mentionsNumber(message.content, pr.number)) {
        refuseUngrounded("pr_not_in_message", `${pr.number} is not in the user's message: start only the pull requests they named`);
      }
      if (!repoGrounded(message.content, pr, message.context.repos, recent)) {
        refuseUngrounded("repo_not_grounded", `the user did not name ${pr.owner}/${pr.repo}: ask them which repository`);
      }
    }
    if (args.model && !modelGrounded(message.content, args.model)) {
      refuseUngrounded("model_not_in_message", "the user did not ask for that model: leave model out unless they named one");
    }
    if (!args.reviewer || args.reviewer === userId) return { userId, via, actingAs: userId, actingAsName: undefined };
    const reviewer = lower(args.reviewer);
    const person = message.context.people.find((p) => p.user_id === args.reviewer);
    if (person) return { userId, via, actingAs: args.reviewer, actingAsName: person.name };
    const named = message.context.people.some((p) => lower(p.name) === reviewer || (p.email !== undefined && lower(p.email) === reviewer));
    return refuseUngrounded(
      named ? "reviewer_not_linked" : "reviewer_not_in_message",
      named
        ? "that person has not linked their account, so nobody can review as them: tell the user"
        : "reviewer must be left out (the user), or be the user_id of someone in this message's people list",
    );
  });
  const result = await reviewToolPorts.startReviewItems({
    userId: ready.userId,
    attended: { via: decidedViaOf(ready.via), messageId: claims.mid },
    prs: prs.map((p) => ({ owner: p.owner, repo: p.repo, number: p.number })),
    actingAs: ready.actingAs, ...(ready.actingAsName ? { actingAsName: ready.actingAsName } : {}),
    ...(args.model ? { model: args.model } : {}), ...(args.effort ? { effort: args.effort } : {}),
    reviewOnly: !args.merge,
    guard: async (q) => { await attendedTurn(q, claims); },
  });
  return { ok: true, ...unwrap(result) };
}

/** The user's review items the router could mean, newest first: the open ones and those closed in the last day. */
async function reviewItemsOf(q: Querier, userId: string): Promise<Array<{ item_id: string; seq: number; params: Record<string, any> }>> {
  return (await q(
    `SELECT item_id, seq, params FROM claw_work_items
      WHERE user_id = $1 AND kind = 'review' AND (board_state <> 'done' OR closed_at > NOW() - INTERVAL '1 day')
      ORDER BY seq DESC`,
    [userId],
  )).rows as Array<{ item_id: string; seq: number; params: Record<string, any> }>;
}

export async function reviewRestart(
  claims: AssistantTokenClaims, args: { item_id: string; model?: string; merge?: boolean; effort?: string },
): Promise<Record<string, unknown>> {
  requireRouter(claims);
  let itemId = "";
  let via: AttendedVia | null = null;
  let userId = "";
  await inTransaction(async (q) => {
    const turn = await attendedTurn(q, claims);
    userId = turn.userId;
    via = turn.via;
    const named = await resolveWorkItemNow(userId, args.item_id);
    if (!named.ok) throw new ToolRefused(named.error, named.message);
    const reviews = await reviewItemsOf(q, userId);
    const item = reviews.find((r) => r.item_id === named.item.item_id);
    if (!item) throw new ToolRefused("not_a_review_item", "that item is not a review: only a review can be restarted");
    const number = Number(item.params?.pr?.number);
    const pointed = mentionsNumber(turn.message.content, number) || turn.message.content.includes(`#${item.seq}`)
      || reviews.length === 1;
    if (!pointed) refuseUngrounded("item_not_in_message", "the user did not say which review: ask them (the pull request number is enough)");
    if (args.model && !modelGrounded(turn.message.content, args.model)) {
      refuseUngrounded("model_not_in_message", "the user did not ask for that model: leave model out to keep the one it had");
    }
    itemId = item.item_id;
  });
  const result = await reviewToolPorts.restartReviewItem({
    userId, attended: { via: decidedViaOf(via as unknown as AttendedVia), messageId: claims.mid }, itemId,
    ...(args.model ? { model: args.model } : {}), ...(args.effort ? { effort: args.effort } : {}),
    ...(typeof args.merge === "boolean" ? { reviewOnly: !args.merge } : {}),
    guard: async (q) => { await attendedTurn(q, claims); },
  });
  return { ok: true, ...unwrap(result) };
}

interface PendingConfirmation { id: string; repo: string; pr: number; kind: string; created_at: Date; expires_at: Date }

/** What still waits for this user's own answer, as the acting user. */
export async function pendingConfirmationsFor(q: Querier, userId: string): Promise<PendingConfirmation[]> {
  return (await q(
    `SELECT confirmation_id AS id, repo, pr, kind, created_at, expires_at FROM claw_github_confirmations
      WHERE actor_user_id = $1 AND status = 'pending' AND expires_at > NOW() ORDER BY created_at`,
    [userId],
  )).rows as PendingConfirmation[];
}

export async function confirmationAnswer(
  claims: AssistantTokenClaims, args: { decision: "allow" | "deny"; confirmation_id?: string; pr?: string },
): Promise<Record<string, unknown>> {
  requireRouter(claims);
  if (args.decision !== "allow" && args.decision !== "deny") throw new ToolRefused("invalid_arguments", "decision must be allow or deny");
  const chosen = await inTransaction(async (q) => {
    const { userId, message, via } = await attendedTurn(q, claims);
    const pending = await pendingConfirmationsFor(q, userId);
    if (!pending.length) throw new ToolRefused("no_pending_confirmation", "nothing waits for the user's answer");
    let pick: PendingConfirmation | undefined;
    if (args.confirmation_id) {
      pick = pending.find((c) => c.id === args.confirmation_id);
    } else if (args.pr) {
      const ref = parsePrRef(args.pr);
      const n = ref?.number ?? Number(String(args.pr).replace(/^#/, ""));
      const matches = pending.filter((c) => c.pr === n && (!ref || lower(c.repo) === lower(`${ref.owner}/${ref.repo}`)));
      pick = matches.length === 1 ? matches[0] : undefined;
      if (matches.length > 1) throw new ToolRefused("which_confirmation", "more than one write waits on that pull request: pass confirmation_id");
    } else if (pending.length === 1) {
      pick = pending[0];
    } else {
      throw new ToolRefused("which_confirmation", "more than one write waits for the user: ask which pull request");
    }
    if (!pick) throw new ToolRefused("confirmation_not_found", "no write of that pull request waits for the user");
    // Saying yes is the person's say about one change: its number is in their words, or it was the only one waiting
    // when they wrote. Saying no only makes less happen, so it needs neither.
    if (args.decision === "allow") {
      const only = pending.length === 1 && message.receivedAt.getTime() >= new Date(pick.created_at).getTime();
      if (!mentionsNumber(message.content, pick.pr) && !only) {
        refuseUngrounded("pr_not_in_message", `the user's message does not name ${pick.repo}#${pick.pr}: ask them to say which pull request to let through`);
      }
    }
    return { userId, via, id: pick.id, repo: pick.repo, pr: pick.pr };
  });
  const answer = await reviewToolPorts.decide(chosen.userId, chosen.id, args.decision, decidedViaOf(chosen.via));
  if (answer.http >= 400) {
    const body = answer.body as { error?: string };
    throw new ToolRefused(String(body.error ?? "decision_refused"), "the decision was not taken");
  }
  return { ok: true, confirmation_id: chosen.id, pr: `${chosen.repo}#${chosen.pr}`, ...answer.body };
}

export async function reviewModeSet(claims: AssistantTokenClaims, args: { mode: string }): Promise<Record<string, unknown>> {
  requireRouter(claims);
  // Turning confirmations off is never the assistant's to do: one misreading would let every later merge through
  // unasked. It is a setting the person changes themselves.
  if (args.mode === LOOSER_MODE) {
    throw new ToolRefused("needs_the_person", "turning confirmations off is done by the user in their settings, not by the assistant: tell them where");
  }
  if (!(REVIEW_MODES_SETTABLE as readonly string[]).includes(args.mode)) {
    throw new ToolRefused("invalid_arguments", `mode must be one of ${REVIEW_MODES_SETTABLE.join(", ")}`);
  }
  return inTransaction(async (q) => {
    const { userId, via } = await attendedTurn(q, claims);
    const store = { query: (text: string, params?: unknown[]) => q(text, params) };
    const before = await getReviewMode(store, userId);
    const saved = await setReviewMode(store, userId, args.mode as "high_risk_confirm");
    logger.info({ userId, from: before.mode, to: saved.mode, via: via.kind }, "assistant.review_mode_set");
    return { ok: true, review_mode: saved.mode, was: before.mode };
  });
}

export async function channelAction(claims: AssistantTokenClaims, args: { name: string; args?: string }): Promise<Record<string, unknown>> {
  requireRouter(claims);
  const name = String(args.name ?? "").trim().replace(/^\/+/, "");
  const actionArgs = String(args.args ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!name) throw new ToolRefused("invalid_arguments", "name the action, as the channel listed it");
  if (actionArgs.length > ACTION_ARGS_MAX) throw new ToolRefused("invalid_arguments", `args is at most ${ACTION_ARGS_MAX} characters`);
  const sent = await inTransaction(async (q) => {
    const { userId, message } = await attendedTurn(q, claims);
    // Only what the channel that carried this message said it can do: Claw knows no channel's commands.
    if (!message.context.actions.some((a) => a.name === name)) {
      throw new ToolRefused("action_not_offered", "the channel did not list that action with this message: tell the user what to type instead");
    }
    if (!message.context.channel_message_id) {
      throw new ToolRefused("no_channel", "this message did not come through a channel that runs actions");
    }
    const eventId = deterministicEventId("assistant.action", claims.mid, `${name}\u0000${actionArgs}`);
    const payload: AssistantActionPayload = {
      type: "assistant.action", event_id: eventId, occurred_at: new Date().toISOString(), user_id: userId,
      message_id: claims.mid, channel_message_id: message.context.channel_message_id, action: { name, args: actionArgs },
    };
    const subs = (await q(
      `SELECT subscription_id FROM claw_notification_subscriptions
        WHERE owner_user_id = $1 AND enabled AND 'assistant.action' = ANY(event_types)`,
      [userId],
    )).rows as Array<{ subscription_id: string }>;
    if (!subs.length) throw new ToolRefused("no_channel", "no channel of the user runs actions now: tell them the setting cannot be changed from here");
    await enqueue(eventId, subs, payload, q);
    return { eventId };
  });
  void reviewToolPorts.kick().catch((err) => logger.error({ err }, "assistant.action_kick_failed"));
  return { ok: true, event_id: sent.eventId, action: name, args: actionArgs, note: "the channel runs it as if the user typed it; it reports the result itself" };
}

/** What the router is shown about reviews beside the item list, for one turn. Nothing when the turn answers no message. */
export async function reviewContextFor(userId: string, sessionId: string, messageId: string): Promise<{
  confirmations: PendingConfirmation[]; reviewMode: string; message: TurnMessage | null;
}> {
  const q: Querier = (text, params) => db.query(text, params);
  const [confirmations, mode, message] = await Promise.all([
    pendingConfirmationsFor(q, userId),
    getReviewMode(db, userId),
    turnMessage(q, sessionId, messageId),
  ]);
  return { confirmations, reviewMode: mode.mode, message };
}
