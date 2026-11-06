// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The router's own scheduled tasks: it lists the user's triggers, and puts creating or cancelling one to the user as a card they
 * confirm with one press.
 *
 * A worker reaches the same triggers through the trigger MCP service (`triggers/mcp.ts`), whose create and cancel wait for an approval
 * of the run. A router turn has no such approval: it is the user's conversation, and nothing it calls waits for a press. So the router
 * never creates or cancels anything itself. `trigger_create` and `trigger_cancel` check what they can (the schedule, the limit, that the
 * user has a key a later run can use, that the trigger is theirs) and store the write as a confirmation; the user is shown what would be
 * done, the whole prompt and the next run in their own timezone, with a button. Only their answer does it:
 *
 *  - the button, which their channel turns into `POST /v1/assistant/confirmations/:id/decision` made as them, signed in: the route
 *    takes it as a held merge's answer is taken (an identity-provider token, the person's own or one a named service exchanged for
 *    them), never with a key, which a model in any sandbox of theirs holds. The router cannot answer it either: its bearer reaches no
 *    route outside `/v1/internal/`;
 *  - or, as for a held merge, their whole message being the approval command with the card's ref (`批准 #a3f9c2`), or the denial
 *    command (`拒绝 #a3f9c2`), answered with `confirmation_answer` in a turn that answers that message sent signed in (`attendedTurn`).
 *
 * The write is done in the transaction that marks the confirmation answered, so one card does it once; a second press is told what
 * the first did. A confirmation not answered within `CONFIRMATION_TTL` lapses.
 */
import { createHash, randomUUID } from "node:crypto";
import pino from "pino";
import { readTrustedSessionCredentials } from "../auth/sealed-session-credentials.js";
import {
  CLAW_ASSISTANT_ENABLED, CLAW_DEPLOY_MODE, CLAW_TRIGGER_TOOLS_ENABLED, CLAW_TRIGGERS_ENABLED, TRIGGER_MAX_PER_USER,
  TRIGGER_MIN_INTERVAL_MINUTES,
} from "../config.js";
import { db, inTransaction, type Querier } from "../infra/db.js";
import { nextFireAfter } from "../triggers/schedule.js";
import {
  deleteTrigger, insertTrigger, listTriggers, parseTriggerInput, sealTriggerCredentials, triggerView, type TriggerInput,
} from "../triggers/store.js";
import { turnMessage } from "./inbound.js";
import { recordWriteConfirm, type SayDeps } from "./outbound.js";
import { confirmationRef } from "./prompts.js";
import { approvalCommand } from "./review-tools.js";
import type { AssistantTokenClaims } from "./token.js";
import { assertLiveRun, attendedTurn, ToolRefused } from "./tools.js";

const logger = pino({ name: "assistant-schedules" });

/** How long a card can still be answered. A schedule asked for in the morning may be confirmed in the afternoon. */
export const CONFIRMATION_TTL = "24 hours";
/** Cards one user may have open at once: a turn that keeps proposing is refused, not shown more cards. */
export const MAX_PENDING_CONFIRMATIONS = 10;
/**
 * The longest prompt the router may propose: the card shows all of it, since the user approves what every later run is told, and a
 * card is no place for more. A longer schedule is made where the user can read it whole (`/v1/triggers`).
 */
export const ROUTER_PROMPT_MAX = 1500;

export type ScheduleKind = "trigger_create" | "trigger_cancel";

/** The router's schedule tools: whenever a trigger may be made by a model at all. */
export function assistantSchedulesOn(): boolean {
  return CLAW_ASSISTANT_ENABLED && CLAW_TRIGGERS_ENABLED && CLAW_TRIGGER_TOOLS_ENABLED;
}

/** What leaves the module after a commit, so a test can see it: the card's announcement. */
export const schedulePorts: { sayDeps: SayDeps } = { sayDeps: {} };

function requireRouter(claims: AssistantTokenClaims): void {
  if (claims.role !== "router") throw new ToolRefused("not_allowed", `this tool is for the router, not the ${claims.role}`);
}

const hasHan = (text: string): boolean => /\p{Script=Han}/u.test(text);
const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** A time as the user reads it: their wall clock in their timezone, `2026-11-07 09:00`. */
export function localTime(at: Date | string | null, timezone: string): string {
  if (!at) return "-";
  const d = at instanceof Date ? at : new Date(at);
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(d);
    const v = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${v("year")}-${v("month")}-${v("day")} ${v("hour")}:${v("minute")}`;
  } catch {
    return d.toISOString();
  }
}

/** The input a confirmation stores for a create: what the card shows is what is created. */
interface CreateParams {
  name: string; prompt: string; schedule: string; timezone: string; until: string | null; max_runs: number | null;
  /** The next run the card showed: the first one, if the card is answered before it. */
  next_run?: string | null;
}
interface CancelParams { trigger_id: string; name: string; schedule: string; timezone: string }

const createParams = (i: TriggerInput): CreateParams => ({
  name: i.name, prompt: i.prompt, schedule: i.schedule, timezone: i.timezone, until: i.endsAt ? i.endsAt.toISOString() : null, max_runs: i.maxRuns,
});

/** What the person is shown: the whole of what would be done, in the language they wrote in. */
export function confirmText(kind: ScheduleKind, p: CreateParams | CancelParams, ref: string, zh: boolean, nextRun: Date | null): string {
  if (kind === "trigger_cancel") {
    const c = p as CancelParams;
    return zh
      ? `要取消定时任务「${c.name}」（${c.schedule}，${c.timezone}）吗？取消后它不再运行。点下面的「取消它」确认，或回复 批准 #${ref}。`
      : `Cancel the scheduled task "${c.name}" (${c.schedule}, ${c.timezone})? It will not run again. Press "Cancel it" below to confirm, or reply approve #${ref}.`;
  }
  const c = p as CreateParams;
  const bounds = [c.until ? (zh ? `到 ${localTime(c.until, c.timezone)} 为止` : `until ${localTime(c.until, c.timezone)}`) : "",
    c.max_runs ? (zh ? `最多 ${c.max_runs} 次` : `at most ${c.max_runs} runs`) : ""].filter(Boolean).join(zh ? "，" : ", ");
  return zh
    ? `要创建定时任务「${c.name}」吗？\n时间：${c.schedule}（${c.timezone}），下次 ${localTime(nextRun, c.timezone)}（之后才确认就从再下一次开始）${bounds ? `，${bounds}` : ""}\n每次运行以你的身份执行：${c.prompt}\n点下面的「创建」确认，或回复 批准 #${ref}。`
    : `Create the scheduled task "${c.name}"?\nWhen: ${c.schedule} (${c.timezone}), next run ${localTime(nextRun, c.timezone)} (confirmed after that, it starts from the run after)${bounds ? `, ${bounds}` : ""}\nEach run acts as you: ${c.prompt}\nPress "Create" below to confirm, or reply approve #${ref}.`;
}

const allowLabel = (kind: ScheduleKind, zh: boolean): string =>
  kind === "trigger_create" ? (zh ? "创建" : "Create") : (zh ? "取消它" : "Cancel it");

/** The router's turn, live, answering a message the user wrote (not a report), before which it has read nothing untrusted. */
async function proposingTurn(q: Querier, claims: AssistantTokenClaims): Promise<{ userId: string; zh: boolean }> {
  const { userId } = await assertLiveRun(q, claims);
  const message = await turnMessage(q, claims.sid, claims.mid);
  if (!message) {
    throw new ToolRefused("not_from_user", "only a message from the user can ask for a scheduled task: a report cannot; tell the user what you would set up and let them ask");
  }
  if (message.readUntrusted) {
    throw new ToolRefused("read_untrusted", "this turn has read what a worker wrote, so it no longer proposes anything for the user: tell them what you would set up and let them ask again");
  }
  return { userId, zh: hasHan(message.content) };
}

/** The card an identical proposal earlier in this turn stored, with whether it has lapsed: it may have been answered since. */
const SAME_CARD_SQL = "SELECT *, expires_at <= NOW() AS lapsed FROM claw_assistant_confirmations WHERE dedupe_key = $1";

/**
 * Store the confirmation and its card; the same proposal twice in one turn is the first one, as it stands now (`proposed` tells the
 * model when that card is no longer open).
 */
async function propose(
  q: Querier, claims: AssistantTokenClaims, userId: string, zh: boolean, kind: ScheduleKind, params: CreateParams | CancelParams, nextRun: Date | null,
): Promise<{ row: Record<string, any>; announce: (() => Promise<void>) | null; subscribers: number }> {
  const pending = Number((await q(
    "SELECT COUNT(*)::int AS n FROM claw_assistant_confirmations WHERE user_id = $1 AND status = 'pending' AND expires_at > NOW()", [userId],
  )).rows[0].n);
  // What the user asked for, not the next run worked out from the clock at each call: the same arguments a moment later, after a
  // run time has passed, are the same proposal and so the same card.
  const asked: Record<string, unknown> = { ...params };
  delete asked.next_run;
  const dedupeKey = createHash("sha256").update(`${claims.sid}\u0000${claims.mid}\u0000${kind}\u0000${JSON.stringify(asked)}`).digest("hex");
  const same = (await q(SAME_CARD_SQL, [dedupeKey])).rows[0] as Record<string, any> | undefined;
  if (same) return { row: same, announce: null, subscribers: 0 };
  if (pending >= MAX_PENDING_CONFIRMATIONS) {
    throw new ToolRefused("too_many_pending", `the user already has ${MAX_PENDING_CONFIRMATIONS} cards waiting for an answer: ask them to answer those first`);
  }
  const id = randomUUID();
  const row = (await q(
    `INSERT INTO claw_assistant_confirmations (confirmation_id, user_id, session_id, message_id, kind, params, dedupe_key, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NOW() + $8::interval)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING *`,
    [id, userId, claims.sid, claims.mid, kind, JSON.stringify(params), dedupeKey, CONFIRMATION_TTL],
  )).rows[0] as Record<string, any> | undefined;
  // The same call made twice at once: the other one stored it and shows its card.
  if (!row) return { row: (await q(SAME_CARD_SQL, [dedupeKey])).rows[0] as Record<string, any>, announce: null, subscribers: 0 };
  const ref = confirmationRef(id);
  const card = await recordWriteConfirm(q, {
    userId, sessionId: claims.sid, text: confirmText(kind, params, ref, zh, nextRun),
    confirm: {
      confirmation_id: id, ref, kind, allow_label: allowLabel(kind, zh), expires_at: new Date(row.expires_at).toISOString(),
    },
  }, schedulePorts.sayDeps);
  return { row, announce: card?.announce ?? null, subscribers: card?.subscribers ?? 0 };
}

function proposed(row: Record<string, any>, subscribers: number, what: string): Record<string, unknown> {
  const ref = confirmationRef(String(row.confirmation_id));
  if (row.status !== "pending" || row.lapsed === true) return answeredBefore(row, ref, what);
  return {
    ok: true, done: false, confirmation_id: row.confirmation_id, ref, status: row.status,
    note: `nothing has been ${what} yet: the user was shown a card with what would be done and a button; it is done only when they press it, or reply exactly 批准 #${ref}. Tell them to check the card and press it; never say it is done.`
      + (subscribers === 0 ? ` No chat of the user can draw the button right now, so tell them to reply 批准 #${ref}.` : ""),
  };
}

/**
 * The same proposal again in a turn whose card is no longer open: the user already answered it (or it lapsed). Said as it is, so the
 * model neither tells the user to press a card that is gone nor says a denied one is waiting.
 */
function answeredBefore(row: Record<string, any>, ref: string, what: string): Record<string, unknown> {
  const status = row.status === "pending" ? "expired" : String(row.status);
  const note = status === "done"
    ? `done already: the user confirmed this same card (#${ref}) earlier, so it has been ${what}. Tell them in one line; do not propose it again.`
    : status === "denied"
      ? `not done: the user said no to this same card (#${ref}). Do not propose it again in this turn; if they still want it they will ask.`
      : status === "expired"
        ? `not done: this same card (#${ref}) lapsed unanswered. Nothing has been ${what}; if the user still wants it, they ask again in a new message.`
        : `not done: the user confirmed this same card (#${ref}) but it failed (${String(row.result?.error ?? "error")}). Tell them.`;
  return {
    ok: true, done: status === "done", confirmation_id: row.confirmation_id, ref, status, ...(row.result ? { result: row.result } : {}), note,
  };
}

export async function triggerListTool(claims: AssistantTokenClaims): Promise<Record<string, unknown>> {
  requireRouter(claims);
  const { userId } = await assertLiveRun((text, params) => db.query(text, params), claims);
  const waiting = (await db.query(
    `SELECT confirmation_id, kind, params, expires_at FROM claw_assistant_confirmations
      WHERE user_id = $1 AND status = 'pending' AND expires_at > NOW() ORDER BY created_at`,
    [userId],
  )).rows as Array<Record<string, any>>;
  return {
    ok: true, min_interval_minutes: TRIGGER_MIN_INTERVAL_MINUTES, max_triggers: TRIGGER_MAX_PER_USER,
    triggers: (await listTriggers(userId)).map(triggerView),
    waiting_for_confirmation: waiting.map((w) => ({
      ref: confirmationRef(String(w.confirmation_id)), confirmation_id: w.confirmation_id, kind: w.kind,
      name: w.params?.name ?? null, schedule: w.params?.schedule ?? null, expires_at: w.expires_at,
    })),
  };
}

export async function triggerCreateTool(claims: AssistantTokenClaims, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  requireRouter(claims);
  // A brief is a channel's own command; what the router schedules is a run of the prompt.
  const parsed = parseTriggerInput({ ...args, action: undefined });
  if (!parsed.ok) throw new ToolRefused("invalid_arguments", parsed.error);
  if (parsed.input.prompt.length > ROUTER_PROMPT_MAX) {
    throw new ToolRefused("prompt_too_long", `the prompt is at most ${ROUTER_PROMPT_MAX} characters, so the user can read all of it on the card: write it shorter`);
  }
  const params = createParams(parsed.input);
  const out = await inTransaction(async (q) => {
    const { userId, zh } = await proposingTurn(q, claims);
    // The lock the user's other assistant writes take: two proposals meet the limits one after the other.
    await q("SELECT 1 FROM claw_assistants WHERE user_id = $1 FOR UPDATE", [userId]);
    const router = (await q("SELECT config FROM claw_sessions WHERE session_id = $1", [claims.sid])).rows[0] as { config: unknown } | undefined;
    if (CLAW_DEPLOY_MODE !== "kubernetes" && !readTrustedSessionCredentials(router?.config).platformKey) {
      throw new ToolRefused("no_credentials", "the user's key has not reached the assistant yet, so nothing could run on their behalf later: ask them to send a message first");
    }
    const count = Number((await q("SELECT COUNT(*)::int AS n FROM claw_triggers WHERE owner_user_id = $1", [userId])).rows[0].n);
    if (count >= TRIGGER_MAX_PER_USER) {
      throw new ToolRefused("trigger_limit_reached", `the user has ${count} scheduled tasks, as many as allowed: they cancel one first (trigger_list shows them)`);
    }
    const nextRun = nextFireAfter(params.schedule, params.timezone, new Date());
    return propose(q, claims, userId, zh, "trigger_create", { ...params, next_run: nextRun ? nextRun.toISOString() : null }, nextRun);
  });
  if (out.announce) await out.announce();
  return { ...proposed(out.row, out.subscribers, "scheduled"), next_run: localTime(nextFireAfter(params.schedule, params.timezone, new Date()), params.timezone), timezone: params.timezone };
}

export async function triggerCancelTool(claims: AssistantTokenClaims, args: { trigger_id?: unknown }): Promise<Record<string, unknown>> {
  requireRouter(claims);
  const triggerId = typeof args.trigger_id === "string" ? args.trigger_id.trim() : "";
  if (!triggerId) throw new ToolRefused("invalid_arguments", "name the trigger by its trigger_id from trigger_list");
  const out = await inTransaction(async (q) => {
    const { userId, zh } = await proposingTurn(q, claims);
    const t = (await q(
      "SELECT trigger_id, name, schedule, timezone FROM claw_triggers WHERE trigger_id = $1 AND owner_user_id = $2", [triggerId, userId],
    )).rows[0] as CancelParams | undefined;
    if (!t) throw new ToolRefused("not_found", "the user has no scheduled task with that id: trigger_list shows theirs");
    return propose(q, claims, userId, zh, "trigger_cancel", { trigger_id: t.trigger_id, name: t.name, schedule: t.schedule, timezone: t.timezone }, null);
  });
  if (out.announce) await out.announce();
  return proposed(out.row, out.subscribers, "cancelled");
}

// --- The answer ------------------------------------------------------------------------------------------------------

/** A refusal of the decision itself, for the route to answer with its status. */
export class DecisionRefused extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "DecisionRefused";
  }
}

export interface DecisionOutcome {
  confirmation_id: string;
  kind: ScheduleKind;
  /** done | denied | expired | failed: what this answer, or the one before it, came to. */
  status: string;
  /** False when the confirmation had been answered (or had lapsed) before: nothing was done now. */
  answered_now: boolean;
  result: Record<string, unknown> | null;
}

/** The credentials a created trigger runs on later. */
export interface DeciderCredentials { platformKey: string; virtualKey: string; userName: string }

const outcome = (row: Record<string, any>, answeredNow: boolean): DecisionOutcome => ({
  confirmation_id: String(row.confirmation_id), kind: row.kind, status: String(row.status), answered_now: answeredNow, result: row.result ?? null,
});

/**
 * Answer a confirmation of this user's: `deny` closes it; `allow` does the write it holds, in the transaction that closes it. The
 * trigger runs later on `creds` when they hold a key (the answer made with the user's own credentials), else on the key the user's
 * messages last gave their assistant. Throws {@link DecisionRefused} when no confirmation of theirs has that id.
 */
export async function decideConfirmation(input: {
  /** `button`, `button:<service client>` (their chat pressed it for them) or `command` (their typed answer). */
  userId: string; confirmationId: string; decision: "allow" | "deny"; via: "button" | `button:${string}` | "command"; creds?: DeciderCredentials | null;
  guard?: (q: Querier) => Promise<void>;
}): Promise<DecisionOutcome> {
  return inTransaction(async (q) => {
    await input.guard?.(q);
    const row = (await q(
      "SELECT *, expires_at <= NOW() AS lapsed FROM claw_assistant_confirmations WHERE confirmation_id = $1 AND user_id = $2 FOR UPDATE",
      [input.confirmationId, input.userId],
    )).rows[0] as Record<string, any> | undefined;
    if (!row) throw new DecisionRefused(404, "not_found", "no confirmation of yours has that id");
    if (row.status !== "pending") return outcome(row, false);
    const close = async (status: string, result: Record<string, unknown> | null) => (await q(
      `UPDATE claw_assistant_confirmations SET status = $2, result = $3::jsonb, decided_via = $4, decided_at = NOW()
        WHERE confirmation_id = $1 RETURNING *`,
      [row.confirmation_id, status, result === null ? null : JSON.stringify(result), input.via],
    )).rows[0] as Record<string, any>;
    if (row.lapsed) return outcome(await close("expired", null), false);
    if (input.decision === "deny") return outcome(await close("denied", null), true);
    if (row.kind === "trigger_cancel") {
      const gone = await deleteTrigger(input.userId, String(row.params.trigger_id), q);
      return outcome(await close(gone ? "done" : "failed", gone ? { trigger_id: row.params.trigger_id } : { error: "not_found" }), true);
    }
    // Read again as it is now: a time `until` that has passed since the card was shown is no schedule any more.
    const parsed = parseTriggerInput({ ...row.params, action: "run" });
    if (!parsed.ok) return outcome(await close("failed", { error: "invalid_arguments", message: parsed.error }), true);
    let creds = input.creds?.platformKey ? input.creds : null;
    if (!creds) {
      const router = (await q("SELECT config FROM claw_sessions WHERE session_id = $1", [row.session_id])).rows[0] as { config: unknown } | undefined;
      const stamped = readTrustedSessionCredentials(router?.config);
      creds = { platformKey: stamped.platformKey, virtualKey: stamped.llmApiKey, userName: input.creds?.userName || input.userId };
    }
    if (CLAW_DEPLOY_MODE !== "kubernetes" && !creds.platformKey) {
      return outcome(await close("failed", { error: "no_credentials", message: "no key of yours reached Claw, so nothing could run on your behalf later" }), true);
    }
    const created = await insertTrigger(input.userId, parsed.input, sealTriggerCredentials(creds), null, q);
    if (!created) return outcome(await close("failed", { error: "trigger_limit_reached" }), true);
    logger.info({ userId: input.userId, triggerId: created.trigger_id, via: input.via }, "assistant.schedule_created");
    // When it first runs, said as it is: the card showed the next run as of when it was proposed, which may have passed since.
    const nextRun = created.next_fire_at ? new Date(created.next_fire_at as string).toISOString() : null;
    return outcome(await close("done", {
      trigger: triggerView(created), next_run: nextRun, shown_next_run: row.params.next_run ?? null,
      ...(row.params.next_run && nextRun !== row.params.next_run ? { first_run_moved: true } : {}),
    }), true);
  });
}

/** The user's confirmations still waiting for them. */
export async function pendingConfirmations(userId: string): Promise<Array<Record<string, unknown>>> {
  return ((await db.query(
    `SELECT confirmation_id, kind, params, created_at, expires_at FROM claw_assistant_confirmations
      WHERE user_id = $1 AND status = 'pending' AND expires_at > NOW() ORDER BY created_at`,
    [userId],
  )).rows as Array<Record<string, any>>).map((r) => ({ ...r, ref: confirmationRef(String(r.confirmation_id)) }));
}

/**
 * `confirmation_answer` for a scheduled task's card: `null` when what the call names is not one (it is then a held merge's, answered by
 * the review tools). allow only from the user's whole message being the approval command with the card's ref, sent signed in and
 * after the card was shown, as for a merge; deny only from their whole message being the denial command (`denialCommand`), the same way.
 */
export async function scheduleConfirmationAnswer(
  claims: AssistantTokenClaims, args: { decision: "allow" | "deny"; confirmation_id?: string },
): Promise<Record<string, unknown> | null> {
  if (claims.role !== "router" || !assistantSchedulesOn()) return null;
  const q: Querier = (text, params) => db.query(text, params);
  const { userId } = await assertLiveRun(q, claims);
  const mine = (await q(
    "SELECT confirmation_id, created_at FROM claw_assistant_confirmations WHERE user_id = $1 AND status = 'pending'", [userId],
  )).rows as Array<{ confirmation_id: string; created_at: Date }>;
  if (!mine.length) return null;
  let id: string | null = null;
  let guard: ((q: Querier) => Promise<void>) | undefined;
  if (args.decision === "allow") {
    const message = await turnMessage(q, claims.sid, claims.mid);
    const ref = message ? approvalCommand(message.content) : null;
    const named = ref ? mine.filter((c) => ref === c.confirmation_id.toLowerCase() || ref === confirmationRef(c.confirmation_id)) : [];
    if (!named.length) return null;
    // The command is the person's say: their message, sent signed in, still fresh, and the card already in front of them.
    try {
      await inTransaction((tx) => attendedTurn(tx, claims));
    } catch (err) {
      if (!(err instanceof ToolRefused)) throw err;
      throw new ToolRefused(err.code, `this message cannot let the card through (${err.message}): tell the user to press the button on the card instead`);
    }
    if (named.length > 1) throw new ToolRefused("which_confirmation", "that short id fits more than one card: ask the user to press the button on the one they mean");
    if (new Date(named[0].created_at) > message!.receivedAt) {
      throw new ToolRefused("confirmation_after_message", "that card was shown after the user's message: let them answer it");
    }
    id = named[0].confirmation_id;
    guard = async (tx) => { await attendedTurn(tx, claims); };
  } else {
    // A no is the person's too, and as exact as a yes: their whole message the denial command naming the card, sent signed in.
    const message = await turnMessage(q, claims.sid, claims.mid);
    const ref = message ? denialCommand(message.content) : null;
    const named = ref ? mine.filter((c) => ref === c.confirmation_id.toLowerCase() || ref === confirmationRef(c.confirmation_id)) : [];
    if (!named.length) {
      if (!args.confirmation_id || !mine.some((c) => c.confirmation_id === args.confirmation_id)) return null;
      throw new ToolRefused("not_a_denial_command", "only the user's own answer closes a card: tell them to press Don't on it, or reply exactly 拒绝 #<ref> (it lapses by itself in a day)");
    }
    try {
      await inTransaction((tx) => attendedTurn(tx, claims));
    } catch (err) {
      if (!(err instanceof ToolRefused)) throw err;
      throw new ToolRefused(err.code, `this message cannot answer the card (${err.message}): tell the user to press Don't on the card instead`);
    }
    if (named.length > 1) throw new ToolRefused("which_confirmation", "that short id fits more than one card: ask the user to press Don't on the one they mean");
    if ((args.confirmation_id && args.confirmation_id !== named[0].confirmation_id) || new Date(named[0].created_at) > message!.receivedAt) {
      throw new ToolRefused("confirmation_not_in_message", "the user's command names another card, or one shown after their message");
    }
    id = named[0].confirmation_id;
    guard = async (tx) => { await attendedTurn(tx, claims); };
  }
  const answer = await decideConfirmation({ userId, confirmationId: id, decision: args.decision, via: "command", guard });
  return {
    ok: answer.status === "done" || answer.status === "denied", ...answer, ref: confirmationRef(id),
    note: answer.status === "done" ? "done: tell the user in one line" : answer.status === "denied" ? "not done, as the user said" : `not done: ${answer.status}; tell the user`,
  };
}

/**
 * The card a message says no to, when the message is nothing but the denial command: `拒绝 #a3f9c2`, `不要 #a3f9c2` or `deny #a3f9c2`
 * (the card's short id or its whole id), as `approvalCommand` reads a yes. `null` for every other message: a no in the person's own
 * words closes nothing (the card simply lapses), since the router reads what workers wrote beside it; the card's button still does.
 */
export function denialCommand(text: string): string | null {
  const m = /^\s*(?:拒绝|不要|deny)\s*[#＃]\s*([0-9a-f]{6}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*[.。!！]*\s*$/i.exec(text);
  return m ? m[1].toLowerCase() : null;
}

/** What the router is shown of the cards waiting, beside the item list. Nothing when there are none. */
export async function renderScheduleState(userId: string): Promise<string> {
  const waiting = await pendingConfirmations(userId);
  if (!waiting.length) return "";
  const lines = waiting.map((w) => {
    const p = (w.params ?? {}) as Record<string, unknown>;
    const what = w.kind === "trigger_cancel" ? "cancel scheduled task" : "create scheduled task";
    return `- ref #${String(w.ref)} | confirmation_id: ${String(w.confirmation_id)} | ${what} "${clip(String(p.name ?? ""), 60).replace(/\s+/g, " ")}" (${String(p.schedule ?? "")}, ${String(p.timezone ?? "")}) | the user lets it through with its card's button or: 批准 #${String(w.ref)}`;
  });
  return `Scheduled tasks waiting for the user's confirmation (cards shown to them):\n${lines.join("\n")}`;
}
