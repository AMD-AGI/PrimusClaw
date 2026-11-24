// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Handing a task to one of the user's seats (`work_create` with `target: "seat:<seat_id>"`): the agent working in that folder on their
 * machine does it, as a remote item of its own (an errand, `remote-items.ts`), and its result comes back through the router as a
 * worker's report does.
 *
 * What may go without a card is decided here, never by the prompt. A task goes to a seat directly only when all of these hold: the
 * turn answers the user's own message, signed in, fresh, and has read nothing Claw did not write (`attendedTurn`); it names one seat
 * (several are a choice card); the user confirmed what the seat is for; a card for that seat was pressed before (`dispatch_mode`
 * `auto`, which only a press makes) and the user did not ask for a card every time (`confirm_each`); and the seat's agent asks before
 * it acts (not `unattended`). Anything else is a card the user presses (`seat_dispatch`), and a turn that answers no message of the
 * user's (a report, a wake) hands nothing to a seat at all. A seat is named only by its seat_id: an alias or a machine name is not one.
 * A press is checked again as it is made: the seat, its agent and machine, and whether it is free.
 *
 * One task at a time runs in a seat; the others wait in its queue (at most {@link SEAT_QUEUE_MAX}), in order, and go when it is free:
 * after the events that free it (`drainSeatsOf`), or the sweep. A seat whose conversation is open in a terminal someone is at (input in
 * the last ten minutes, busy, or one that can only be watched) is not typed into; one quiet for ten minutes is. A task waiting for its
 * machine fails after a day.
 */
import { randomUUID } from "node:crypto";
import pino from "pino";
import { REMOTE_AGENT_LIMITS, REMOTE_AGENT_TIMING, type AssistantConfirmOption } from "@claw/protocol";
import { readTrustedSessionCredentials, sealedCredentialFields } from "../auth/sealed-session-credentials.js";
import { CLAW_ASSISTANT_MAX_ACTIVE_ITEMS, CLAW_ASSISTANT_WORKER_MODEL } from "../config.js";
import { db, inTransaction, type Querier } from "../infra/db.js";
import { insertSessionRow } from "../routes/sessions.js";
import { executeSend, inertMd, resumableOf, type SendPlan } from "./devenv-tools.js";
import { markUntrustedRead, turnMessage } from "./inbound.js";
import { drainSessionIfIdle, queueServerMessage } from "./messages.js";
import { recordSystemNotice } from "./outbound.js";
import {
  errandNotice, errandText, errandWorkerSessionId, langOf, reportErrand, SEAT_QUEUE_REASONS, type ErrandParams, type ErrandQueue,
  type RemoteLang,
} from "./remote-items.js";
import { SEAT_QUEUE_MAX, seatDispatchOn, seatsLive, syncSeats, type SeatLive } from "./seats.js";
import type { AssistantTokenClaims } from "./token.js";
import { assertLiveRun, attendedTurn, ToolRefused } from "./tools.js";
import { typedCommand } from "./typed-commands.js";
import { clipOneLine, insertWorkItem, RUNNING, TITLE_MAX } from "./work-items.js";
import { newWorkItemId } from "../tasks/ids.js";

const logger = pino({ name: "assistant-seat-dispatch" });

type Row = Record<string, any>;

/** A target that is the sandbox (a worker of Claw's), and the prefix of one that is a seat. */
export const SANDBOX_TARGET = "sandbox";
export const SEAT_TARGET_PREFIX = "seat:";
/** A choice card offers 2 to 5 places. */
export const CHOICES_MIN = 2;
export const CHOICES_MAX = 5;
/** A task waiting for its machine fails after this long. */
export const OFFLINE_QUEUE_MS = 24 * 3600_000;
/** A task that has run this long is said in one line, and again each time as long again. */
export const PROGRESS_EVERY_MS = 3600_000;
/** A machine offline this long under a running task is said once. */
export const OFFLINE_TOLD_MS = 3600_000;
/** Two calls for one title and seat within this long are one task (a replayed call). */
const DUPLICATE_WINDOW = "10 minutes";
const LABEL_MAX = 40;
const CARD_BRIEF_MAX = 1500;

const flat = (v: unknown, max: number): string => clipOneLine(typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ") : "", max);

export type Target = { kind: "sandbox" } | { kind: "seats"; seats: string[]; sandbox: boolean };

/**
 * What `target` names: the sandbox, one seat, or the places of a choice card; null when it is not a target. A seat is named by its
 * seat_id (`seat:<seat_id>`); anything else (an alias, a machine's name) is read as a seat_id too, so it is refused as no seat of the
 * user's (`seat_not_found`), never matched to one.
 */
export function parseTarget(raw: unknown): Target | null {
  if (raw === undefined || raw === null || raw === "") return { kind: "sandbox" };
  const list = Array.isArray(raw) ? raw : [raw];
  if (!list.length || list.some((t) => typeof t !== "string")) return null;
  const seats: string[] = [];
  let sandbox = false;
  for (const t0 of list as string[]) {
    const t = t0.trim();
    if (t.toLowerCase() === SANDBOX_TARGET) { sandbox = true; continue; }
    const id = (t.toLowerCase().startsWith(SEAT_TARGET_PREFIX) ? t.slice(SEAT_TARGET_PREFIX.length) : t).trim();
    if (!id || id.length > 200) return null;
    if (!seats.includes(id)) seats.push(id);
  }
  if (!seats.length) return list.length > 1 ? null : { kind: "sandbox" };
  const places = seats.length + (sandbox ? 1 : 0);
  if (places === 1) return { kind: "seats", seats, sandbox: false };
  if (places < CHOICES_MIN || places > CHOICES_MAX) return null;
  return { kind: "seats", seats, sandbox };
}

/** How a seat is named to the user: the alias they confirmed, else `<machine>/<agent>`; one line of at most 40 code points. */
export function seatLabel(live: Pick<SeatLive, "machine" | "seat">): string {
  const alias = typeof live.seat.alias === "string" && live.seat.alias ? live.seat.alias : null;
  return flat(alias ?? `${live.machine}/${String(live.seat.agent_id)}`, LABEL_MAX);
}

/** Why a task for this seat needs a card, or null when it may go directly (see the module's comment). */
export function whyCard(live: SeatLive, attendedRefusal: string | null): string | null {
  if (attendedRefusal) return attendedRefusal;
  const s = live.seat;
  if (s.role_state !== "confirmed") return s.role_state === "suggested" ? "suggested" : "new_seat";
  if (s.confirm_each === true) return "confirm_each";
  if (s.dispatch_mode !== "auto") return "first_dispatch";
  if (live.unattended) return "unattended";
  return null;
}

/** A refusal for a seat that cannot take a task, or null. */
function seatRefusal(live: SeatLive | undefined, seatId: string): ToolRefused | null {
  if (!live) {
    return new ToolRefused("seat_not_found", "no seat of the user's has that seat_id: use the seat_id from seat_roster (an alias or a machine name is not a target)");
  }
  if (live.seat.role_state === "retired") return new ToolRefused("seat_retired", "the user said not to send work to that seat");
  if (live.unsupported) {
    return new ToolRefused("seat_unsupported", live.unsupported === "connector_outdated"
      ? "the connector on that machine is too old to take tasks: tell the user to upgrade it"
      : live.unsupported === "agent_kind" ? "tasks can only be handed to Claude Code for now; that seat's agent is another one"
        : "that seat's agent is no longer offered by its machine", live.upgrade_command ? { upgrade_command: live.upgrade_command } : undefined);
  }
  return null;
}

/** The other seats a full queue's refusal offers (online, free, not retired), as targets. */
function otherSeats(all: Map<string, SeatLive>, except: string): string[] {
  return [...all.values()].filter((l) => String(l.seat.seat_id) !== except && l.seat.role_state !== "retired" && (l.state === "idle"))
    .slice(0, 3).map((l) => `${SEAT_TARGET_PREFIX}${String(l.seat.seat_id)}`);
}

/** The card's text: the task as it would be sent, to which seat and folder, and what pressing it does. */
export function seatCardText(
  p: { label: string; cwd: string; brief: string; why: string | null; makesAuto: boolean; unattended: boolean; choice?: string[] }, ref: string, zh: boolean,
): string {
  const brief = clipOneLine(p.brief, CARD_BRIEF_MAX).length < p.brief.length ? `${Array.from(p.brief).slice(0, CARD_BRIEF_MAX).join("")}…` : p.brief;
  if (p.choice) {
    return zh
      ? `这件事交给谁？\n${brief}\n${p.choice.map((c) => `- ${inertMd(c)}`).join("\n")}\n在下面选一个，或直接告诉我交给哪个。`
      : `Who should do this?\n${brief}\n${p.choice.map((c) => `- ${inertMd(c)}`).join("\n")}\nPick one below, or just tell me which.`;
  }
  const lines = [
    zh ? `把这件事交给 ${inertMd(p.label)}（${inertMd(p.cwd)}）吗？` : `Hand this to ${inertMd(p.label)} (${inertMd(p.cwd)})?`,
    brief,
    ...(p.unattended ? [zh ? "注意：它处于无人值守模式，执行时不会再问你。" : "Note: it runs unattended and will not ask you before it acts."] : []),
    ...(p.makesAuto ? [zh ? "确认后，以后发给它不再确认；说“每次都确认”可改回。" : "Once you confirm, tasks for it go without asking; say \"always ask first\" to change that."] : []),
    zh ? `点「发送」确认，或回复 ${typedCommand("approve", ref, "zh")}。` : `Press "Send" to confirm, or reply ${typedCommand("approve", ref, "en")}.`,
  ];
  return lines.join("\n");
}

// --- the seat's lock ----------------------------------------------------------------------------------------------------------

/**
 * Run `fn` holding the seat's lock (a session-level advisory lock on its own connection), so one task at a time is planned and sent
 * there. `wait: false` gives up at once when another holds it (a drain: the holder sends what can be sent).
 */
async function withSeatLock<T>(seatId: string, wait: boolean, fn: () => Promise<T>): Promise<T | null> {
  const client = await db.pool.connect();
  let locked = false;
  try {
    if (wait) {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [`claw-seat-dispatch:${seatId}`]);
      locked = true;
    } else {
      locked = (await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [`claw-seat-dispatch:${seatId}`])).rows[0]?.ok === true;
      if (!locked) return null;
    }
    return await fn();
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`claw-seat-dispatch:${seatId}`]).catch(() => undefined);
    client.release();
  }
}

// --- sending a task -----------------------------------------------------------------------------------------------------------

export type DispatchOutcome =
  | { dispatch: "sent"; session_id: string }
  | { dispatch: "queued"; queued_reason: ErrandQueue; position: number; ahead: number[] }
  | { error: string; message: string; data?: Record<string, unknown> };

/** Where a task goes in this seat now: a session to continue, a terminal to type into, a new session; or why it waits. */
function planFor(live: SeatLive, newSession: boolean): { plan: SendPlan } | { wait: ErrandQueue } | { error: string; message: string } {
  if (live.base === "offline") return { wait: "machine_offline" };
  if (live.base === "unsupported") return { error: "seat_unsupported", message: "that seat cannot take tasks now" };
  if (live.base === "working" || live.base === "waiting_for_you") return { wait: "seat_busy" };
  if (live.base === "in_terminal" && !newSession) return { wait: "in_terminal" };
  const seat = live.seat;
  const base = { connector_id: String(seat.connector_id), machine: live.machine, agent_id: String(seat.agent_id), agent_name: null, cwd: String(seat.cwd) };
  // ① Its session open through Claw, free.
  if (!newSession && live.session && live.session.read_only !== true) {
    return { plan: { ...base, session_id: String(live.session.session_id), resume_ref: null, label: `${live.machine}/${String(seat.agent_id)}` } };
  }
  // ② Its conversation open in a terminal, quiet for ten minutes, that the connector types into.
  if (!newSession && live.terminal?.typed) {
    return { plan: { ...base, agent_id: live.terminal.agent_id, session_id: null, resume_ref: live.terminal.ref, label: `${live.machine}/${live.terminal.agent_id}`, terminal: true } };
  }
  // ③ A new session in its folder (taking over its own conversation when it is held to one, or when its agent only takes over).
  let ref: string | null = typeof seat.conversation_ref === "string" && seat.conversation_ref ? seat.conversation_ref : null;
  if (!ref && String(live.agent?.kind) === "attach") {
    const free = resumableOf(live.agent!).filter((r) => r.cwd === seat.cwd && r.state !== "attached" && r.state !== "live")
      .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
    ref = free[0]?.ref ?? null;
    if (!ref) return { error: "seat_unsupported", message: "that seat's agent only takes over a conversation of its folder, and none is free there now" };
  }
  return { plan: { ...base, session_id: null, resume_ref: ref, label: `${live.machine}/${String(seat.agent_id)}/new` } };
}

/** Where a waiting task stands in its seat's queue: what is ahead of it (the task running there first), and its place. */
function placeIn(live: SeatLive, itemId: string): { position: number; ahead: number[] } {
  const ahead = [...live.running.map((r) => r.seq)];
  for (const q of live.queue) {
    if (q.item_id === itemId) break;
    ahead.push(q.seq);
  }
  return { position: ahead.length + 1, ahead };
}

/**
 * Send a task to its seat now, or put it in the seat's queue (`queued`), under the seat's lock. A task already in the queue keeps its
 * place; a new one is refused when the queue is full. The seat is read again here: whatever a card showed, it is what it is now.
 */
export async function dispatchErrand(
  owner: string, itemId: string, opts: { wait?: boolean; onlineWindowMs?: number } = {},
): Promise<DispatchOutcome | null> {
  const onlineWindowMs = opts.onlineWindowMs ?? REMOTE_AGENT_TIMING.onlineWindowMs;
  const item = (await db.query(
    "SELECT item_id, seq, generation, board_state, params FROM claw_work_items WHERE item_id = $1 AND user_id = $2 AND kind = 'remote'",
    [itemId, owner],
  )).rows[0] as { item_id: string; seq: number; generation: number; board_state: string; params: ErrandParams } | undefined;
  if (!item || item.board_state === "done" || item.params?.errand !== true) return { error: "item_closed", message: "that task is closed" };
  const seatId = String(item.params.seat_id ?? "");
  return withSeatLock(seatId, opts.wait !== false, async () => {
    const all = await seatsLive(owner, onlineWindowMs);
    const live = all.get(seatId);
    const refused = seatRefusal(live, seatId);
    if (refused) return { error: refused.code, message: refused.message, ...(refused.data ? { data: refused.data } : {}) };
    // Only the head of the queue goes; a task behind others waits its turn (where it is, or at the end).
    const queuedHere = live!.queue.findIndex((q) => q.item_id === itemId);
    const behind = queuedHere > 0 || (queuedHere < 0 && live!.queue.length > 0);
    const waitWhy: ErrandQueue = live!.base === "offline" ? "machine_offline" : live!.base === "in_terminal" ? "in_terminal" : "seat_busy";
    const planned = behind ? { wait: queuedHere > 0 ? (live!.queue[queuedHere]!.queued as ErrandQueue) : waitWhy } : planFor(live!, item.params.new_session === true);
    if ("error" in planned) return { error: planned.error, message: planned.message };
    const queue = async (reason: ErrandQueue): Promise<DispatchOutcome> => {
      if (queuedHere < 0 && live!.queue.length >= SEAT_QUEUE_MAX) {
        return {
          error: "seat_queue_full", message: `${SEAT_QUEUE_MAX} tasks already wait for that seat: offer to wait, the sandbox, or another seat`,
          data: { choices: ["wait", SANDBOX_TARGET, ...otherSeats(all, seatId)] },
        };
      }
      const now = new Date();
      await db.query(
        `UPDATE claw_work_items SET params = params || $2::jsonb, updated_at = NOW() WHERE item_id = $1`,
        [itemId, JSON.stringify({
          queued: reason, queued_at: item.params.queued_at && item.params.queued !== "card" ? item.params.queued_at : now.toISOString(),
          ...(reason === "machine_offline" ? { queue_expires_at: item.params.queue_expires_at ?? new Date(now.getTime() + OFFLINE_QUEUE_MS).toISOString() } : {}),
        })],
      );
      if (reason !== "machine_offline" && item.params.queue_expires_at) {
        await db.query("UPDATE claw_work_items SET params = params - 'queue_expires_at' WHERE item_id = $1", [itemId]);
      }
      const after = (await seatsLive(owner, onlineWindowMs, [seatId])).get(seatId) ?? live!;
      return { dispatch: "queued", queued_reason: reason, ...placeIn(after, itemId) };
    };
    if ("wait" in planned) return queue(planned.wait);
    // A slot of the user's (`CLAW_ASSISTANT_MAX_ACTIVE_ITEMS`): a task out of the queue takes one only when one is free.
    if (item.params.queued) {
      const active = Number((await db.query(
        `SELECT COUNT(*)::int AS n FROM claw_work_items WHERE user_id = $1 AND ${RUNNING} AND NOT (params ? 'requested_by')`, [owner],
      )).rows[0].n);
      if (active >= CLAW_ASSISTANT_MAX_ACTIVE_ITEMS) return queue(item.params.queued === "card" ? "seat_busy" : item.params.queued);
    }
    const lang: RemoteLang = item.params.lang === "zh" ? "zh" : "en";
    const caps = live!.agent?.capabilities as Row | undefined;
    const sent = await executeSend(owner, planned.plan, errandText(Number(item.seq), String(item.params.brief ?? ""), lang),
      `errand:${itemId}:${Number(item.generation)}`, lang, onlineWindowMs,
      { errandItemId: itemId, parkPermissions: caps?.permission_park === true });
    if (!sent.ok) {
      if (sent.error === "busy" || sent.error === "session_closed" || sent.error === "session_read_only") return queue("seat_busy");
      if (sent.error === "connector_offline" || sent.error === "machine_reconnected") return queue("machine_offline");
      return { error: sent.error, message: sent.message };
    }
    return { dispatch: "sent", session_id: sent.session_id };
  });
}

/** Send one more instruction to a task running in its session (the connector queues it behind the turn under way). */
async function sendFollowup(owner: string, itemId: string, text: string, onlineWindowMs: number): Promise<DispatchOutcome> {
  const item = (await db.query(
    "SELECT item_id, seq, params FROM claw_work_items WHERE item_id = $1 AND user_id = $2 AND kind = 'remote' AND board_state <> 'done'",
    [itemId, owner],
  )).rows[0] as { item_id: string; seq: number; params: ErrandParams } | undefined;
  if (!item) return { error: "item_closed", message: "that task is closed" };
  const p = item.params;
  const live = (await seatsLive(owner, onlineWindowMs, [p.seat_id])).get(p.seat_id);
  const refused = seatRefusal(live, p.seat_id);
  if (refused) return { error: refused.code, message: refused.message };
  const lang: RemoteLang = p.lang === "zh" ? "zh" : "en";
  const plan: SendPlan = {
    connector_id: p.connector_id, machine: p.machine, agent_id: p.agent_id, agent_name: null, session_id: p.session_id, resume_ref: null,
    cwd: String(live!.seat.cwd), label: `${p.machine}/${p.agent_id}`,
  };
  const caps = live!.agent?.capabilities as Row | undefined;
  const sent = await executeSend(owner, plan, errandText(Number(item.seq), text, lang), `errand:${itemId}:f:${randomUUID().slice(0, 8)}`, lang,
    onlineWindowMs, { errandItemId: itemId, parkPermissions: caps?.permission_park === true, queueBehind: true });
  if (!sent.ok) return { error: sent.error, message: sent.message };
  return { dispatch: "sent", session_id: sent.session_id };
}

// --- work_create with a seat --------------------------------------------------------------------------------------------------

export interface SeatCreateArgs { title: string; brief: string; target?: unknown; new_session?: unknown }

/** The answer a dispatch makes for the router. */
function dispatchAnswer(out: DispatchOutcome): Record<string, unknown> {
  if ("error" in out) throw new ToolRefused(out.error, out.message, out.data);
  if (out.dispatch === "sent") return { dispatch: "sent", note: "Sent: the seat's agent is on it; you will hear when it finishes or needs the user. Say in one line to whom and the item number." };
  return {
    dispatch: "queued", queued_reason: out.queued_reason, position: out.position, ahead: out.ahead,
    note: "Queued: it goes when the seat is free. Say in one line its place and the items ahead (#n).",
  };
}

/**
 * `work_create` with a seat target: the task as an errand item, sent now, queued, or put to the user on a card (one seat, or several
 * as a choice card), as the module's comment says.
 */
export async function seatWorkCreate(claims: AssistantTokenClaims, args: SeatCreateArgs): Promise<Record<string, unknown>> {
  const q: Querier = (t, p) => db.query(t, p);
  const { userId } = await assertLiveRun(q, claims);
  if (!seatDispatchOn(userId)) throw new ToolRefused("not_enabled", "tasks cannot be handed to seats for this user: use work_create without target");
  const target = parseTarget(args.target);
  if (!target) {
    throw new ToolRefused("invalid_target", `target is "sandbox", "seat:<seat_id>" from seat_roster, or a list of ${CHOICES_MIN} to ${CHOICES_MAX} of those`);
  }
  if (target.kind !== "seats") throw new ToolRefused("invalid_target", "no seat named");
  const title = clipOneLine(args.title, TITLE_MAX);
  const brief = String(args.brief ?? "").trim();
  if (!title || !brief) throw new ToolRefused("invalid_arguments", "work_create needs a title and a brief");
  const message = await turnMessage(q, claims.sid, claims.mid);
  if (!message) throw new ToolRefused("not_from_user", "only the user's own message can hand a task to their machine: a report or a wake cannot");
  const lang = langOf(message.content);
  const zh = lang === "zh";
  if (Buffer.byteLength(errandText(99_999_999, brief, lang)) > REMOTE_AGENT_LIMITS.maxPromptBytes) {
    throw new ToolRefused("brief_too_long", `the brief is too long to send to a machine (at most ${REMOTE_AGENT_LIMITS.maxPromptBytes} bytes)`);
  }
  let attendedRefusal: string | null = null;
  try {
    await attendedTurn(q, claims);
  } catch (err) {
    if (!(err instanceof ToolRefused)) throw err;
    attendedRefusal = err.code;
  }
  await syncSeats(userId);
  const all = await seatsLive(userId);
  for (const id of target.seats) {
    const refused = seatRefusal(all.get(id), id);
    if (refused) throw refused;
  }
  const newSession = args.new_session === true && target.seats.length === 1 && !target.sandbox;
  const choice = target.seats.length > 1 || target.sandbox;
  const live = choice ? null : all.get(target.seats[0]!)!;
  const why = live ? whyCard(live, attendedRefusal) : "choice";
  const { assistantSchedulesOn, proposeConfirmation, proposed } = await import("./schedules.js");
  if (why && !assistantSchedulesOn()) throw new ToolRefused("cards_off", "confirmation cards are off here, so nothing can be handed to the user's machine");
  // A full queue is said before anything is made: offer to wait, the sandbox, or another seat.
  if (live && live.base !== "idle" && live.queue.length >= SEAT_QUEUE_MAX && !(live.base === "in_terminal" && newSession)) {
    throw new ToolRefused("seat_queue_full", `${SEAT_QUEUE_MAX} tasks already wait for that seat: offer to wait, the sandbox, or another seat`,
      { choices: ["wait", SANDBOX_TARGET, ...otherSeats(all, target.seats[0]!)] });
  }
  const itemId = newWorkItemId();
  const seatId = live ? String(live.seat.seat_id) : "";
  const params: ErrandParams = {
    errand: true, seat_id: seatId, alias: live && typeof live.seat.alias === "string" ? live.seat.alias : null, brief,
    connector_id: live ? String(live.seat.connector_id) : "", session_id: "", agent_id: live ? String(live.seat.agent_id) : "",
    machine: live?.machine ?? "", asked: flat(brief, 120), origin: "assistant", lang, open_turns: 0, open_cmd_seqs: [], waiting: [], last_event_id: 0,
    ...(newSession ? { new_session: true as const } : {}), ...(live?.unattended ? { unattended: true as const } : {}),
    ...(why ? { queued: "card" as const, queued_at: new Date().toISOString() } : {}),
    ...(choice ? { choices: [...target.seats, ...(target.sandbox ? [SANDBOX_TARGET] : [])] } : {}),
  };
  const options: AssistantConfirmOption[] | undefined = choice
    ? [
      ...target.seats.map((id) => {
        const l = all.get(id)!;
        return { id, label: seatLabel(l), detail: flat(l.seat.cwd, 200) };
      }),
      ...(target.sandbox ? [{ id: SANDBOX_TARGET, label: zh ? "沙箱" : "Sandbox" }] : []),
    ]
    : undefined;
  const made = await inTransaction(async (tx) => {
    await assertLiveRun(tx, claims);
    await tx("SELECT 1 FROM claw_assistants WHERE user_id = $1 FOR UPDATE", [userId]);
    // The same task for the same place a moment ago is a replayed call: that one.
    const same = (await tx(
      `SELECT item_id, seq FROM claw_work_items WHERE user_id = $1 AND kind = 'remote' AND params->>'errand' = 'true' AND board_state <> 'done'
          AND title = $2 AND params->>'seat_id' = $3 AND created_at > NOW() - $4::interval`,
      [userId, title, seatId, DUPLICATE_WINDOW],
    )).rows[0] as { item_id: string; seq: number } | undefined;
    if (same) return { itemId: same.item_id, seq: Number(same.seq), card: null, duplicate: true };
    const inserted = await insertWorkItem({ query: tx }, {
      userId, title, workerSessionId: errandWorkerSessionId(itemId), kind: "remote", params: params as unknown as Record<string, unknown>, itemId,
    });
    if (!inserted.ok) {
      throw new ToolRefused(inserted.error, inserted.error === "too_many_active_items"
        ? "too many unfinished items: ask the user which to stop or finish first" : "the user has no assistant");
    }
    if (!why) return { itemId, seq: inserted.seq, card: null, duplicate: false };
    const makesAuto = !!live && live.seat.role_state === "confirmed" && live.seat.confirm_each !== true && !live.unattended;
    const cardParams = {
      item_id: itemId, seat_id: seatId, title, brief, lang, why_card: why,
      ...(choice ? { choices: params.choices, options } : { label: seatLabel(live!), cwd: flat(live!.seat.cwd, 300) }),
    };
    const card = await proposeConfirmation(tx, claims, userId, "seat_dispatch", cardParams, {
      text: (ref) => seatCardText({
        label: live ? seatLabel(live) : "", cwd: live ? flat(live.seat.cwd, 300) : "", brief, why, makesAuto, unattended: live?.unattended === true,
        ...(choice ? { choice: options!.map((o) => (o.detail ? `${o.label}（${o.detail}）` : o.label)) } : {}),
      }, ref, zh),
      allowLabel: zh ? "发送" : "Send",
      ...(options ? { options } : {}),
    });
    await tx("UPDATE claw_work_items SET params = params || $2::jsonb WHERE item_id = $1",
      [itemId, JSON.stringify({ confirmation_id: String(card.row.confirmation_id) })]);
    return { itemId, seq: inserted.seq, card, duplicate: false };
  });
  const who = live ? { seat_id: seatId, alias: params.alias ?? null, ...(params.alias ? {} : { machine: live.machine, agent: String(live.seat.agent_id) }) } : {};
  // (A machine's name is what its connector reported: a turn that was told it acts on nothing more.)
  if (live && !params.alias) await markUntrustedRead(q, claims.sid, claims.mid);
  const base = { ok: true, item_id: made.itemId, seq: made.seq, ...who };
  if (made.duplicate) return { ...base, deduplicated: true, note: "This task was already handed over a moment ago: say so in one line." };
  if (made.card) {
    if (made.card.announce) await made.card.announce();
    return {
      ...base, dispatch: "card", why_card: why, ...proposed(made.card.row, made.card.subscribers, "sent", lang),
      ...(choice ? { choices: params.choices } : {}),
    };
  }
  return { ...base, ...dispatchAnswer((await dispatchErrand(userId, made.itemId))!) };
}

// --- the card pressed ---------------------------------------------------------------------------------------------------------

/**
 * A `seat_dispatch` card answered (`decideConfirmation`). Allowed: the seat (the one chosen, on a choice card) is checked again and the
 * task sent or queued; a confirmed seat's first press makes it send directly from now on (`auto`), unless the user asked for a card each
 * time or its agent runs unattended. The sandbox chosen: the task becomes a worker's item, under its number. Denied: the task is dropped.
 * What reaches beyond the database (sending, a worker's run) is `after`, run once the decision committed; its outcome is the card's result.
 */
export async function seatDispatchDecided(
  q: Querier, userId: string, row: Row, allow: boolean, choice: string | null,
): Promise<{ result: Record<string, unknown> & { ok: boolean }; after?: () => Promise<Record<string, unknown>> }> {
  const params = (row.params ?? {}) as Row;
  const itemId = String(params.item_id ?? "");
  const item = (await q(
    "SELECT item_id, seq, board_state, params FROM claw_work_items WHERE item_id = $1 AND user_id = $2 AND kind = 'remote' FOR UPDATE", [itemId, userId],
  )).rows[0] as { item_id: string; seq: number; board_state: string; params: ErrandParams } | undefined;
  if (!item || item.board_state === "done") return { result: { ok: false, error: "item_closed", message: "that task was stopped or closed" } };
  const followup = typeof params.followup === "string" ? params.followup : null;
  if (!allow) {
    if (!followup) await dropErrand(q, itemId, item.params.lang === "zh" ? "你没有让它交出去" : "the user did not send it");
    return { result: { ok: true, item_id: itemId, dropped: !followup } };
  }
  const seatId = Array.isArray(params.choices) ? String(choice ?? "") : String(params.seat_id ?? "");
  if (seatId === SANDBOX_TARGET) {
    const started = await errandToSandbox(q, userId, item, String(row.session_id));
    if (!started) return { result: { ok: false, error: "no_credentials", message: "the sandbox cannot be started for this user now" } };
    return {
      result: { ok: true, item_id: itemId, seq: Number(item.seq), to: SANDBOX_TARGET },
      after: async () => { await drainSessionIfIdle(started, userId).catch(() => undefined); return { ok: true, to: SANDBOX_TARGET }; },
    };
  }
  const live = (await seatsLive(userId, undefined, [seatId])).get(seatId);
  const refused = seatRefusal(live, seatId);
  if (refused) {
    if (!followup) await dropErrand(q, itemId, refused.message);
    return { result: { ok: false, error: refused.code, message: refused.message } };
  }
  // The first card the user pressed for a confirmed seat: tasks go to it directly from now on.
  if (live!.seat.role_state === "confirmed" && live!.seat.confirm_each !== true && !live!.unattended && live!.seat.dispatch_mode !== "auto") {
    await q("UPDATE claw_devenv_seats SET dispatch_mode = 'auto', auto_since = NOW(), updated_at = NOW() WHERE seat_id = $1 AND owner_user_id = $2",
      [seatId, userId]);
  }
  if (!followup) {
    await q(
      `UPDATE claw_work_items SET params = (params - 'queued' - 'queued_at') || $2::jsonb, updated_at = NOW() WHERE item_id = $1`,
      [itemId, JSON.stringify({
        seat_id: seatId, alias: typeof live!.seat.alias === "string" ? live!.seat.alias : null, connector_id: String(live!.seat.connector_id),
        agent_id: String(live!.seat.agent_id), machine: live!.machine, ...(live!.unattended ? { unattended: true } : {}),
      })],
    );
  }
  return {
    result: { ok: true, item_id: itemId, seq: Number(item.seq), seat_id: seatId, alias: live!.seat.alias ?? null },
    after: async () => {
      const out = followup !== null ? await sendFollowup(userId, itemId, followup, REMOTE_AGENT_TIMING.onlineWindowMs) : await dispatchErrand(userId, itemId);
      if (!out) return { ok: false, error: "busy", message: "try again" };
      if ("error" in out) {
        if (followup === null) await dropErrand((t, v) => db.query(t, v), itemId, out.message);
        return { ok: false, error: out.error, message: out.message };
      }
      return { ok: true, ...out };
    },
  };
}

/** A task closed unsent: its card denied or lapsed, its seat gone. Not said: the user knows, and the item list shows it. */
async function dropErrand(q: Querier, itemId: string, why: string): Promise<void> {
  await q(
    `UPDATE claw_work_items SET board_state = 'done', outcome = 'dropped', last_report_kind = 'dropped', summary = $2, pending_question = NULL,
            params = params - 'queued' - 'queued_at' - 'queue_expires_at', closed_at = NOW(), updated_at = NOW()
      WHERE item_id = $1 AND board_state <> 'done'`,
    [itemId, clipOneLine(why, 80)],
  );
  await q(`INSERT INTO claw_work_item_events (item_id, kind, source, generation, summary)
           SELECT item_id, 'dropped', 'remote', generation, $2 FROM claw_work_items WHERE item_id = $1`, [itemId, clipOneLine(why, 200)]);
}

/**
 * The sandbox chosen on a choice card: the task becomes a worker's item under its own number, with the credentials the user's messages
 * gave their assistant, as `work_create` starts one: its worker session, run once the decision committed.
 */
async function errandToSandbox(q: Querier, userId: string, item: { item_id: string; params: ErrandParams }, routerSid: string): Promise<string | null> {
  const router = (await q("SELECT config FROM claw_sessions WHERE session_id = $1", [routerSid])).rows[0] as { config: unknown } | undefined;
  const creds = readTrustedSessionCredentials(router?.config);
  const title = (await q("SELECT title FROM claw_work_items WHERE item_id = $1", [item.item_id])).rows[0]?.title as string;
  const workerSessionId = randomUUID();
  await insertSessionRow({ query: q }, {
    sessionId: workerSessionId, name: title, userId, mode: "claw", agentStatus: "idle", systemPrompt: "",
    config: { ...sealedCredentialFields(creds) }, parentSid: null, role: "", model: CLAW_ASSISTANT_WORKER_MODEL || null,
  }, { parentSid: null });
  await q(
    `UPDATE claw_work_items SET kind = 'task', worker_session_id = $2, params = '{}'::jsonb, board_state = 'in_progress', updated_at = NOW()
      WHERE item_id = $1`,
    [item.item_id, workerSessionId],
  );
  const queued = await queueServerMessage({ query: q }, { sessionId: workerSessionId, userId, content: String(item.params.brief ?? ""), dedupeKey: `start:${item.item_id}` });
  return queued.ok ? workerSessionId : null;
}

// --- work_send to a task of a seat --------------------------------------------------------------------------------------------

/**
 * `work_send` to a seat's task: the same say as `work_create` for its seat. Running: one more instruction into its session. Ended
 * (finished within a week, failed, or stopped where it ran): opened again and sent again, as a new task to the same seat. Not sent yet
 * (its card waits, or its queue): nothing is added to what the user was shown.
 */
export async function errandWorkSend(
  claims: AssistantTokenClaims, userId: string, itemId: string, text: string, newSession: boolean,
): Promise<Record<string, unknown>> {
  const q: Querier = (t, p) => db.query(t, p);
  if (!seatDispatchOn(userId)) throw new ToolRefused("not_enabled", "tasks cannot be handed to seats for this user now");
  const item = (await q("SELECT item_id, seq, board_state, outcome, closed_at, last_report_kind, generation, params FROM claw_work_items WHERE item_id = $1 AND user_id = $2",
    [itemId, userId])).rows[0] as Row | undefined;
  if (!item) throw new ToolRefused("item_not_found", "no such item");
  const p = item.params as ErrandParams;
  if (p.queued) {
    throw new ToolRefused("item_not_started", p.queued === "card"
      ? "that task still waits for the user's card: ask them to press it (or say no), then send more"
      : "that task still waits in its seat's queue: wait for it to start, or stop it and create a new one");
  }
  const message = await turnMessage(q, claims.sid, claims.mid);
  if (!message) throw new ToolRefused("not_from_user", "only the user's own message can send more to their machine: a report or a wake cannot");
  const lang = langOf(message.content);
  if (Buffer.byteLength(errandText(99_999_999, text, lang)) > REMOTE_AGENT_LIMITS.maxPromptBytes) {
    throw new ToolRefused("brief_too_long", `the instruction is too long to send to a machine (at most ${REMOTE_AGENT_LIMITS.maxPromptBytes} bytes)`);
  }
  let attendedRefusal: string | null = null;
  try { await attendedTurn(q, claims); } catch (err) {
    if (!(err instanceof ToolRefused)) throw err;
    attendedRefusal = err.code;
  }
  const live = (await seatsLive(userId, undefined, [p.seat_id])).get(p.seat_id);
  const refused = seatRefusal(live, p.seat_id);
  if (refused) throw refused;
  const running = item.board_state !== "done" && Array.isArray(p.open_cmd_seqs) && p.open_cmd_seqs.length > 0;
  if (!running) {
    const reopen = item.board_state !== "done"
      || (new Date(item.closed_at).getTime() > Date.now() - 7 * 86_400_000);
    if (!reopen) throw new ToolRefused("item_closed", "that task closed more than a week ago: hand a new one to the seat with work_create");
  }
  const why = whyCard(live!, attendedRefusal);
  const zh = lang === "zh";
  if (why) {
    const { assistantSchedulesOn, proposeConfirmation, proposed } = await import("./schedules.js");
    if (!assistantSchedulesOn()) throw new ToolRefused("cards_off", "confirmation cards are off here, so nothing can be sent to the user's machine");
    const card = await inTransaction(async (tx) => {
      await assertLiveRun(tx, claims);
      await tx("SELECT 1 FROM claw_assistants WHERE user_id = $1 FOR UPDATE", [userId]);
      if (!running) await reopenErrand(tx, itemId, text, newSession, true);
      return proposeConfirmation(tx, claims, userId, "seat_dispatch", {
        item_id: itemId, seat_id: p.seat_id, title: String(item.title ?? ""), brief: text, lang, why_card: why, label: seatLabel(live!),
        cwd: flat(live!.seat.cwd, 300), ...(running ? { followup: text } : {}),
      }, {
        text: (ref) => seatCardText({ label: seatLabel(live!), cwd: flat(live!.seat.cwd, 300), brief: text, why, makesAuto: false, unattended: live!.unattended }, ref, zh),
        allowLabel: zh ? "发送" : "Send",
      });
    });
    if (!running) await q("UPDATE claw_work_items SET params = params || $2::jsonb WHERE item_id = $1", [itemId, JSON.stringify({ confirmation_id: String(card.row.confirmation_id) })]);
    if (card.announce) await card.announce();
    return { ok: true, item_id: itemId, seq: Number(item.seq), dispatch: "card", why_card: why, ...proposed(card.row, card.subscribers, "sent", lang) };
  }
  if (running) {
    const out = await sendFollowup(userId, itemId, text, REMOTE_AGENT_TIMING.onlineWindowMs);
    return { ok: true, item_id: itemId, seq: Number(item.seq), ...dispatchAnswer(out) };
  }
  await inTransaction(async (tx) => { await reopenErrand(tx, itemId, text, newSession, false); });
  return { ok: true, item_id: itemId, seq: Number(item.seq), ...dispatchAnswer((await dispatchErrand(userId, itemId))!) };
}

/** A seat's task opened again for a new instruction: in progress, a new generation, the instruction its brief; waiting for its card when one is put. */
async function reopenErrand(q: Querier, itemId: string, text: string, newSession: boolean, card: boolean): Promise<void> {
  await q(
    `UPDATE claw_work_items
        SET board_state = 'in_progress', outcome = NULL, closed_at = NULL, last_report_kind = 'progress', pending_question = NULL, summary = '',
            generation = generation + 1,
            params = (params - 'report_due' - 'progress' - 'progress_told_at' - 'progress_told_h' - 'offline_told' - 'new_session' - 'dispatched_at' - 'queued' - 'queued_at')
                     || $2::jsonb,
            updated_at = NOW()
      WHERE item_id = $1`,
    [itemId, JSON.stringify({
      brief: text, open_cmd_seqs: [], open_turns: 0, waiting: [], ...(newSession ? { new_session: true } : {}),
      ...(card ? { queued: "card", queued_at: new Date().toISOString() } : {}),
    })],
  );
  await q(`INSERT INTO claw_work_item_events (item_id, kind, source, generation, summary)
           SELECT item_id, 'progress', 'router', generation, $2 FROM claw_work_items WHERE item_id = $1`, [itemId, clipOneLine(text, 200)]);
}

// --- the queue going on -------------------------------------------------------------------------------------------------------

/** After events of these sessions: each seat of the user's with tasks waiting takes the next one, when it is free. Never throws. */
export async function drainSeatsOf(owner: string, _sessionIds: readonly string[]): Promise<number> {
  if (!seatDispatchOn(owner)) return 0;
  const seats = (await db.query(
    `SELECT DISTINCT params->>'seat_id' AS seat_id FROM claw_work_items
      WHERE user_id = $1 AND kind = 'remote' AND params->>'errand' = 'true' AND board_state <> 'done' AND params->>'queued' = ANY($2::text[])`,
    [owner, SEAT_QUEUE_REASONS],
  )).rows as Array<{ seat_id: string }>;
  let sent = 0;
  for (const s of seats) {
    try {
      const head = (await db.query(
        `SELECT item_id FROM claw_work_items
          WHERE user_id = $1 AND kind = 'remote' AND params->>'errand' = 'true' AND board_state <> 'done' AND params->>'seat_id' = $2
            AND params->>'queued' = ANY($3::text[])
          ORDER BY params->>'queued_at', seq LIMIT 1`,
        [owner, s.seat_id, SEAT_QUEUE_REASONS],
      )).rows[0] as { item_id: string } | undefined;
      if (!head) continue;
      const out = await dispatchErrand(owner, head.item_id, { wait: false });
      if (out && "dispatch" in out && out.dispatch === "sent") sent += 1;
      if (out && "error" in out && out.error !== "seat_queue_full") {
        // It can never go now (the seat retired, unsupported): failed, and said.
        await failQueued(owner, head.item_id, out.message);
      }
    } catch (err) {
      logger.warn({ err, seat: s.seat_id }, "assistant.seat_drain_failed");
    }
  }
  return sent;
}

/** A task that waited in a queue and will not go: it fails, said as such, and the router hears of it. */
async function failQueued(owner: string, itemId: string, why: string): Promise<void> {
  const row = (await db.query(
    `UPDATE claw_work_items SET params = params - 'queued' - 'queued_at' - 'queue_expires_at', updated_at = NOW()
      WHERE item_id = $1 AND user_id = $2 AND board_state <> 'done' AND params ? 'queued' RETURNING seq, generation, params`,
    [itemId, owner],
  )).rows[0] as { seq: number; generation: number; params: ErrandParams } | undefined;
  if (!row) return;
  const router = (await db.query("SELECT session_id FROM claw_assistants WHERE user_id = $1", [owner])).rows[0]?.session_id as string | undefined;
  if (router) {
    await recordSystemNotice({
      userId: owner, sessionId: router, text: errandNotice("failed", row.params, Number(row.seq), why), key: `remote:${itemId}:queue_failed:${row.generation}`,
      itemId, remote: {
        kind: "error", session_id: row.params.session_id ?? "", machine: row.params.machine ?? "", agent: row.params.agent_id ?? "", item_seq: Number(row.seq),
        ...(row.params.seat_id ? { seat: { seat_id: row.params.seat_id, alias: row.params.alias ?? null } } : {}),
      },
    }).catch((err) => logger.warn({ err, itemId }, "assistant.errand_notice_failed"));
  }
  await reportErrand({ itemId, generation: Number(row.generation), kind: "failed", summary: why });
}

export interface ErrandSweepResult { reported: number; dropped: number; expired: number; sent: number; told: number }

/**
 * One pass over a user's seat tasks: ends not yet reported are reported; tasks whose card lapsed (or was closed) are dropped; tasks that
 * waited a day for their machine fail; free seats take their next task; a task that has run an hour (and each hour after) is said in one
 * line with its latest step, and once when its machine has been offline for an hour.
 */
export async function runErrandSweep(owner: string, now: number = Date.now(), onlineWindowMs: number = REMOTE_AGENT_TIMING.onlineWindowMs): Promise<ErrandSweepResult> {
  const out: ErrandSweepResult = { reported: 0, dropped: 0, expired: 0, sent: 0, told: 0 };
  if (!seatDispatchOn(owner)) return out;
  const q: Querier = (t, p) => db.query(t, p);
  for (const r of (await q(
    `SELECT item_id, params->'report_due' AS due FROM claw_work_items
      WHERE user_id = $1 AND kind = 'remote' AND params->>'errand' = 'true' AND params ? 'report_due' AND updated_at < NOW() - INTERVAL '1 minute'`,
    [owner],
  )).rows as Row[]) {
    const due = r.due as ErrandParams["report_due"];
    if (!due) continue;
    await reportErrand({ itemId: String(r.item_id), generation: Number(due.generation), kind: due.kind, summary: String(due.summary) })
      .catch((err) => logger.warn({ err, itemId: r.item_id }, "assistant.errand_report_failed"));
    out.reported += 1;
  }
  // A card that is no longer waiting (lapsed, or closed with its machine): its task goes with it.
  for (const r of (await q(
    `SELECT w.item_id FROM claw_work_items w JOIN claw_assistant_confirmations c ON c.confirmation_id = w.params->>'confirmation_id'
      WHERE w.user_id = $1 AND w.kind = 'remote' AND w.params->>'errand' = 'true' AND w.board_state <> 'done' AND w.params->>'queued' = 'card'
        AND (c.status <> 'pending' OR c.expires_at <= NOW())`,
    [owner],
  )).rows as Row[]) {
    await dropErrand(q, String(r.item_id), "the card lapsed unanswered");
    out.dropped += 1;
  }
  for (const r of (await q(
    `SELECT item_id, params FROM claw_work_items
      WHERE user_id = $1 AND kind = 'remote' AND params->>'errand' = 'true' AND board_state <> 'done' AND params->>'queued' = 'machine_offline'
        AND (params->>'queue_expires_at')::timestamptz < to_timestamp($2::float8 / 1000)`,
    [owner, now],
  )).rows as Row[]) {
    const zh = (r.params as ErrandParams).lang === "zh";
    await failQueued(owner, String(r.item_id), zh ? "机器 24 小时没上线" : "its machine was not back within 24 hours");
    out.expired += 1;
  }
  out.sent += await drainSeatsOf(owner, []);
  // A task that has run an hour: one line each hour, with its latest step; a machine offline for an hour, once.
  const long = (await q(
    `SELECT w.item_id, w.seq, w.params, a.session_id AS router_sid, c.online, c.last_seen
       FROM claw_work_items w JOIN claw_assistants a ON a.user_id = w.user_id
       LEFT JOIN LATERAL (SELECT (x.heartbeat_at > NOW() - make_interval(secs => $3::float8)) AS online, x.heartbeat_at AS last_seen
                            FROM claw_remote_connectors x WHERE x.connector_id::text = w.params->>'connector_id') c ON TRUE
      WHERE w.user_id = $1 AND w.kind = 'remote' AND w.params->>'errand' = 'true' AND w.board_state <> 'done' AND NOT (w.params ? 'queued')
        AND jsonb_array_length(COALESCE(w.params->'open_cmd_seqs', '[]'::jsonb)) > 0
        AND (w.params->>'dispatched_at')::timestamptz < to_timestamp($2::float8 / 1000) - make_interval(secs => $4::float8)`,
    [owner, now, onlineWindowMs / 1000, PROGRESS_EVERY_MS / 1000],
  )).rows as Row[];
  for (const r of long) {
    const p = r.params as ErrandParams;
    const seat = p.seat_id ? { seat_id: p.seat_id, alias: p.alias ?? null } : undefined;
    const remote = { session_id: p.session_id, machine: p.machine, agent: p.agent_id, item_seq: Number(r.seq), ...(seat ? { seat } : {}) };
    const tell = async (key: string, kind: "progress" | "error", text: string) => {
      await recordSystemNotice({ userId: owner, sessionId: String(r.router_sid), text, key: `remote:${r.item_id}:${key}`, remote: { kind, ...remote } })
        .catch((err) => logger.warn({ err, itemId: r.item_id }, "assistant.errand_notice_failed"));
      out.told += 1;
    };
    if (r.online !== true) {
      const away = r.last_seen ? now - new Date(r.last_seen).getTime() : Infinity;
      if (!p.offline_told && away > OFFLINE_TOLD_MS) {
        await q("UPDATE claw_work_items SET params = params || '{\"offline_told\": true}'::jsonb WHERE item_id = $1", [r.item_id]);
        await tell("offline", "progress", errandNotice("offline", p, Number(r.seq)));
      }
      continue;
    }
    const hours = Math.floor((now - new Date(String(p.dispatched_at)).getTime()) / PROGRESS_EVERY_MS);
    if (hours < 1 || hours <= (Number(p.progress_told_h) || 0)) continue;
    // No step of a plan: the latest tool step it took (its title, as the agent wrote it).
    const step = p.progress?.current ? "" : flat((await q(
      `SELECT data->'update'->>'title' AS title FROM claw_remote_events WHERE session_id = $1::uuid AND type = 'tool_call'
          AND COALESCE(data->>'replay', '') <> 'true' ORDER BY id DESC LIMIT 1`,
      [p.session_id],
    )).rows[0]?.title, 80);
    await q("UPDATE claw_work_items SET params = params || $2::jsonb WHERE item_id = $1",
      [r.item_id, JSON.stringify({ progress_told_at: new Date(now).toISOString(), progress_told_h: hours })]);
    await tell(`progress:${hours}`, "progress", errandNotice("progress", p, Number(r.seq), step, { hours }));
  }
  return out;
}
