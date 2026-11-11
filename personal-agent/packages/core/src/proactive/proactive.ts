// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * When an unasked message may reach a person (teams_agent/proactive.py `Proactive.handle`): quiet hours, /pause, held notices
 * and approvals. Claw only says that something happened; when to bother a person is decided here.
 *
 * What the assistant says is an answer more than a push: for the reply window after the person last wrote it is delivered even in
 * quiet hours or a pause; outside it, it is held. An approval is never pushed to wake anyone; one that runs out while held is
 * refused. A run's end that the chat's own turn already answered is not shown again; one whose turn is still answering is asked
 * again ("retry").
 */
import type { JsonObject } from "../json.js";
import { remoteNoticeOf } from "../assistant/events.js";
import { ASSISTANT_SAID_TYPES, ITEM_SOURCE } from "../subscriptions/event-types.js";
import { redactText } from "../security/redact.js";
import { Deliveries } from "./deliver.js";
import type { ProactiveDeps } from "./deps.js";
import { EXPIRES_KEY, REMOTE_SAID, finishedAt, type AnsweredInChat } from "./events.js";
import { approvalExpiry, muted, type Muted } from "./quiet.js";

export { EXPIRES_KEY, REMOTE_SAID, finishedAt };

export type Outcome = "delivered" | "held" | "dropped" | "retry";

/** The turn deadline plus slack: a turn older than this died with its worker. */
export const TURN_RUNNING_MAX_SECONDS = 30 * 60 + 120;
export const SKEW_SLACK_SECONDS = 60;
/** A notification that comes as its run's chat turn ends waits for the turn, up to this, within Claw's 5 s delivery timeout. */
export const TURN_SETTLE_WAIT_SECONDS = 3.5;
export const TURN_SETTLE_POLL_SECONDS = 0.1;
/** A chat attached this close to a session's end may not have been shown it: it is told. */
export const ATTACHED_SLACK_SECONDS = 2.0;

export class Proactive {
  /** An attached chat hears its session between turns (REMOTE_PUSH_ENABLED): set by the assembly that owns both. */
  showsAttached = false;
  readonly deliveries: Deliveries;

  constructor(private readonly deps: ProactiveDeps) {
    this.deliveries = new Deliveries(deps, (event, now) => this.answeredInChat(event, now));
  }

  muted(userId: string): Muted | undefined {
    return muted(this.deps.store.prefs.getPrefs(userId), this.deps.store.now());
  }

  /** The person wrote (or pressed a button) within the reply window: what the assistant says now is a reply. */
  inReplyWindow(userId: string): boolean {
    const last = this.deps.store.references.lastInboundAt(userId);
    return last !== null && this.deps.store.now() - last <= this.deps.replyWindowSeconds;
  }

  /**
   * May something the person did not ask for be pushed now (what a remote agent says on its own)? Not in quiet hours or a pause;
   * but a person who wrote a moment ago is in the conversation, which lifts quiet hours (never an explicit /pause).
   */
  reachable(userId: string): boolean {
    const why = this.muted(userId);
    return why === undefined || (why === "quiet" && this.inReplyWindow(userId));
  }

  /** Hold what a remote agent (`label`) said on its own while the person may not be woken; credential shapes masked first. */
  holdRemote(userId: string, label: string, text: string, eventId: string): void {
    this.deps.store.held.holdEvent(userId, {
      type: REMOTE_SAID,
      event_id: `remote-${eventId}`,
      label,
      text: redactText(text).text,
      occurred_at: pythonIsoUtc(this.deps.store.now()),
    });
  }

  /** What became of `event` for the person: delivered, held, dropped, or retry (a chat turn is still answering that run). */
  async handle(userId: string, reference: JsonObject, event: JsonObject): Promise<Outcome> {
    const now = this.deps.store.now();
    const type = event["type"];
    if (typeof type === "string" && ASSISTANT_SAID_TYPES.includes(type)) {
      if (this.shownInChat(userId, event, now)) return "dropped";
      return this.answerOrHold(userId, reference, event);
    }
    if (type === "approval.requested") {
      const approval = this.approval(event, now);
      if (typeof approval === "string") return approval;
      if (approval["source"] === ITEM_SOURCE) return this.answerOrHold(userId, reference, approval);
      return this.pushOrHold(userId, reference, approval);
    }
    let answered = this.answeredInChat(event, now);
    if (answered === "running") answered = await this.settled(event);
    if (answered === "delivered") return "dropped";
    if (answered === "running") {
      this.deps.logger.info(
        "a run's notification came while its chat turn was still answering; Claw is asked to send it again",
      );
      return "retry";
    }
    return this.pushOrHold(userId, reference, event);
  }

  /** A reply of the assistant: delivered in the reply window or when nothing mutes, held otherwise. */
  private async answerOrHold(userId: string, reference: JsonObject, event: JsonObject): Promise<Outcome> {
    if (this.muted(userId) && !this.inReplyWindow(userId)) {
      this.deps.store.held.holdEvent(userId, event);
      return "held";
    }
    return (await this.deliveries.send(userId, reference, event)) ? "delivered" : "dropped";
  }

  private async pushOrHold(userId: string, reference: JsonObject, event: JsonObject): Promise<Outcome> {
    if (this.muted(userId)) {
      this.deps.store.held.holdEvent(userId, event);
      return "held";
    }
    return (await this.deliveries.send(userId, reference, event)) ? "delivered" : "dropped";
  }

  /**
   * An approval event with its expiry added, or the outcome it already has: malformed or out of time (dropped), or a card for it
   * is in a chat already (dropped; "retry" while that card is still being sent, since it may yet fail).
   */
  private approval(event: JsonObject, now: number): JsonObject | Outcome {
    const approval = event["approval"];
    const record =
      typeof approval === "object" && approval !== null && !Array.isArray(approval)
        ? (approval as JsonObject)
        : undefined;
    if (record === undefined || !record["tool_use_id"] || !event["session_id"]) return "dropped";
    const expires = approvalExpiry(event, now);
    if (expires <= now) return "dropped";
    const sessionId = text(event["session_id"]);
    const toolUseId = text(record["tool_use_id"]);
    if (this.deps.store.approvals.getApproval(sessionId, toolUseId) !== null) {
      return this.deps.store.approvals.approvalInFlight(sessionId, toolUseId) ? "retry" : "dropped";
    }
    return { ...event, [EXPIRES_KEY]: expires };
  }

  /**
   * A session's finish or failure that the chat already showed: it was attached to that very session, and following it, since
   * before this happened. Decided when the push arrives, never when a held one is released.
   */
  private shownInChat(userId: string, event: JsonObject, now: number): boolean {
    const remote = remoteNoticeOf(event);
    // (a request waiting, or the end of a terminal's question, is never "already shown": its card is this chat's to draw or end)
    if (remote === undefined || remote.kind === "needs_you" || remote.kind === "resolved" || !this.showsAttached)
      return false;
    const state = this.deps.store.remoteState.attachedRemote(userId);
    return (
      state !== null &&
      state.sessionId === remote.sessionId &&
      state.attachedAt > 0 &&
      state.attachedAt < finishedAt(event, now) - ATTACHED_SLACK_SECONDS
    );
  }

  /** Whether this worker's own turn answered the run in the chat ("lost": a turn of an earlier process died answering it). */
  answeredInChat(event: JsonObject, now: number): AnsweredInChat {
    const type = event["type"];
    if ((type !== "run.completed" && type !== "run.failed") || !event["session_id"]) return null;
    const messageId = typeof event["message_id"] === "string" ? event["message_id"] : "";
    return this.deps.store.turns.answeredInChat(text(event["session_id"]), {
      finishedAt: finishedAt(event, now),
      runningMax: TURN_RUNNING_MAX_SECONDS,
      slack: SKEW_SLACK_SECONDS,
      ...(messageId ? { messageId } : {}),
    });
  }

  /** `answeredInChat` once the chat turn answering this run has ended, or "running" when it has not within the settle wait. */
  private async settled(event: JsonObject): Promise<AnsweredInChat> {
    const { clock, store } = this.deps;
    const deadline = clock.monotonicMs() + TURN_SETTLE_WAIT_SECONDS * 1000;
    for (;;) {
      const answered = this.answeredInChat(event, store.now());
      if (answered !== "running" || clock.monotonicMs() >= deadline) return answered;
      await clock.sleep(TURN_SETTLE_POLL_SECONDS * 1000);
    }
  }
}

/** `datetime.fromtimestamp(seconds, timezone.utc).isoformat()`: microseconds only when there are any, and "+00:00". */
export function pythonIsoUtc(seconds: number): string {
  const whole = Math.floor(seconds);
  const micros = Math.round((seconds - whole) * 1e6);
  const base = new Date(whole * 1000).toISOString().slice(0, 19);
  return `${base}${micros ? `.${String(micros).padStart(6, "0")}` : ""}+00:00`;
}

/** Python's `str(value)` for the scalar ids Claw sends. */
function text(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}
