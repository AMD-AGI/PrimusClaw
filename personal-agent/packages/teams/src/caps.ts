// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { SurfaceCaps } from "@primusclaw/personal-agent";

/**
 * How the worker reaches Teams (OUTBOUND_MODE): `direct` posts to the Bot Connector itself; `queue` hands envelopes to
 * the outbound queue, which a relay Function posts (send, reply and update only, and the new message's id comes back
 * as a late ack, if at all).
 */
export type OutboundMode = "direct" | "queue";

/**
 * What Teams can do in each mode. A stream needs each request answered with the stream's id at once (direct only); a
 * delete is not in the relay's contract (direct only). Cards, citations and suggested replies are in the activity
 * itself and go either way.
 */
export function teamsCaps(mode: OutboundMode): SurfaceCaps {
  const direct = mode === "direct";
  return {
    streaming: direct,
    messageIds: true,
    edit: true,
    delete: direct,
    views: true,
    citations: true,
    suggestions: true,
  };
}
