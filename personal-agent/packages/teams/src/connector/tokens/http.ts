// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** One token endpoint request through the injected fetch, bounded by its own timeout and the caller's signal. */
import { errorName, type Clock } from "@primusclaw/personal-agent";
import { TokenError } from "../errors.js";
import { startTimer } from "../timer.js";

export interface TokenHttp {
  readonly fetch: typeof fetch;
  readonly clock: Clock;
}

/** The status and the body text of one request; a network failure, a timeout or an abort is a transient TokenError. */
export async function tokenRequest(
  http: TokenHttp,
  service: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ status: number; text: string }> {
  const timer = startTimer(http.clock, timeoutMs, `${service} timed out`, signal);
  try {
    const response = await http.fetch(url, { ...init, redirect: "manual", signal: timer.signal });
    return { status: response.status, text: await response.text() };
  } catch (error) {
    throw new TokenError(`${service} unreachable (${errorName(error)})`, true);
  } finally {
    timer.dispose();
  }
}
