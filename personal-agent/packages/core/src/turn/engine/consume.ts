// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Reading a turn's stream until it ends: progress, approvals and questions, and reconnects. */

import { errorName } from "../../errors.js";
import type { Envelope } from "../../ports/surface.js";
import { isObject, type JsonObject, textOf, truthy } from "../json.js";
import type { StatusMessage } from "../progress/status-message.js";
import type { Step } from "../step.js";
import type { TurnState } from "../turn-state.js";
import { ClawError, errorKind } from "../../claw/errors.js";
import type { SseEvent } from "../../claw/model.js";
import { pickLang } from "../../language/detect.js";
import { HISTORY_COMPLETE_EVENT as HISTORY_COMPLETE } from "../../protocol.js";
import { isClawOrNetwork } from "./claw-errors.js";
import { credential, type TurnContext } from "./context.js";

export const STREAM_ATTEMPTS = 4;
/** A wait longer than this in a request is not believed. */
export const MAX_APPROVAL_WAIT_SECONDS = 24 * 3600;
/** The tool whose call waits for the answer to a question card (Brain's userQuestion event). */
export const QUESTION_TOOL = "ask_user_question";

/** The stream dropped STREAM_ATTEMPTS times before the turn ended. */
export class StreamKeptDropping extends Error {
  constructor() {
    super("stream kept dropping");
    this.name = "StreamKeptDropping";
  }
}

/** The wait Brain announces in a permissionRequest (`timeout_ms`) in seconds; undefined for anything not a sane number. */
export function waitSeconds(milliseconds: unknown): number | undefined {
  return typeof milliseconds === "number" && milliseconds > 0
    ? Math.min(milliseconds / 1000, MAX_APPROVAL_WAIT_SECONDS)
    : undefined;
}

export function noteRunning(ctx: TurnContext, state: TurnState, once: { called: boolean }): void {
  if (ctx.hooks.onRunning && state.messageId !== undefined && !once.called) {
    once.called = true;
    ctx.hooks.onRunning();
  }
}

/** A review's result, shown at the top of the progress message as it arrives (best effort: it never fails the turn). */
function showResults(ctx: TurnContext, status: StatusMessage<Step>, state: TurnState, told: number): number {
  const shown = ctx.hooks.onGithubResult;
  if (!shown || state.results.length <= told) return told;
  for (const outcome of state.results.slice(told)) {
    try {
      const line = shown(outcome, state.routedModel || ctx.record.sessionModel);
      if (line) status.headline(line);
    } catch (err) {
      ctx.deps.log.warn("the review's result line could not be shown; the answer follows as usual", {
        error: errorName(err),
      });
    }
  }
  return state.results.length;
}

interface Asked {
  readonly tool: string;
  readonly toolUseId: string;
  readonly request: JsonObject;
  readonly envelope: Envelope;
}

function approvalOf(ctx: TurnContext, sessionId: string, approval: JsonObject): Asked {
  const tool = textOf(approval["tool"]) || "tool";
  const toolUseId = textOf(approval["tool_use_id"]);
  const card = ctx.deps.cards.approval({
    tool,
    input: approval["input"],
    sessionId,
    toolUseId,
    group: ctx.request.group ?? false,
    ownerName: ctx.request.ownerName ?? "",
    event: approval,
    lang: ctx.request.lang ?? pickLang(approval["summary"], approval["intent"], ctx.request.text),
  });
  return { tool, toolUseId, request: approval, envelope: ctx.deps.surface.outgoing(card) };
}

/** A question of the agent: it waits for the answer the way a held call waits for a decision. */
function questionOf(ctx: TurnContext, sessionId: string, question: JsonObject): Asked {
  const toolUseId = textOf(question["actionId"]);
  const card = ctx.deps.cards.question({
    questions: question["questions"],
    sessionId,
    toolUseId,
    group: ctx.request.group ?? false,
    ownerName: ctx.request.ownerName ?? "",
  });
  const envelope = ctx.deps.surface.outgoing(card);
  return { tool: QUESTION_TOOL, toolUseId, request: question, envelope };
}

/**
 * Shows an approval or question card. It is recorded BEFORE it is shown, so the owner is known when it is clicked and the
 * notification for the same approval finds it and sends nothing; recorded WITH the card, so a crash between the record and
 * the send does not lose it. A request with no id cannot be told from another: shown.
 */
async function ask(ctx: TurnContext, sessionId: string, step: Step): Promise<void> {
  const asked =
    isObject(step.approval) && truthy(step.approval)
      ? approvalOf(ctx, sessionId, step.approval)
      : questionOf(ctx, sessionId, step.question ?? {});
  const { tool, toolUseId, request, envelope } = asked;
  const hooks = ctx.hooks;
  if (
    toolUseId &&
    hooks.onApproval?.(sessionId, toolUseId, tool, waitSeconds(request["timeout_ms"]), envelope) === false
  )
    return;
  try {
    await ctx.deps.surface.deliver(envelope);
  } catch (err) {
    if (toolUseId) hooks.onApprovalUnsent?.(sessionId, toolUseId); // nobody saw it: a replay or the notification may
    throw err;
  }
  if (toolUseId) hooks.onApprovalSent?.(sessionId, toolUseId);
}

/** Where a connection reads from, and what the history marker said about this Claw. */
interface Cursor {
  lastId: string | undefined;
  readonly start: string | undefined;
  /** This Claw compares `after` as text: never resume with it. */
  legacy: boolean;
  /** A marker has said which Claw this is. */
  known: boolean;
}

export interface ConsumeArgs {
  readonly sessionId: string;
  readonly state: TurnState;
  readonly status: StatusMessage<Step>;
  readonly running: { called: boolean };
  readonly signal?: AbortSignal | undefined;
}

type Read = "finished-ok" | "finished-error" | "again" | "dropped";

/** One connection: true/false when the turn ended (ok or not), "again" to reconnect at once, "dropped" when it ended. */
async function readOnce(ctx: TurnContext, args: ConsumeArgs, cursor: Cursor, told: { n: number }): Promise<Read> {
  const { sessionId, state, status, signal } = args;
  const after = cursor.legacy ? undefined : cursor.lastId || cursor.start;
  const events: AsyncIterable<SseEvent> = ctx.deps.claw.stream(await credential(ctx), sessionId, after, signal);
  for await (const event of events) {
    signal?.throwIfAborted();
    if (event.name === HISTORY_COMPLETE && !cursor.known) {
      cursor.known = true;
      cursor.legacy = !("has_more" in event.data);
      if (cursor.legacy && after !== undefined) {
        ctx.deps.log.info(
          "Claw compares the stream's `after` as text: the turn is read from the session's history instead",
        );
        return "again";
      }
    }
    cursor.lastId = event.id || cursor.lastId;
    const step = state.feed(event);
    noteRunning(ctx, state, args.running);
    told.n = showResults(ctx, status, state, told.n);
    const read = await take(ctx, args, step);
    if (read) return read;
  }
  return "dropped";
}

/** One event's step: shown, asked about, or the end of the turn. */
async function take(ctx: TurnContext, args: ConsumeArgs, step: Step): Promise<Read | undefined> {
  args.status.note(step);
  args.status.progress(step);
  if (truthy(step.approval) || truthy(step.question)) {
    await ask(ctx, args.sessionId, step);
    return undefined;
  }
  if (!step.finished) return undefined;
  return step.error ? "finished-error" : "finished-ok";
}

/**
 * Read the stream until the turn ends; reconnects from the last event if it drops. A turn whose message Claw took at once
 * starts after the newest event stored before it was sent, so the history it replays is this turn's. A queued one reads
 * the history Claw sends without `after` (the session's tail): it is told from older turns by coming after the one in
 * front of it. A Claw whose history marker has no `has_more` compares `after` as text: seen on a connection that had an
 * `after`, the stream is read once more from where Claw starts it, and every reconnect starts there too.
 */
export async function consume(ctx: TurnContext, args: ConsumeArgs): Promise<boolean> {
  const cursor: Cursor = {
    lastId: undefined,
    start: args.state.messageId !== undefined ? ctx.record.streamAfter : undefined,
    legacy: false,
    known: false,
  };
  const told = { n: args.state.results.length };
  let attempts = 0;
  while (attempts < STREAM_ATTEMPTS) {
    attempts += 1;
    try {
      const read = await readOnce(ctx, args, cursor, told);
      if (read === "finished-ok") return true;
      if (read === "finished-error") return false;
      if (read === "again") attempts -= 1; // (not a drop: the stream is read again at once)
    } catch (err) {
      if (err instanceof ClawError && [401, 403, 404].includes(err.status)) throw err;
      if (!isClawOrNetwork(err)) throw err;
      ctx.deps.log.warn("claw stream dropped", { error: errorKind(err) });
    }
  }
  throw new StreamKeptDropping();
}
