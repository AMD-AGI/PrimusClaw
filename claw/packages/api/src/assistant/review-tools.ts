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
 * a review item is `review-items.ts`; answering a held write is the decision route's own `decideConfirmation`
 * (`github-review/mcp.ts`), whose `decide` checks the head commit and every gate again.
 */
import pino from "pino";
import { IDENTITY_TOKEN_METHOD } from "../auth/identity-token.js";
import type { UserInfo } from "../auth/models.js";
import { readTrustedSessionCredentials } from "../auth/session-credentials.js";
import { CLAW_GITHUB_REVIEW_ENABLED } from "../config.js";
import { parsePrRef, type PrRef } from "../github-review/github.js";
import { decideConfirmation, githubReviewService } from "../github-review/mcp.js";
import { DEFAULT_REVIEW_MODE, getReviewMode, setReviewMode, type DecidedVia } from "../github-review/store.js";
import { db, inTransaction, type Querier } from "../infra/db.js";
import { deterministicEventId, enqueue, kickDelivery } from "../notifications/outbox.js";
import type { AssistantActionPayload } from "../notifications/assistant-events.js";
import { decidedViaOf, turnMessage, type AttendedVia, type TurnMessage } from "./inbound.js";
import {
  parseRestartRequest, parseReviewRequest, restartReview, ReviewItemRefused, reviewItemsEnabled, startReviews,
} from "./review-items.js";
import type { AssistantTokenClaims } from "./token.js";
import { attendedTurn, ToolRefused } from "./tools.js";
import { resolveWorkItemNow } from "./work-items.js";

const logger = pino({ name: "assistant-review-tools" });

/** The ways out of this module, so a test can stand in for what lies beyond the HTTP boundary of each. */
export const reviewToolPorts = {
  startReviews,
  restartReview,
  /** The decision route's own function (`decideConfirmation`), with the process's review service, not a copy of it. */
  decide: (userId: string, id: string, decision: "allow" | "deny", via: DecidedVia | null, guard?: (q: Querier) => Promise<void>) =>
    decideConfirmation(githubReviewService(), db, userId, id, decision, via, guard),
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

/** The review tools need the reviews: a deployment without them has no confirmations, modes or review items to act on. */
function requireReviews(items = false): void {
  if (!CLAW_GITHUB_REVIEW_ENABLED || (items && !reviewItemsEnabled())) {
    throw new ToolRefused("reviews_off", "reviews cannot be started from the assistant on this deployment: tell the user");
  }
}

/**
 * The requester as the review service asks of a signed-in caller (`startReviews`): the person's message stands for the sign-in,
 * so the service classifies it exactly as it would the request (an identity-provider token; a service's only if it is still
 * an allowed one), and the review session gets the credentials the requester's own messages gave their assistant.
 */
async function requesterSignedIn(q: Querier, routerSid: string, userId: string, message: TurnMessage, via: AttendedVia): Promise<{
  user: UserInfo; method: string;
}> {
  const router = (await q("SELECT config FROM claw_sessions WHERE session_id = $1", [routerSid])).rows[0] as { config: unknown } | undefined;
  const creds = readTrustedSessionCredentials(router?.config);
  return {
    user: {
      userId, userName: message.userName ?? userId, roles: [], platformKey: creds.platformKey, virtualKey: creds.llmApiKey,
      ...(via.kind === "service" ? { delegation: { clientId: via.client_id, actorSub: via.act_sub } } : {}),
    },
    method: IDENTITY_TOKEN_METHOD,
  };
}

/**
 * What the review service asks again in the transaction that writes: the turn is still live and still answers the person's
 * fresh, signed-in message (`attendedTurn`). A turn the person interrupted while the service checked GitHub writes nothing.
 */
function stillActing(claims: AssistantTokenClaims, userId: string): (q: Querier) => Promise<void> {
  return async (q) => {
    if ((await attendedTurn(q, claims)).userId !== userId) throw new ToolRefused("turn_not_live", "the session changed hands");
  };
}

/** The review service's answer, as the tool's: its code, words and data, so the router reads what the interface said. */
async function asTool<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ReviewItemRefused) throw new ToolRefused(err.code, err.message, err.data);
    throw err;
  }
}


// --- Grounding: pure, so the evaluation and the tests ask the same question the tools do ------------------------

const lower = (s: string): string => s.toLowerCase();

/** Whether the number stands on its own in the text: `224`, `#224`, `224可以合入`, a pull request URL; not `1224` or `2240`. */
export function mentionsNumber(text: string, n: number): boolean {
  return new RegExp(`(?<![0-9])${n}(?![0-9])`).test(text);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether the repository is one the person meant: named in the message, or, when the message names none, the one repository
 * it can only be: the channel's own, or else the one they reviewed in lately. Two candidates and a bare number name neither.
 */
export function repoGrounded(text: string, pr: Pick<PrRef, "owner" | "repo">, channelRepos: readonly string[], recentRepos: readonly string[]): boolean {
  const full = lower(`${pr.owner}/${pr.repo}`);
  const t = lower(text);
  // The whole name, not the start of a longer one: `PrimusClaw` is not named by `PrimusClaw-fork`, `PrimusClaw.old` or `PrimusClaw..old`.
  // A bare name counts unless it is written under an owner (`other/PrimusClaw` names another owner's repository).
  const whole = (name: string, before: string) =>
    new RegExp(`(?<![${before}])${escapeRe(name)}(?![a-z0-9_-]|\\.+[a-z0-9_-])`).test(t);
  if (whole(full, "a-z0-9_.-") || whole(lower(pr.repo), "a-z0-9_./-")) return true;
  const candidates = new Set((channelRepos.length ? channelRepos : recentRepos).map(lower));
  return candidates.size === 1 && candidates.has(full);
}

/**
 * Whether the text points at a work item by its number: `#12`, not `#123`, not `repo#12`, and not `PR #12` or
 * `pull request #12` (a pull request, whatever item has that number).
 */
export function mentionsItem(text: string, seq: number): boolean {
  for (const m of text.matchAll(new RegExp(`(?<![A-Za-z0-9_.-])#${seq}(?![0-9])`, "g"))) {
    if (!/(?:\bprs?|\bpull(?:\s+request)?|拉取请求|合并请求)[\s:：]*$/i.test(text.slice(0, m.index))) return true;
  }
  return false;
}

/**
 * Whether a model was asked for by name: one of the words that make its id (`opus` of `claude-opus-4-8`, `sonnet`, `gpt`)
 * is in the message. Version digits and one-letter parts say nothing on their own.
 */
export function modelGrounded(text: string, model: string): boolean {
  const t = lower(text);
  return lower(model).split(/[^a-z0-9]+/).some((part) => /^[a-z][a-z0-9]{2,}$/.test(part) && t.includes(part));
}

/** The pull requests the text names in full (`owner/repo#N`, or a pull request URL), lower-cased. */
export function fullRefsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)(?:#|\/pull\/)(\d{1,9})(?![0-9])/g)) {
    out.push(`${m[1]}/${m[2]}#${m[3]}`.toLowerCase());
  }
  return out;
}

/**
 * Whether the message names this pull request: its number stands on its own there, and when the message writes that number
 * in full with a repository (`a/b#224`, a URL), it is this repository's. Two repositories and two numbers cannot be paired
 * the other way round.
 */
export function prGrounded(text: string, pr: PrRef): boolean {
  if (!mentionsNumber(text, pr.number)) return false;
  const full = fullRefsIn(text).filter((r) => r.endsWith(`#${pr.number}`));
  return full.length === 0 || full.includes(`${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase());
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

// --- Tools ------------------------------------------------------------------------------------------------------

export async function reviewStart(
  claims: AssistantTokenClaims,
  args: { prs: unknown; reviewer?: string; merge: boolean; model?: string; effort?: string },
): Promise<Record<string, unknown>> {
  requireRouter(claims);
  requireReviews(true);
  const prs = parsePrs(args.prs);
  if (typeof args.merge !== "boolean") throw new ToolRefused("invalid_arguments", "merge must be true or false: true only when the user clearly asked to merge");
  // Asked here, so a refusal costs the review service nothing.
  const ready = await inTransaction(async (q) => {
    const { userId, message, via } = await attendedTurn(q, claims);
    const recent = await recentReviewRepos(q, userId);
    for (const pr of prs) {
      if (!prGrounded(message.content, pr)) {
        refuseUngrounded("pr_not_in_message", `${pr.owner}/${pr.repo}#${pr.number} is not what the user's message names: start only the pull requests they named`);
      }
      if (!repoGrounded(message.content, pr, message.context.repos, recent)) {
        refuseUngrounded("repo_not_grounded", `the user did not name ${pr.owner}/${pr.repo}: ask them which repository`);
      }
    }
    if (args.model && !modelGrounded(message.content, args.model)) {
      refuseUngrounded("model_not_in_message", "the user did not ask for that model: leave model out unless they named one");
    }
    const signedIn = await requesterSignedIn(q, claims.sid, userId, message, via);
    if (!args.reviewer || args.reviewer === userId) return { userId, signedIn, actingAs: userId, actingAsName: undefined };
    const reviewer = lower(args.reviewer);
    const person = message.context.people.find((p) => p.user_id === args.reviewer);
    if (person) return { userId, signedIn, actingAs: args.reviewer, actingAsName: person.name };
    const named = message.context.people.some((p) => lower(p.name) === reviewer || (p.email !== undefined && lower(p.email) === reviewer));
    return refuseUngrounded(
      named ? "reviewer_not_linked" : "reviewer_not_in_message",
      named
        ? "that person has not linked their account, so nobody can review as them: tell the user"
        : "reviewer must be left out (the user), or be the user_id of someone in this message's people list",
    );
  });
  // The body `POST /v1/assistant/reviews` would have been sent, read by the same parser: the same checks either way.
  const items = await asTool(async () => reviewToolPorts.startReviews(ready.signedIn.user, ready.signedIn.method, parseReviewRequest({
    prs: prs.map((p) => ({ owner: p.owner, repo: p.repo, number: p.number })),
    ...(ready.actingAs !== ready.userId ? { acting_as: ready.actingAs } : {}),
    ...(ready.actingAsName ? { acting_as_name: ready.actingAsName } : {}),
    ...(args.model ? { model: args.model } : {}), ...(args.effort ? { effort: args.effort } : {}),
    review_only: !args.merge,
  }), stillActing(claims, ready.userId)));
  return { ok: true, items };
}

/** The user's review items the router could mean, newest first: the open ones and those closed in the last day. */
type ReviewRow = { item_id: string; seq: number; params: Record<string, any> };

async function reviewItemsOf(q: Querier, userId: string): Promise<ReviewRow[]> {
  return (await q(
    `SELECT item_id, seq, params FROM claw_work_items
      WHERE user_id = $1 AND kind = 'review' AND (board_state <> 'done' OR closed_at > NOW() - INTERVAL '1 day')
      ORDER BY seq DESC`,
    [userId],
  )).rows as ReviewRow[];
}

/**
 * Whether the person's message points at this review: its pull request (with the repository when another of their reviews
 * shares the number), its item number, or it is the only review they have.
 */
function pointsAtReview(message: TurnMessage, reviews: ReviewRow[], item: ReviewRow): boolean {
  const pr = item.params?.pr as PrRef | undefined;
  const number = Number(pr?.number);
  // A number shared by reviews in two repositories names neither, unless the repository is named too.
  const sharing = reviews.filter((r) => Number(r.params?.pr?.number) === number).length;
  const byNumber = !!pr && prGrounded(message.content, pr)
    && (sharing === 1 || repoGrounded(message.content, pr, message.context.repos, []));
  // `#N` where N is also the number of a pull request under review is that pull request, not item #N.
  const bySeq = mentionsItem(message.content, item.seq) && !reviews.some((r) => Number(r.params?.pr?.number) === item.seq);
  // The only review is the one meant when the message names no other: "stop it" is that review, "stop PR #12" is not
  // when it reviews #500, whatever its item number.
  return byNumber || bySeq || (reviews.length === 1 && !!pr && !namesOtherTarget(message.content, pr, item.seq));
}

/**
 * Whether the text names a pull request or an item other than this review's: a `#N`, a `PR N` / `pull request N`, or an
 * `owner/repo#N` / URL that is neither its pull request nor its item number.
 */
export function namesOtherTarget(text: string, pr: PrRef, seq: number): boolean {
  const number = Number(pr.number);
  for (const m of text.matchAll(/(?<![A-Za-z0-9_.-])#(\d{1,9})(?![0-9])/g)) {
    if (Number(m[1]) !== number && Number(m[1]) !== seq) return true;
  }
  for (const m of text.matchAll(/(?:\bprs?|\bpull(?:\s+request)?|拉取请求|合并请求)[\s:：#]*(\d{1,9})(?![0-9])/gi)) {
    if (Number(m[1]) !== number) return true;
  }
  const own = `${pr.owner}/${pr.repo}#${number}`.toLowerCase();
  return fullRefsIn(text).some((r) => r !== own);
}

/**
 * The refusal `work_stop` gives a review the person's message does not point at. Stopping a review denies what waits in it
 * for their answer, so which one is their say, as it is for a restart.
 */
export async function requireReviewNamed(q: Querier, userId: string, message: TurnMessage, itemId: string): Promise<void> {
  const reviews = await reviewItemsOf(q, userId);
  const item = reviews.find((r) => r.item_id === itemId);
  if (!item || !pointsAtReview(message, reviews, item)) {
    refuseUngrounded("item_not_in_message", "the user did not say which review to stop: ask them (the pull request number is enough)");
  }
}

export async function reviewRestart(
  claims: AssistantTokenClaims, args: { item_id: string; model?: string; merge?: boolean; effort?: string },
): Promise<Record<string, unknown>> {
  requireRouter(claims);
  requireReviews(true);
  const chosen = await inTransaction(async (q) => {
    const { userId, message, via } = await attendedTurn(q, claims);
    const named = await resolveWorkItemNow(userId, args.item_id);
    if (!named.ok) throw new ToolRefused(named.error, named.message);
    const reviews = await reviewItemsOf(q, userId);
    const item = reviews.find((r) => r.item_id === named.item.item_id);
    if (!item) throw new ToolRefused("not_a_review_item", "that item is not a review: only a review can be restarted");
    if (!pointsAtReview(message, reviews, item)) refuseUngrounded("item_not_in_message", "the user did not say which review: ask them (the pull request number is enough)");
    if (args.model && !modelGrounded(message.content, args.model)) {
      refuseUngrounded("model_not_in_message", "the user did not ask for that model: leave model out to keep the one it had");
    }
    return { userId, itemId: item.item_id, signedIn: await requesterSignedIn(q, claims.sid, userId, message, via) };
  });
  const restarted = await asTool(async () => reviewToolPorts.restartReview(chosen.signedIn.user, chosen.signedIn.method, chosen.itemId, parseRestartRequest({
    ...(args.model ? { model: args.model } : {}), ...(args.effort ? { effort: args.effort } : {}),
    ...(typeof args.merge === "boolean" ? { review_only: !args.merge } : {}),
  }), stillActing(claims, chosen.userId)));
  return { ok: true, ...restarted };
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

/** The confirmations that waited for this user's answer at the moment their message arrived, whatever became of them since. */
async function waitingWhenWritten(q: Querier, userId: string, at: Date): Promise<string[]> {
  return ((await q(
    `SELECT confirmation_id AS id FROM claw_github_confirmations
      WHERE actor_user_id = $1 AND created_at <= $2 AND expires_at > $2 AND (decided_at IS NULL OR decided_at > $2)`,
    [userId, at],
  )).rows as Array<{ id: string }>).map((r) => String(r.id));
}

export async function confirmationAnswer(
  claims: AssistantTokenClaims, args: { decision: "allow" | "deny"; confirmation_id?: string; pr?: string },
): Promise<Record<string, unknown>> {
  requireRouter(claims);
  requireReviews();
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
      const waiting = await waitingWhenWritten(q, userId, message.receivedAt);
      // A write held after they wrote is one they have not seen (a new head, a new hold): their yes was not about it.
      if (!waiting.includes(pick.id)) {
        refuseUngrounded("confirmation_after_message", `the write waiting on ${pick.repo}#${pick.pr} was held after the user's message: tell them, and let them answer it`);
      }
      const only = waiting.length === 1 && waiting[0] === pick.id;
      const [owner = "", repo = ""] = pick.repo.split("/");
      const ref = { owner, repo, number: pick.pr };
      // The number of another waiting write in another repository is not this one's name.
      const sharing = pending.filter((c) => c.pr === pick.pr).length;
      const named = prGrounded(message.content, ref) && (sharing === 1 || repoGrounded(message.content, ref, [], []));
      if (!named && !only) {
        refuseUngrounded("pr_not_in_message", `the user's message does not name ${pick.repo}#${pick.pr}: ask them to say which pull request to let through`);
      }
    }
    return { userId, via, id: pick.id, repo: pick.repo, pr: pick.pr };
  });
  const answer = await reviewToolPorts.decide(chosen.userId, chosen.id, args.decision, decidedViaOf(chosen.via), stillActing(claims, chosen.userId));
  if (answer.http >= 400) {
    const body = answer.body as { error?: string };
    throw new ToolRefused(String(body.error ?? "decision_refused"), "the decision was not taken");
  }
  return { ok: true, confirmation_id: chosen.id, pr: `${chosen.repo}#${chosen.pr}`, ...answer.body };
}

export async function reviewModeSet(claims: AssistantTokenClaims, args: { mode: string }): Promise<Record<string, unknown>> {
  requireRouter(claims);
  requireReviews();
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
  const message = await turnMessage(q, sessionId, messageId);
  if (!CLAW_GITHUB_REVIEW_ENABLED) return { confirmations: [], reviewMode: DEFAULT_REVIEW_MODE, message };
  const [confirmations, mode] = await Promise.all([pendingConfirmationsFor(q, userId), getReviewMode(db, userId)]);
  return { confirmations, reviewMode: mode.mode, message };
}
