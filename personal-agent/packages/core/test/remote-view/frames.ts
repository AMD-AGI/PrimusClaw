// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { type PublicErrors, type SseEvent } from "../../src/remote-view/events.js";

/** An event as the worker's SSE reader hands it over: the frame's own data is {type, session_id, seq, ts, data}. */
export function frame(name: string, data: Record<string, unknown> = {}, eventId = "1"): SseEvent {
  return { id: eventId, name, data: { type: name, session_id: "s", seq: 1, ts: 1, data } };
}

/** An ACP `session/update` frame. */
export function acp(name: string, eventId = "1", update: Record<string, unknown> = {}): SseEvent {
  return frame(name, { sessionId: "a", update: { sessionUpdate: name, ...update } }, eventId);
}

/** Public errors that keep every reason (the classifier is tested with its own module) and withhold under a fixed ref. */
export const PLAIN_ERRORS: PublicErrors = {
  publicReason: (reason) => reason,
  withhold: () => "ref-1",
};
