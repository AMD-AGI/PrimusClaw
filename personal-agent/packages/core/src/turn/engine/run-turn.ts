// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One Claw turn on behalf of one user: submit, follow the stream, show progress, answer. The turn always leaves the user a
 * message. One that went wrong (an error, a lost connection, a stop, a tool the user denied) also gets the "Report a
 * problem" view; one that went well gets thumbs under its answer instead. A group chat runs the same turn as a 1:1 chat.
 */

import { deepLink } from "../answer-parts.js";
import { pyStrip } from "../../text/python-str.js";
import type { LiveStream } from "../ports.js";
import { StatusMessage } from "../progress/status-message.js";
import { detach, Task } from "../task.js";
import { LOST_CONNECTION, QUEUED_NOTICE, QUEUED_NOTICE_ZH, SUGGESTED_REPLIES } from "../text.js";
import { TurnState } from "../turn-state.js";
import { ClawError, ClawUnreachable, errorKind, splitErrorTail, withhold } from "../upstream.js";
import { consume, noteRunning, StreamKeptDropping } from "./consume.js";
import { langOf, type TurnContext } from "./context.js";
import { offerChanges, offerDeliveries, offerReport, offerThumbs } from "./extras.js";
import { rerunOnFallback } from "./fallback.js";
import { clawFailure, endingParts, resultLead, stillRunningText, TURN_DEADLINE_SECONDS } from "./outcome.js";
import { submit } from "./submit.js";

/** Claw's 403 to a session made as someone else once it has review items. */
export const ACTING_AS_MUST_BE_SELF = "acting_as_must_be_self";

/** The chat stopped following the turn after TURN_DEADLINE_SECONDS. */
export class DeadlineExpired extends Error {
  constructor() {
    super("the turn's deadline passed");
    this.name = "DeadlineExpired";
  }
}

/** What the caller decides while the turn runs. */
export interface TurnControls {
  /** Records the session the turn runs in. */
  readonly onSession: (sessionId: string) => void;
  /** A stop was asked for (/stop, an item's Stop). */
  readonly stopRequested: () => boolean;
  /** The user denied a tool in this turn. */
  readonly toolDenied?: () => boolean;
  /** Claw confirmed the stop: the turn is said as stopped only. */
  readonly stopConfirmed?: () => boolean;
  /** The turn is cancelled: no live edit is sent after it, and the run's record is still kept. */
  readonly signal?: AbortSignal;
}

/**
 * The live stream this turn is shown by, or undefined: the progress message. A review keeps its progress message (its
 * acknowledgement and result are shown at the top of it, and it ends as that one message), and so does a turn that only
 * follows a session Claw made.
 */
function turnStream(ctx: TurnContext): LiveStream | undefined {
  const { lead, attach, actingAs } = ctx.request;
  if (lead || ctx.hooks.onGithubResult || ctx.hooks.shapeAnswer || attach || actingAs) return undefined;
  return ctx.deps.surface.openStream(ctx.deps.clock);
}

/** The typing indicator is a courtesy: one that fails or is slow neither delays the status post nor fails the turn. */
async function typing(ctx: TurnContext): Promise<void> {
  try {
    await ctx.deps.surface.typing();
  } catch (err) {
    ctx.deps.log.warn("typing indicator failed; the turn goes on", { error: String(err) });
  }
}

class TurnRun {
  private sessionId: string | undefined;
  /** The message reached Claw: only then is "still running" something the worker knows. */
  private submitted = false;
  private expired = false;
  private state: TurnState | undefined;
  private readonly running = { called: false };

  constructor(
    private readonly ctx: TurnContext,
    private readonly controls: TurnControls,
    private readonly status: StatusMessage,
  ) {
    this.sessionId = ctx.record.sessionId;
  }

  private tell(what: "started" | "delivered" | "failed", messageId?: string): void {
    if (!this.ctx.hooks.onTurn || !this.sessionId) return;
    try {
      this.ctx.hooks.onTurn(this.sessionId, what, messageId ?? "");
    } catch (err) {
      this.ctx.deps.log.warn("recording the turn failed", { error: String(err) }); // losing the record only costs a duplicate card
    }
  }

  /** Submit and follow the turn until it ends, within TURN_DEADLINE_SECONDS; whether it went well. */
  async follow(): Promise<boolean> {
    const deadline = new AbortController();
    const timer = new Task(async (signal) => {
      await this.ctx.deps.clock.sleep(TURN_DEADLINE_SECONDS, signal);
      this.expired = true;
      deadline.abort(new DeadlineExpired());
    });
    const cancel = this.controls.signal;
    const signal = cancel ? AbortSignal.any([cancel, deadline.signal]) : deadline.signal;
    try {
      return await this.submitAndConsume(signal);
    } finally {
      timer.cancel();
    }
  }

  private async submitAndConsume(signal: AbortSignal): Promise<boolean> {
    const { ctx } = this;
    const [sessionId, messageId, behind] = await submit(ctx, signal);
    this.sessionId = sessionId;
    this.submitted = true;
    this.controls.onSession(sessionId);
    this.tell("started", messageId);
    const state = new TurnState(messageId, behind, ctx.request.attach ?? false, ctx.deps.refusals);
    state.writes = ctx.record.wrote; // (written as the events arrive: a stream that drops afterwards loses none of it)
    this.state = state;
    noteRunning(ctx, state, this.running);
    if (messageId === undefined && !ctx.request.attach) {
      await ctx.deps.surface.send({ kind: "text", text: langOf(ctx) === "zh" ? QUEUED_NOTICE_ZH : QUEUED_NOTICE });
    }
    return consume(ctx, { sessionId, state, status: this.status, running: this.running, signal });
  }

  /** The turn ended (well or not): the user gets its answer, or what to do about the model key it was refused for. */
  async answer(firstOk: boolean): Promise<void> {
    const { ctx } = this;
    const sessionId = this.sessionId ?? "";
    let state = this.state ?? new TurnState(undefined);
    let ok = firstOk;
    let stopped = this.controls.stopRequested();
    let lead = "";
    let fallbackFailed = false;
    const refusal = stopped ? "" : ctx.deps.refusals.refusalOf(state.answer, state.failed);
    if (refusal) {
      const rerun = await rerunOnFallback(ctx, sessionId, this.status, this.controls.onSession, this.running);
      if (rerun) {
        ({ state, ok } = rerun);
        this.state = state;
        stopped = this.controls.stopRequested();
        lead = ctx.deps.refusals.fallbackLine(ctx.request.publicBaseUrl, langOf(ctx), refusal);
        fallbackFailed = Boolean(state.failed);
        if (fallbackFailed && !stopped) ctx.deps.log.warn("the fallback model failed too; the user is told to upload the key");
      }
    }
    if (!stopped && (fallbackFailed || ctx.deps.refusals.isRefusal(state.answer, state.failed))) {
      await this.status.finish([ctx.deps.refusals.guidance(ctx.request.publicBaseUrl, langOf(ctx), refusal)], { rich: true });
      this.tell("failed");
      return;
    }
    await this.deliver(state, ok, stopped, lead);
  }

  /** The answer with its failure cut off and withheld; whether the turn still counts as ok. */
  private cutFailure(state: TurnState, ok: boolean): readonly [string, boolean] {
    if (ok && !state.failed) return [state.answer, ok];
    const [answer, error] = splitErrorTail(state.answer);
    if (error || !ok) {
      const ref = withhold("turn_failed", error, { session: this.sessionId, message: state.messageId });
      this.ctx.deps.log.info("the user is told the task failed", { ref });
    }
    return [answer, error ? false : ok]; // (told as the failure it is: no thumbs, the Report a problem card)
  }

  private async deliver(state: TurnState, firstOk: boolean, stopped: boolean, lead: string): Promise<void> {
    const { ctx } = this;
    const sessionId = this.sessionId ?? "";
    const link = deepLink(ctx.request.publicBaseUrl, sessionId);
    const [answer, ok] = this.cutFailure(state, firstOk);
    const record = ctx.record;
    record.finalAnswer = answer;
    record.ranModel = state.routedModel || (lead ? (ctx.request.fallbackModel ?? "") : record.sessionModel);
    record.prSummary = state.prSummary || record.prSummary;
    const shape = ctx.hooks.shapeAnswer;
    const shown =
      shape && (answer || state.results.length)
        ? shape(answer, link, record.ranModel, [...state.results], state.comments, record.prSummary)
        : answer;
    const confirmed = stopped && (this.controls.stopConfirmed?.() ?? false);
    const parts = endingParts(ctx, { answer, shown, link, ok, stopped, confirmed, lead });
    const thumbs = ok && !stopped; // thumbs only under a final answer
    // (suggested replies: in a 1:1 chat, under an answer that went well, never under a review's one message)
    const replies = thumbs && !ctx.request.group && !shape && ctx.deps.style.suggestedReplies ? SUGGESTED_REPLIES[langOf(ctx)] : undefined;
    await this.status.finish(parts, {
      rich: true,
      feedback: thumbs && !ctx.request.ownThumbs,
      mention: ctx.request.mention,
      ai: Boolean(pyStrip(answer)),
      replies,
    });
    // (recorded as soon as the answer is in the chat: Claw's run.completed of this run is already on its way, and waits for it)
    this.tell(ok && state.answer ? "delivered" : "failed", state.messageId);
    await this.extras(state, sessionId, ok, stopped, thumbs);
  }

  private async extras(state: TurnState, sessionId: string, ok: boolean, stopped: boolean, thumbs: boolean): Promise<void> {
    const { ctx } = this;
    if (state.deliveries.length) await offerDeliveries(ctx, sessionId, state.deliveries); // whatever the end, a file is the user's
    if (thumbs && ctx.request.ownThumbs) await offerThumbs(ctx);
    if (!ok || stopped || (this.controls.toolDenied?.() ?? false)) await offerReport(ctx);
    // detached: the turn is over for the chat, whatever the sandbox takes to answer
    if (thumbs && ctx.request.showChanges) detach(() => offerChanges(ctx, sessionId));
  }

  /** The turn broke off: what the chat is told depends on why. Anything else (a cancel, a crash) is re-thrown. */
  async failed(err: unknown): Promise<void> {
    if (err instanceof ClawError) {
      await this.clawRefused(err);
    } else if (err instanceof DeadlineExpired || err instanceof StreamKeptDropping || err instanceof ClawUnreachable) {
      await this.lost();
    } else {
      this.status.close(true); // no live edit may be sent after the turn is over
      this.tell("failed"); // cancelled (/stop) or crashed: the run's card is still wanted
      throw err;
    }
  }

  private async clawRefused(err: ClawError): Promise<void> {
    const { ctx } = this;
    if (!this.submitted && err.status === 403 && err.code === ACTING_AS_MUST_BE_SELF && (await this.movedToItem())) {
      await this.status.finish([]); // (the progress message goes: what came of the review was said by `asItem`)
      return;
    }
    this.tell("failed");
    const review = Boolean(ctx.request.actingAs);
    ctx.record.refusal = review && err.status === 401 ? err : undefined;
    await this.status.finish([resultLead(ctx, this.state) + clawFailure(err, review)]);
    await offerReport(ctx);
  }

  /**
   * The session that acts as someone else was refused by a Claw that has review items: the review is asked for once more
   * as that person's item. False: the turn says its failure.
   */
  private async movedToItem(): Promise<boolean> {
    const { ctx } = this;
    const asItem = ctx.hooks.asItem;
    if (!asItem) return false;
    try {
      ctx.record.moved = await asItem();
    } catch (err) {
      ctx.deps.log.warn("asking for the review as the reviewer's item after the session was refused failed", { error: errorKind(err) });
      ctx.record.moved = false;
    }
    return ctx.record.moved;
  }

  /** The stream kept dropping, Claw was not reached, or the deadline passed. The run's own notification is still wanted. */
  private async lost(): Promise<void> {
    const { ctx } = this;
    this.tell("failed");
    const link = this.sessionId ? `\n\n[Open the session](${deepLink(ctx.request.publicBaseUrl, this.sessionId)})` : "";
    const lead = resultLead(ctx, this.state);
    if (this.submitted && this.expired) {
      // Not a lost connection and not a failure: say so, and promise a push only when Claw will send one
      await this.status.finish([lead + stillRunningText(ctx) + link]);
      return;
    }
    await this.status.finish([lead + LOST_CONNECTION + link]);
    await offerReport(ctx);
  }
}

/** Runs the turn and always leaves the user a message; `controls.onSession` records the session id. */
export async function runTurn(ctx: TurnContext, controls: TurnControls): Promise<void> {
  const stream = turnStream(ctx);
  if (!stream) detach(() => typing(ctx)); // (a stream shows its own status at once: no bare typing indicator before it)
  const status = new StatusMessage(ctx.deps.surface, {
    clock: ctx.deps.clock,
    log: ctx.deps.log,
    lang: langOf(ctx),
    lead: ctx.request.lead ?? "",
    stream,
    group: ctx.request.group ?? false,
    streamText: ctx.deps.style.streamText && !ctx.request.group,
  });
  status.begin();
  const run = new TurnRun(ctx, controls, status);
  try {
    await run.answer(await run.follow());
  } catch (err) {
    await run.failed(err);
  }
}
