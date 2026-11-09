// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Getting the user's message to Claw: the session it goes to, its files, the model, and where its stream starts. */

import { filesNote, failedFilesLine, uploadFolder } from "../files.js";
import { textMessage, type CreateSessionOptions, type SendOptions } from "../ports.js";
import { unlessAborted } from "../task.js";
import { ClawError, errorKind } from "../upstream.js";
import { isClawFailure, isClawOrNetwork, statusOrKind } from "./claw-errors.js";
import { credential, messageOf, type TurnContext } from "./context.js";

/** (session, model) pairs whose refusal has been logged: once each. */
const MODEL_REFUSALS = new Set<string>();

/**
 * The id of the newest event the session holds, read just before the message is sent: the turn's events come after it, so
 * its stream starts there and not with the session's history. Best effort: undefined starts where Claw starts it.
 */
export async function turnStart(ctx: TurnContext, sessionId: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    return await unlessAborted(ctx.deps.claw.lastEventId(await credential(ctx), sessionId), signal);
  } catch (err) {
    if (!isClawFailure(err)) throw err;
    ctx.deps.log.info("the turn's stream starts where Claw starts it: the session's newest event was not read", {
      error: errorKind(err),
    });
    return undefined;
  }
}

/**
 * The turn Claw is running on the session just before this message is sent, if any: a message sent now is queued behind
 * it, and the queued turn is told from older ones by starting after it. Best effort.
 */
export async function turnInFront(ctx: TurnContext, sessionId: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const [running, gate] = await unlessAborted(ctx.deps.claw.sessionTurn(await credential(ctx), sessionId), signal);
    return running ? gate : undefined;
  } catch (err) {
    if (!isClawFailure(err)) throw err;
    return undefined;
  }
}

/**
 * The worker's model on a session that does not have it yet: one PATCH before the message goes out, then it is recorded.
 * It never fails the turn; nothing is recorded on failure, so the next message tries again; logged once per session/model.
 */
async function pinModel(ctx: TurnContext, sessionId: string, signal?: AbortSignal): Promise<void> {
  const model = ctx.request.model ?? "";
  if (!model || ctx.record.sessionModel === model) return;
  try {
    await unlessAborted(ctx.deps.claw.setSessionModel(await credential(ctx), sessionId, model), signal);
  } catch (err) {
    if (!isClawOrNetwork(err)) throw err;
    const seen = `${sessionId}\u0000${model}`;
    if (!MODEL_REFUSALS.has(seen)) {
      MODEL_REFUSALS.add(seen);
      ctx.deps.log.warn("could not set the model on the session; the chat goes on with the model it has", {
        session: sessionId,
        error: statusOrKind(err),
      });
    }
    return;
  }
  ctx.record.sessionModel = model;
}

/** The model key for the two calls that start a model turn (only when the turn has one). */
export function sendOptions(ctx: TurnContext): SendOptions {
  return {
    ...(ctx.request.modelKey ? { modelKey: ctx.request.modelKey } : {}),
    ...(ctx.request.actingAs ? { acting: true } : {}),
  };
}

function createOptions(ctx: TurnContext): CreateSessionOptions {
  const r = ctx.request;
  return {
    ...(r.repo ? { repo: r.repo } : {}),
    ...(r.actingAs ? { actingAs: r.actingAs } : {}),
    ...(r.reviewTarget ? { reviewTarget: r.reviewTarget } : {}),
    ...(r.group ? { shared: true } : {}), // the group reads the answer: none of the requester's memory in it
    ...(r.modelKey ? { modelKey: r.modelKey } : {}),
    ...(r.reviewModel ? { model: r.reviewModel } : {}),
    ...(r.reviewOnly ? { reviewOnly: true } : {}),
  };
}

type Failed = Array<readonly [string, string]>;

async function fetchOnce(ctx: TurnContext): Promise<Failed> {
  if (ctx.record.fetched !== undefined) return [];
  const files = ctx.request.files ?? [];
  if (!ctx.hooks.fetchFiles) {
    ctx.record.fetched = [];
    return files.map((f) => [f.name || "an image", "this worker does not take files"] as const);
  }
  const [fetched, failed] = await ctx.hooks.fetchFiles(files);
  ctx.record.fetched = fetched;
  return [...failed];
}

/** Uploads the fetched files to `sessionId` (made here when there is none, or when it was deleted); the session they went to. */
async function upload(ctx: TurnContext, sessionId: string | undefined, signal?: AbortSignal): Promise<readonly [string, string[], string[]]> {
  const fetched = ctx.record.fetched ?? [];
  const folder = uploadFolder(ctx.request.idempotencyKey);
  let target = sessionId;
  for (;;) {
    if (!target) {
      const options = { ...createOptions(ctx), withMessage: false };
      [target] = await unlessAborted(
        ctx.deps.claw.createSession(await credential(ctx), ctx.request.text || "Files", ctx.request.idempotencyKey, options),
        signal,
      );
      ctx.record.sessionModel = ctx.request.model ?? ""; // sent with the create
    }
    try {
      const [paths, refused] = await unlessAborted(ctx.deps.claw.uploadFiles(await credential(ctx), target, folder, fetched), signal);
      return [target, paths, refused];
    } catch (err) {
      if (err instanceof ClawError && err.status === 404 && target === sessionId) {
        target = undefined; // the chat's session was deleted: make a new one
        continue;
      }
      if (!isClawOrNetwork(err)) throw err;
      ctx.deps.log.warn("Claw did not take the files of a message; the message goes without them", { error: errorKind(err) });
      return [target, [], fetched.map((f) => f.name)];
    }
  }
}

/**
 * Fetches the files the user sent and puts them in `sessionId` before the message goes, so the agent finds them when it
 * reads the message. With no session, or when it was deleted, one is made without a message. A file that could not be
 * fetched or that Claw did not take is named to the user, and the message still goes. Returns the session.
 */
export async function putFiles(ctx: TurnContext, sessionId: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
  const failed = await fetchOnce(ctx);
  ctx.record.filesNote = "";
  let target = sessionId;
  if (ctx.record.fetched?.length) {
    const [session, paths, refused] = await upload(ctx, sessionId, signal);
    target = session;
    ctx.record.filesNote = filesNote(paths);
    failed.push(...refused.map((name) => [name, "Claw did not take it"] as const));
  }
  if (failed.length) {
    ctx.hooks.onFilesDropped?.(failed.length);
    await ctx.deps.surface.send(textMessage(failedFilesLine(failed)));
  }
  return target;
}

/** Sends the message to an existing session: (message id, turn in front). */
async function sendTo(ctx: TurnContext, sessionId: string, signal?: AbortSignal): Promise<readonly [string | undefined, string | undefined]> {
  await pinModel(ctx, sessionId, signal);
  ctx.record.streamAfter = await turnStart(ctx, sessionId, signal);
  const behind = await turnInFront(ctx, sessionId, signal);
  const sent = ctx.deps.claw.sendMessage(await credential(ctx), sessionId, messageOf(ctx), sendOptions(ctx));
  return [await unlessAborted(sent, signal), behind];
}

/** (session, message id, turn in front); the message id is undefined when Claw queued the message behind a running turn. */
export async function submit(ctx: TurnContext, signal?: AbortSignal): Promise<readonly [string, string | undefined, string | undefined]> {
  const existing = ctx.record.sessionId;
  if (existing && ctx.request.attach) return [existing, ctx.request.attachMessageId || undefined, undefined];
  const sessionId = ctx.request.files?.length ? await putFiles(ctx, existing, signal) : existing;
  if (sessionId) {
    try {
      const [messageId, behind] = await sendTo(ctx, sessionId, signal);
      return [sessionId, messageId, behind];
    } catch (err) {
      // 404: the session was deleted in the web console; start a new one
      if (!(err instanceof ClawError) || err.status !== 404 || sessionId !== existing) throw err;
    }
    ctx.record.streamAfter = undefined; // (that was a place in the session that is gone)
    if (ctx.record.fetched?.length) {
      // the files went to the session that is gone: they go to a new one, and the message after them
      const fresh = (await putFiles(ctx, undefined, signal)) ?? "";
      const sent = ctx.deps.claw.sendMessage(await credential(ctx), fresh, messageOf(ctx), sendOptions(ctx));
      return [fresh, await unlessAborted(sent, signal), undefined];
    }
  }
  const created = ctx.deps.claw.createSession(await credential(ctx), messageOf(ctx), ctx.request.idempotencyKey, createOptions(ctx));
  const [newSession, messageId] = await unlessAborted(created, signal);
  ctx.record.sessionModel = ctx.request.model ?? ""; // sent with the create (a review's model is `model` too)
  return [newSession, messageId, undefined];
}
