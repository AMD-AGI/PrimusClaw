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
 * Two acts are never read from a sentence at all, since a misreading there merges a pull request or changes a setting: letting a
 * held write through needs the person's message to be the exact command `批准 #<ref>` / `approve #<ref>` naming it (or the card's
 * button), and a channel action runs at once only when the message is its command typed whole; otherwise it is put to the person
 * as that command with a button, and runs only when they press it. So `merge=true` on a review this router starts or restarts never
 * merges by itself: the review's session holds its merge for the person's confirmation (`config.merge_needs_confirmation`), which only
 * that command or the card's button gives.
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
import { readGithubReviewSettings } from "../github-review/settings.js";
import { decideConfirmation, githubReviewService } from "../github-review/mcp.js";
import { DEFAULT_REVIEW_MODE, getReviewMode, setReviewMode, type DecidedVia } from "../github-review/store.js";
import { db, inTransaction, type Querier } from "../infra/db.js";
import { deterministicEventId, enqueue, kickDelivery } from "../notifications/outbox.js";
import { recordActionConfirm } from "./outbound.js";
import { confirmationRef } from "./prompts.js";
import { REVIEW_HANDOFF_ACTION, type AssistantActionPayload, type AssistantReviewHandoff } from "../notifications/assistant-events.js";
import { decidedViaOf, turnMessage, type AttendedVia, type ChannelPerson, type TurnMessage } from "./inbound.js";
import {
  parseRestartRequest, parseReviewRequest, recordReviewHandoff, REQUESTER_NOTE_MAX_CHARS, restartReview, ReviewItemRefused, reviewItemsEnabled,
  startReviews,
} from "./review-items.js";
import type { AssistantTokenClaims } from "./token.js";
import { attendedTurn, ToolRefused } from "./tools.js";
import { resolveWorkItemNow } from "./work-items.js";
import { modelChoiceOn } from "./model-choice.js";

export { confirmationRef };

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

const HAN = /\p{Script=Han}/u;

/**
 * Whether the person's own message names this person by something that is theirs alone among the people the channel listed: their name,
 * a part of it, their email, the part of it before the `@`, or their user id, each only when no one else listed has the same (so two
 * people called Alex Chen, or `alex@a` and `alex@b`, are told apart only by what differs), and only where it is not part of another listed
 * person's longer word (`王一涵` in `王一涵娜`). Case aside; a Latin word only whole (`Lei` is not named by `Leila`), a Chinese name anywhere
 * in the text. Being listed beside the message is the channel's say that the person is there; this is the person's say that it is them.
 */
export function reviewerNamed(text: string, person: ChannelPerson & { user_id: string }, people: readonly ChannelPerson[]): boolean {
  const t = lower(text);
  // Where the word stands in the text, as [start, end) spans.
  const spans = (s: string): Array<[number, number]> => {
    const re = HAN.test(s) ? new RegExp(escapeRe(s), "gu") : new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(s)}(?![\\p{L}\\p{N}_])`, "gu");
    return [...t.matchAll(re)].map((m) => [m.index, m.index + m[0].length] as [number, number]);
  };
  const words = (p: ChannelPerson): string[] => {
    const local = p.email?.split("@")[0] ?? "";
    return [p.name, ...p.name.split(/[\s,，、.·]+/), p.user_id ?? "", p.email ?? "", local.length >= 3 ? local : ""]
      .map((w) => lower(w.trim())).filter((w) => w.length >= 2);
  };
  const theirs = [...new Set(people.filter((p) => p !== person && p.user_id !== person.user_id).flatMap(words))];
  const taken = new Set(theirs);
  // A word of this person's counts where it stands on its own, not where it is part of another listed person's longer word: "王一涵"
  // inside "王一涵娜", or "Alex Chen" inside "Alex Chen Wu", names that other person.
  const inLonger = (w: string, [a, b]: [number, number]): boolean =>
    theirs.some((o) => o.length > w.length && o.includes(w) && spans(o).some(([c, d]) => c <= a && b <= d));
  return words(person).some((w) => !taken.has(w) && spans(w).some((span) => !inLonger(w, span)));
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
    // With model choice on, the model is checked against the allow-list and the payer's key instead (`model-choice.ts`): "use the fast
    // one" names a model without its name, and the quota spent is the user's own.
    if (args.model && !modelChoiceOn() && !modelGrounded(message.content, args.model)) {
      refuseUngrounded("model_not_in_message", "the user did not ask for that model: leave model out unless they named one");
    }
    const signedIn = await requesterSignedIn(q, claims.sid, userId, message, via);
    if (!args.reviewer || args.reviewer === userId) return { userId, signedIn, actingAs: userId, actingAsName: undefined };
    const reviewer = lower(args.reviewer);
    const person = message.context.people.find((p): p is ChannelPerson & { user_id: string } => p.user_id === args.reviewer);
    if (person) {
      // A review as someone else runs on their account: the person's message must name them, not only the channel list them.
      if (!reviewerNamed(message.content, person, message.context.people)) {
        refuseUngrounded("reviewer_not_named", `the user's message does not name ${person.name || "that person"}: ask them who should review it`);
      }
      return { userId, signedIn, actingAs: args.reviewer, actingAsName: person.name };
    }
    const named = message.context.people.some((p) => lower(p.name) === reviewer || (p.email !== undefined && lower(p.email) === reviewer));
    return refuseUngrounded(
      named ? "reviewer_not_linked" : "reviewer_not_in_message",
      named
        ? "that person has not linked their account, so nobody can review as them: tell the user"
        : "reviewer must be left out (the user), or be the user_id of someone in this message's people list",
    );
  });
  // A review asked of someone else runs on their own credentials, which only the channel that carried the message can bring. When it
  // said it can be handed one, it is: the channel starts it as the reviewer and tells the person how it went. Otherwise it is refused
  // below, as before (`asRequesterOfOther`).
  if (ready.actingAs !== ready.userId) {
    const handed = await handOffReview(claims, prs, { userId: ready.actingAs, name: ready.actingAsName ?? "" }, args.merge);
    if (handed) return { ...handed, ...(args.model || args.effort ? { set_aside: [...(args.model ? ["model"] : []), ...(args.effort ? ["effort"] : [])] } : {}) };
  }
  // The body `POST /v1/assistant/reviews` would have been sent, read by the same parser: the same checks either way.
  // `merge=true` is the router's reading of a sentence, and natural language never approves a merge: the review's session merges only once
  // the acting user confirms that very merge (`mergeNeedsConfirmation`, held by the review tools; the card's button or `批准 #<ref>`).
  const items = await asTool(async () => asRequesterOfOther(ready.actingAs !== ready.userId, () => reviewToolPorts.startReviews(ready.signedIn.user, ready.signedIn.method, {
    ...parseReviewRequest({
      prs: prs.map((p) => ({ owner: p.owner, repo: p.repo, number: p.number })),
      ...(ready.actingAs !== ready.userId ? { acting_as: ready.actingAs } : {}),
      ...(ready.actingAsName ? { acting_as_name: ready.actingAsName } : {}),
      ...(args.model ? { model: args.model } : {}), ...(args.effort ? { effort: args.effort } : {}),
      review_only: !args.merge,
    }),
    mergeNeedsConfirmation: true,
  }, stillActing(claims, ready.userId))));
  return { ok: true, items };
}

/**
 * Hand a review asked of someone else to the channel that carried the person's message (`assistant.action` with `review`), when that
 * message declared it can be handed one (`channel_context.handoffs`) and one of the person's channels takes actions. The grounding is
 * done by the caller, against the recorded message (the reviewer is someone the channel listed and the message names, each pull request
 * one the message names), and a recorded message does not change; what can change, that the turn is still live and answers the person's
 * fresh, signed-in message (`attendedTurn`), is asked again here, in the transaction that queues the event. Null when it cannot be
 * handed over: the caller refuses it as it always did.
 *
 * The handoff is written down (`recordReviewHandoff`) with the event, and its id travels in the payload (`review.handoff_id`) for the
 * channel to echo. The router's `merge` is its reading of a sentence, so `POST /v1/assistant/reviews` reads that record, not the
 * channel's body: such a review merges only once the reviewer confirms that very merge (`merge_needs_confirmation`), never when the
 * router did not read a merge, and is started from one handoff once. Whether the reviewer lets anyone act for them, and every other gate
 * of the review, are the review service's, when the channel asks it.
 */
async function handOffReview(
  claims: AssistantTokenClaims, prs: PrRef[], reviewer: { userId: string; name: string }, merge: boolean,
): Promise<Record<string, unknown> | null> {
  const queued = await inTransaction(async (q) => {
    const { userId, message } = await attendedTurn(q, claims);
    const channelMessageId = message.context.channel_message_id;
    if (!message.context.handoffs.includes("review_for_other") || !channelMessageId) return null;
    const subs = (await q(
      `SELECT subscription_id FROM claw_notification_subscriptions
        WHERE owner_user_id = $1 AND enabled AND 'assistant.action' = ANY(event_types)`,
      [userId],
    )).rows as Array<{ subscription_id: string }>;
    if (!subs.length) return null;
    // One handoff per message, reviewer, pull requests and merge: a replayed call queues nothing more.
    const key = [reviewer.userId, merge ? "merge" : "review", ...prs.map((p) => `${p.owner}/${p.repo}#${p.number}`.toLowerCase()).sort()].join("\u0000");
    const eventId = deterministicEventId("assistant.review_handoff", claims.mid, key);
    const review: AssistantReviewHandoff = {
      handoff_id: eventId,
      reviewer: { user_id: reviewer.userId, name: reviewer.name },
      prs: prs.map((p) => ({ owner: p.owner, repo: p.repo, number: p.number })),
      merge,
      requester_note: message.content.slice(0, REQUESTER_NOTE_MAX_CHARS),
    };
    await recordReviewHandoff(q, { handoffId: eventId, userId, reviewerUserId: reviewer.userId, prs, merge });
    const payload: AssistantActionPayload = {
      type: "assistant.action", event_id: eventId, occurred_at: new Date().toISOString(), user_id: userId,
      message_id: claims.mid, channel_message_id: channelMessageId, action: { name: REVIEW_HANDOFF_ACTION, args: "" }, review,
    };
    await enqueue(eventId, subs, payload, q);
    return { eventId };
  });
  if (!queued) return null;
  logger.info({ eventId: queued.eventId, prs: prs.length }, "assistant.review_handed_off");
  void reviewToolPorts.kick().catch((err) => logger.error({ err }, "assistant.review_handoff_kick_failed"));
  return {
    ok: true, handed_off: true, event_id: queued.eventId, reviewer: reviewer.name || reviewer.userId,
    prs: prs.map((p) => `${p.owner}/${p.repo}#${p.number}`), merge,
    note: `nothing has started yet: the user's channel starts this review as ${reviewer.name || "that person"}, on their own credentials, and tells the user itself whether it started (or why not). ${merge ? `Even then it merges nothing by itself: ${reviewer.name || "that person"} must confirm the merge. ` : ""}Say only that it was handed over; do not say it has started, will merge, or name items.`,
  };
}

/**
 * A review asked of someone else runs on that person's own credentials (their delegated token and their own key), which only the
 * asking service brings with the request (`POST /v1/assistant/reviews`, `x-acting-as-token` / `x-acting-as-api-key`). The assistant
 * holds the requester's keys, never the reviewer's, so the review service refuses such a review from here
 * (`acting_as_credentials_required`) before it looks at anything else. That is deliberate: the refusal stays, and the router is told
 * what the user can do instead, which is to ask the deployment's review agent (`CLAW_GITHUB_REVIEW_AGENT_NAME`, the name its reviews
 * are signed with), whose service brings the reviewer's credentials. The platform names no client of its own (`docs/github-review.md`).
 */
export function askTheReviewAgent(): string {
  const agent = readGithubReviewSettings().agentName;
  return `a review as someone else runs on that person's own GitHub credentials, which this assistant cannot carry: nothing was started. Tell the user to ask ${agent} for it (mention ${agent} in the pull request or the chat, naming the reviewer), or to start the review as themselves`;
}

async function asRequesterOfOther<T>(forOther: boolean, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (forOther && err instanceof ReviewItemRefused && err.code === "acting_as_credentials_required") {
      throw new ReviewItemRefused(err.status, err.code, askTheReviewAgent(), err.data);
    }
    throw err;
  }
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
    if (args.model && !modelChoiceOn() && !modelGrounded(message.content, args.model)) {
      refuseUngrounded("model_not_in_message", "the user did not ask for that model: leave model out to keep the one it had");
    }
    return { userId, itemId: item.item_id, signedIn: await requesterSignedIn(q, claims.sid, userId, message, via) };
  });
  // As at a start: whatever the router passed for merge, the restarted review merges only on the acting user's confirmation.
  const restarted = await asTool(async () => reviewToolPorts.restartReview(chosen.signedIn.user, chosen.signedIn.method, chosen.itemId, {
    ...parseRestartRequest({
      ...(args.model ? { model: args.model } : {}), ...(args.effort ? { effort: args.effort } : {}),
      ...(typeof args.merge === "boolean" ? { review_only: !args.merge } : {}),
    }),
    mergeNeedsConfirmation: true,
  }, stillActing(claims, chosen.userId)));
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

/**
 * The confirmation a message lets through, when the message is nothing but an approval command: `批准 #a3f9c2` or
 * `approve #a3f9c2` (the short id the user was shown, or the whole id), in any case, with any spacing, a full-width `＃`,
 * and at most some closing punctuation. `null` for every other message: a yes in the person's own words lets nothing
 * through (it can be misread, and the router reads what workers wrote beside it); the card's button still does.
 */
export function approvalCommand(text: string): string | null {
  const m = /^\s*(?:批准|approve)\s*[#＃]\s*([0-9a-f]{6}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*[.。!！]*\s*$/i.exec(text);
  return m ? m[1].toLowerCase() : null;
}

/** Whether `ref` (from {@link approvalCommand}) is this confirmation's short id or its whole id. */
const refersTo = (ref: string, id: string): boolean => ref === id.toLowerCase() || ref === confirmationRef(id);

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
    const replies = pending.map((c) => `批准 #${confirmationRef(c.id)} for ${c.repo}#${c.pr}`).join("; ");
    let pick: PendingConfirmation | undefined;
    if (args.decision === "allow") {
      // Saying yes is one exact command carrying the id of the write the person was shown (`approvalCommand`), or the card's
      // button (the decision route). Never how a model, or a word list, reads a sentence: the router reads what workers wrote
      // beside the message, and a misread yes merges.
      const ref = approvalCommand(message.content);
      if (!ref) {
        refuseUngrounded("not_an_approval_command", `the user's message is not an approval command, so nothing is let through: tell them to reply exactly that (${replies}) or press the button on its card`);
      }
      // What the command names is read against what waited when the user wrote: a write held since is one they have not seen
      // (a new head, a new hold), and a short ref two writes shared then named neither, whatever has become of one of them.
      const namedThen = (await waitingWhenWritten(q, userId, message.receivedAt)).filter((id) => refersTo(ref, id));
      if (namedThen.length > 1) refuseUngrounded("which_confirmation", "that short id fitted more than one waiting write: ask the user to press the button on its card");
      if (!namedThen.length) {
        if (pending.some((c) => refersTo(ref, c.id))) {
          refuseUngrounded("confirmation_after_message", `the write with the id #${ref} was held after the user's message: tell them, and let them answer it`);
        }
        refuseUngrounded("confirmation_not_found", `no write waiting for the user has the id #${ref}: what waits is ${replies}`);
      }
      pick = pending.find((c) => c.id === namedThen[0]);
      if (!pick) refuseUngrounded("confirmation_not_found", `the write with the id #${ref} no longer waits (answered or expired): what waits is ${replies}`);
      // The router's arguments may only agree with the command: they never choose another write.
      const ref2 = args.pr ? parsePrRef(args.pr) : null;
      const prNumber = ref2?.number ?? (args.pr ? Number(String(args.pr).replace(/^#/, "")) : pick.pr);
      if ((args.confirmation_id && args.confirmation_id !== pick.id) || prNumber !== pick.pr
          || (ref2 && lower(`${ref2.owner}/${ref2.repo}`) !== lower(pick.repo))) {
        refuseUngrounded("confirmation_not_in_message", `the user's command names the write on ${pick.repo}#${pick.pr}, not the one asked for`);
      }
    } else {
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

/** What the user is shown and may type to run an action: `/name args`. */
export const actionCommand = (name: string, args: string): string => `/${name}${args ? ` ${args}` : ""}`;

const squash = (s: string): string => s.replace(/\s+/g, "").toLowerCase();

/**
 * Whether the person's message is this action's command, typed whole: the message is `/name` and what follows it (`/brief off`,
 * `/brief10:0`), nothing else, and what follows is the arguments the call carries, spacing and case aside. Only then does the
 * action run at once; anything else, however plainly it seems to ask, is shown to the person as the command, to run with a press.
 */
export function typedActionCommand(text: string, name: string, args: string): boolean {
  const m = new RegExp(`^\\s*/${escapeRe(name)}(?![a-z_-])([^\\n]*)$`, "i").exec(text.trim());
  return !!m && squash(m[1]) === squash(args);
}

export async function channelAction(claims: AssistantTokenClaims, args: { name: string; args?: string }): Promise<Record<string, unknown>> {
  requireRouter(claims);
  const name = String(args.name ?? "").trim().replace(/^\/+/, "");
  const actionArgs = String(args.args ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!name) throw new ToolRefused("invalid_arguments", "name the action, as the channel listed it");
  // A handoff's name is Claw's, not a channel command: an action under that name would reach the channel without what a handoff carries.
  if (lower(name) === REVIEW_HANDOFF_ACTION) {
    throw new ToolRefused("action_reserved", `${REVIEW_HANDOFF_ACTION} is not a channel action: a review by someone else is asked with review_start`);
  }
  if (actionArgs.length > ACTION_ARGS_MAX) throw new ToolRefused("invalid_arguments", `args is at most ${ACTION_ARGS_MAX} characters`);
  const command = actionCommand(name, actionArgs);
  const sent = await inTransaction(async (q) => {
    const { userId, message } = await attendedTurn(q, claims);
    // Only what the channel that carried this message said it can do: Claw knows no channel's commands.
    const offered = message.context.actions.find((a) => a.name.replace(/^\/+/, "") === name);
    if (!offered) {
      throw new ToolRefused("action_not_offered", "the channel did not list that action with this message: tell the user what to type instead");
    }
    if (!message.context.channel_message_id) {
      throw new ToolRefused("no_channel", "this message did not come through a channel that runs actions");
    }
    // Listed is what the channel can do; asked is what the person wants. Only the command typed whole runs at once: the router
    // reads what workers wrote beside the message, so how it read a sentence never changes a setting. Anything else is put to
    // the person as the exact command, with a button, and runs only when they press it (or type it).
    if (!typedActionCommand(message.content, name, actionArgs)) {
      const zh = /\p{Script=Han}/u.test(message.content);
      const confirm = await recordActionConfirm(q, {
        userId, sessionId: claims.sid, key: `${claims.mid}\u0000${name}\u0000${actionArgs}`,
        text: zh ? `要执行 ${command} 吗？点下面的按钮执行，或直接回复 ${command}。` : `Run ${command}? Press the button below to run it, or reply ${command}.`,
        action: { name, args: actionArgs, message_id: claims.mid, channel_message_id: message.context.channel_message_id },
      });
      if (confirm && confirm.subscribers === 0) {
        throw new ToolRefused("no_channel", `no channel of the user can show a button now: tell them to type ${command} themselves`);
      }
      return { confirm };
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
  if ("confirm" in sent) {
    // `null`: the same call was made before in this turn, and its button is already in front of the user.
    if (sent.confirm) await sent.confirm.announce();
    return {
      ok: true, ran: false, command, ...(sent.confirm ? { say_id: sent.confirm.sayId } : {}),
      note: `nothing has run: the user was shown ${command} with a button, and it runs only when they press it (or type it). Do not say it is done.`,
    };
  }
  void reviewToolPorts.kick().catch((err) => logger.error({ err }, "assistant.action_kick_failed"));
  return { ok: true, ran: true, event_id: sent.eventId, action: name, args: actionArgs, note: "the channel runs it as if the user typed it; it reports the result itself" };
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
