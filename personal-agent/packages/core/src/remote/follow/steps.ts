// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { ToolUpdate } from "../../remote-view/index.js";

/** Steps remembered as running (a connector that never ends its steps cannot grow this). */
export const STEPS_KEPT = 200;

/**
 * Fold one tool event into the steps that have begun and not ended: the follower's, and the one made of a session's events when
 * a chat attaches (`tail.ts`), so that both say the same of the same events. The value says whether this reader read the step's
 * beginning (a step running when the chat attached holds no text back).
 */
export function noteStep(steps: Map<string, boolean>, tool: ToolUpdate): void {
  const { id: callId, status } = tool;
  if (status === "completed" || status === "failed") {
    steps.delete(callId);
    return;
  }
  // (an update that says no status, such as more output of a step, is no beginning: one after the end must not reopen it)
  if (!status) return;
  steps.set(callId, true); // (a step begun again keeps its place: the oldest beginning is what goes first)
  while (steps.size > STEPS_KEPT) {
    const oldest = steps.keys().next();
    if (oldest.done === true) break;
    steps.delete(oldest.value);
  }
}
