// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { JsonObject } from "./json.js";
import type { Todo } from "./plan.js";

/** What the runner does after one event. Every field is optional: an empty step changes nothing. */
export interface Step {
  /** The visible text of one main-agent model turn. */
  readonly narration?: string;
  /** (tool name, status): never the tool's input. */
  readonly tool?: readonly [name: string, status: string];
  /** Brain's id of the call: what pairs a tool's start with its end. */
  readonly actionId?: string;
  /** A shell step that runs a skill's script: the skill's plain name, nothing else of the call. */
  readonly skill?: string;
  /** Brain's setup, not an agent action; `tool` is set only when it failed. */
  readonly preparation?: boolean;
  /** The agent's whole list after a todo_write that worked (undefined: no news). */
  readonly todos?: readonly Todo[];
  /** A permission request to turn into a card. */
  readonly approval?: JsonObject;
  /** A question of the agent (userQuestion) to turn into a card. */
  readonly question?: JsonObject;
  /** The main agent's text so far in the model turn being written (text deltas). */
  readonly partial?: string;
  readonly finished?: boolean;
  readonly error?: boolean;
}

export const NOTHING: Step = Object.freeze({});
