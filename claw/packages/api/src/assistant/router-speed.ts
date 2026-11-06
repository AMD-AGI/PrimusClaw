// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What keeps a router turn quick, on top of its cut (`role-profile.ts`).
 *
 * Measured on the live router (2026-11-06): the lookups a turn makes take tenths of a second, and nearly all the rest is the model
 * writing, most of it thinking (about 400 tokens a step at some 150 a second, two or three steps a turn). So a router turn asks for
 * little thinking (`CLAW_ASSISTANT_ROUTER_EFFORT`, low unless the session chose an effort of its own), and its `say` is published
 * while the model writes it (`CLAW_ASSISTANT_STREAM_SAY`, `ExecuteRequest.stream_tool_text`), so a channel that follows the turn
 * can show the first words before the step that says them has ended. The message itself is still the `say` that runs when the step
 * is whole; what streams is a preview of it.
 */
import { CLAW_ASSISTANT_ROUTER_EFFORT, CLAW_ASSISTANT_STREAM_SAY } from "../config.js";
import { TOOL_NAME_PREFIX } from "./prompts.js";

/** The router's `say`, as Brain names it: the one tool whose text is streamed. */
export const STREAMED_SAY_TOOL = `${TOOL_NAME_PREFIX}say`;

export function applyRouterTurnSpeed(
  task: Record<string, unknown>,
  settings: { effort: string | null; streamSay: boolean } = { effort: CLAW_ASSISTANT_ROUTER_EFFORT, streamSay: CLAW_ASSISTANT_STREAM_SAY },
): void {
  if (settings.effort && !task.effort) task.effort = settings.effort;
  if (settings.streamSay) task.stream_tool_text = [STREAMED_SAY_TOOL];
  else delete task.stream_tool_text;
}
