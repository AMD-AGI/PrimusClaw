// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What keeps a router turn quick, on top of its cut (`role-profile.ts`).
 *
 * Measured on the live router (2026-11-06): the lookups a turn makes take tenths of a second, and nearly all the rest is the model
 * writing, most of it thinking (about 400 tokens a step at some 150 a second, two or three steps a turn). So a router turn can ask for
 * little thinking (`CLAW_ASSISTANT_ROUTER_EFFORT=low`, unless the session chose an effort of its own), and its `say` is published
 * while the model writes it (`CLAW_ASSISTANT_STREAM_SAY`, `ExecuteRequest.stream_tool_text`), so a channel that follows the turn
 * can show the first words before the step that says them has ended. The message itself is still the `say` that runs when the step
 * is whole; what streams is a preview of it.
 */
import pino from "pino";
import { CLAW_ASSISTANT_ROUTER_EFFORT, CLAW_ASSISTANT_STREAM_SAY, CLAW_ASSISTANT_STREAM_TEXT, CLAW_ASSISTANT_STREAM_TEXT_USERS } from "../config.js";
import { publishEvent } from "../events/store.js";
import { TOOL_NAME_PREFIX } from "./prompts.js";

const logger = pino({ name: "assistant-router-speed" });

/** The router's `say`, as Brain names it: the one tool whose text is streamed. */
export const STREAMED_SAY_TOOL = `${TOOL_NAME_PREFIX}say`;

/**
 * Who has a router turn's own text streamed as its say's (`CLAW_ASSISTANT_STREAM_TEXT`, `_USERS`). A turn that answers the person and ends
 * in plain text is said for it by the server once it has ended (`deliverUnsaidAnswer`, about 0.3 s after the model wrote it); a say is
 * shown while it is written. Measured 2026-11-08 on the last 24 h: one router turn in ten ended so, and its first reply came at p50 3.5 s
 * (the system's "on it" line) against 2.9 s for a turn that said. With this on, Brain publishes the text as the say's preview
 * (`stream_text_as`), and takes it back if a tool call follows it.
 */
export interface StreamTextSettings { all: boolean; users: ReadonlySet<string> }

export const streamTextSettings: StreamTextSettings = { all: CLAW_ASSISTANT_STREAM_TEXT, users: CLAW_ASSISTANT_STREAM_TEXT_USERS };

/** Whether this user's router turns have their own text streamed. */
export function streamTextOn(userId: string | null | undefined, settings: StreamTextSettings = streamTextSettings): boolean {
  return settings.all || (!!userId && settings.users.has(userId));
}

/**
 * `streamText`: the turn answers the person (not a worker's report, whose text is not for them) and the user has it (`streamTextOn`).
 * The text streams as the say's, so only with the say streamed.
 */
export function applyRouterTurnSpeed(
  task: Record<string, unknown>,
  settings: { effort: string | null; streamSay: boolean } = { effort: CLAW_ASSISTANT_ROUTER_EFFORT, streamSay: CLAW_ASSISTANT_STREAM_SAY },
  streamText = false,
): void {
  if (settings.effort && !task.effort) task.effort = settings.effort;
  if (settings.streamSay) task.stream_tool_text = [STREAMED_SAY_TOOL];
  else delete task.stream_tool_text;
  if (settings.streamSay && streamText) task.stream_text_as = STREAMED_SAY_TOOL;
  else delete task.stream_text_as;
}

/**
 * The event that tells whoever follows a router turn live that the `say` text it streamed for that turn (`toolTextDelta`) is not
 * going to be said: `{type: "toolTextVoid", tool, message_id, reason}`. Published when a say is refused (what was streamed of it
 * never reaches the person) and when the turn hands a review to the person's channel (any later say of the turn is refused). A
 * channel that showed the words takes them back instead of keeping them as a message; the session stream forwards no further
 * `toolTextDelta` of that turn after it (`routes/events.ts`). Like the deltas it is live only: never stored (`events/consumer.ts`).
 */
export const TOOL_TEXT_VOID_EVENT = "toolTextVoid";

/** Best effort: a void that cannot be published leaves the channel to the say's own refusal on the turn's stream. */
export async function voidStreamedSay(
  sessionId: string, messageId: string | undefined, reason: string,
  publish: (sessionId: string, event: Record<string, unknown>) => Promise<void> = publishEvent,
): Promise<void> {
  if (!messageId) return;
  try {
    await publish(sessionId, { type: TOOL_TEXT_VOID_EVENT, tool: STREAMED_SAY_TOOL, message_id: messageId, reason });
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, sessionId, reason }, "assistant.stream_void_publish_failed");
  }
}
