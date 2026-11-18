// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { SseEvent } from "../../src/claw/model.js";
import type { JsonObject } from "../../src/json.js";
import type { PublicErrors } from "../../src/public-error/public-errors.js";

/** An event as the worker's SSE reader hands it over: the frame's own data is {type, session_id, seq, ts, data}. */
export function frame(name: string, data: JsonObject = {}, eventId = "1"): SseEvent {
  return { id: eventId, name, data: { type: name, session_id: "s", seq: 1, ts: 1, data } };
}

/** An ACP `session/update` frame. */
export function acp(name: string, eventId = "1", update: JsonObject = {}): SseEvent {
  return frame(name, { sessionId: "a", update: { sessionUpdate: name, ...update } }, eventId);
}

/** Public errors that keep every reason (the classifier is tested with its own module) and withhold under a fixed ref. */
export const PLAIN_ERRORS: PublicErrors = {
  publicReason: (reason) => (typeof reason === "string" ? reason : ""),
  withhold: () => "ref-1",
};
