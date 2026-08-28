// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Is the Hands MCP server inside a sandbox answering?
 *
 * Separate from the container probe on purpose: they answer different
 * questions, and conflating them is what made a crashed Hands process
 * indistinguishable from a healthy one. `exec` reaches the container through
 * the control plane and says nothing about the process on the MCP port, while
 * this reaches that process directly and says nothing about whether the
 * container would survive being asked anything else.
 *
 * Three call sites had each grown their own copy of this fetch -- both of
 * ensure-hands' reuse gates and the reaper's sweep -- with their own idea of
 * what a non-2xx response meant, and the recovery path would have been a
 * fourth. One definition instead, because the gate that decides a sandbox is
 * reusable and the recovery that decides it is repairable must not be able to
 * disagree about whether Hands is answering.
 */
import { handsEndpoint } from "../clients/hands.js";

export interface HandsHealthResult {
  /** True only when Hands answered its health route with a 2xx. */
  ok: boolean;
  /**
   * Why, in the words a log line wants. Distinguishes the two ways of not
   * being ok -- a server that answered with a refusal, and nothing listening
   * at all -- which point at different repairs even though both mean the
   * sandbox cannot be used as it stands.
   */
  detail: string;
}

/** Ask Hands' health route, giving up after `timeoutMs`. Never throws. */
export async function checkHandsHealth(
  handsMcpUrl: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HandsHealthResult> {
  if (!handsMcpUrl) return { ok: false, detail: "no_url" };
  try {
    const resp = await fetch(handsEndpoint(handsMcpUrl, "/health"), {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
    return resp.ok
      ? { ok: true, detail: "ok" }
      : { ok: false, detail: `http_${resp.status}` };
  } catch (err) {
    return { ok: false, detail: (err as Error)?.message?.slice(0, 120) || "unreachable" };
  }
}
