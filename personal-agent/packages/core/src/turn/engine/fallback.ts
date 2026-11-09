// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** A turn refused for want of the user's model key, run once more on a model that needs none. */

import type { StatusMessage } from "../progress/status-message.js";
import type { Step } from "../step.js";
import { TurnState } from "../turn-state.js";
import { ClawUnreachable } from "../../claw/errors.js";
import { isClawOrNetwork, statusOrKind } from "./claw-errors.js";
import { consume } from "./consume.js";
import { credential, messageOf, type TurnContext } from "./context.js";
import { sendOptions, turnInFront, turnStart } from "./submit.js";

export interface Rerun {
  readonly state: TurnState;
  readonly ok: boolean;
}

/** Nothing to run it on: no fallback configured, no model to put the session back on, or a session that is Claw's. */
function noFallback(ctx: TurnContext): boolean {
  const { fallbackModel = "", model = "", attach } = ctx.request;
  return (
    !fallbackModel || !model || fallbackModel === model || fallbackModel === ctx.record.sessionModel || Boolean(attach)
  );
}

/** Moves the session to the fallback model; false when Claw would not (the user is then told to upload the key). */
async function moveToFallback(
  ctx: TurnContext,
  sessionId: string,
  onSession: (sessionId: string) => void,
): Promise<boolean> {
  const fallback = ctx.request.fallbackModel ?? "";
  try {
    await ctx.deps.claw.setModel(await credential(ctx), sessionId, fallback);
  } catch (err) {
    if (!isClawOrNetwork(err)) throw err;
    ctx.deps.log.warn("could not move the session to the fallback model; the user is told to upload the key", {
      session: sessionId,
      error: statusOrKind(err),
    });
    if (err instanceof ClawUnreachable && err.kind !== "connect") {
      // No answer came, and the request may have: the session may be on the fallback now. The record says so, so the
      // next message pins the worker's model again, which is no harm if the move never happened. (A refused
      // connection is a request that was never made: nothing is recorded.)
      ctx.record.sessionModel = fallback;
      onSession(sessionId);
    }
    return false;
  }
  ctx.record.sessionModel = fallback;
  return true;
}

/** Puts the session back on the worker's model; on failure the record keeps the fallback, so the next message pins it. */
async function moveBack(ctx: TurnContext, sessionId: string, onSession: (sessionId: string) => void): Promise<void> {
  const model = ctx.request.model ?? "";
  try {
    await ctx.deps.claw.setModel(await credential(ctx), sessionId, model);
    ctx.record.sessionModel = model;
  } catch (err) {
    if (!isClawOrNetwork(err)) throw err;
    ctx.deps.log.warn(
      "could not put the session back on its model after the fallback turn; the next message pins it again",
      {
        session: sessionId,
        error: statusOrKind(err),
      },
    );
  }
  onSession(sessionId); // records the model the session really has now
}

/**
 * Runs the turn once more on the fallback model: the session is pinned to it for this one turn and put back on the
 * worker's model afterwards. Undefined when there is nothing to run it on, or Claw would not move the session: the caller
 * then tells the user to upload the key.
 */
export async function rerunOnFallback(
  ctx: TurnContext,
  sessionId: string,
  status: StatusMessage<Step>,
  onSession: (sessionId: string) => void,
  running: { called: boolean },
): Promise<Rerun | undefined> {
  if (noFallback(ctx) || !(await moveToFallback(ctx, sessionId, onSession))) return undefined;
  try {
    ctx.record.streamAfter = await turnStart(ctx, sessionId);
    const behind = await turnInFront(ctx, sessionId);
    const messageId = await ctx.deps.claw.sendMessage(
      await credential(ctx),
      sessionId,
      messageOf(ctx),
      sendOptions(ctx),
    );
    const state = new TurnState(messageId ?? undefined, behind, false, ctx.deps.refusals);
    state.writes = ctx.record.wrote; // (one list for the turn: what the first run wrote is not forgotten by the second)
    const ok = await consume(ctx, { sessionId, state, status, running });
    return { state, ok };
  } finally {
    await moveBack(ctx, sessionId, onSession);
  }
}
