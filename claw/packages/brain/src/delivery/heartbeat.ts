// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { DELIVERY_HEARTBEAT_MS } from "../config.js";

/**
 * Keep a delivery from being redelivered while this pod still has it.
 *
 * `working()` restarts the server's ack timer, so the interval has to be well
 * inside ack_wait -- ten seconds against two minutes leaves eleven missed
 * beats before the server concludes the pod is gone, which is the conclusion
 * we want it to reach if the pod really is gone.
 *
 * Deliberately spans more than execution. A message waiting for a slot is
 * being worked on in every sense that matters here: this pod intends to run
 * it and will, and a second copy delivered elsewhere would race the first for
 * the same lock.
 */
export function keepDeliveryAlive(
  msg: { working(): void },
  everyMs: number = DELIVERY_HEARTBEAT_MS,
): () => void {
  const timer = setInterval(() => {
    try { msg.working(); } catch { /* settled already; nothing to extend */ }
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
