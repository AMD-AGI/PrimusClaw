// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { SuggestedReply } from "../../ports/surface.js";
import { type RemoteStep } from "../events.js";

/** How a remote turn is shown while it runs and when it ends: in the chat (a stream, or a progress message), or in the session card. */
export interface TurnDisplay {
  /** A line of ours after the answer (how the turn ended): not the agent's words. */
  tail: string;
  begin(): void;
  progress(step: RemoteStep): void;
  /** Nothing more is shown (`hard`: the turn was cancelled). */
  close(hard?: boolean): void;
  /** The answer: `parts` in order, the suggested `replies` under the last. */
  finish(parts: readonly string[], options: FinishWith): Promise<void>;
}

export interface FinishWith {
  /** What the agent wrote (the AI label). */
  readonly ai: boolean;
  readonly replies?: readonly SuggestedReply[];
}
