// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Brain -> API calls that may be repeated, and what is worth repeating them for.
 *
 * An API pod being replaced shows up here in three ways: the connection is
 * refused (the endpoint still lists a pod that has stopped listening), reset
 * (the pod closed a keep-alive socket under a request that was just being
 * sent), or answered 502/503/504 by whatever sits in front of it. None of the
 * three says anything about the request, and a moment later another replica
 * answers it. The calls that go through here are ones the API applies
 * idempotently -- a lease renewal, the running signal, `agent_done` -- so
 * sending one twice is harmless and failing one over a pod swap is not.
 *
 * A timeout is deliberately not in the set: it means the API (or its database)
 * is slow, not gone, and a second request would only queue behind the first.
 */
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const TRANSIENT_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOTCONN", "EHOSTUNREACH", "ENETUNREACH",
  "UND_ERR_SOCKET", "UND_ERR_CLOSED",
]);

export function isTransientHttpStatus(status: number): boolean {
  return TRANSIENT_STATUSES.has(status);
}

/** A fetch that failed because the connection did, rather than because it took too long. */
export function isTransientFetchError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    const x = e as { code?: unknown; message?: unknown; cause?: unknown; name?: unknown };
    if (x.name === "AbortError" || x.name === "TimeoutError") return false;
    if (typeof x.code === "string" && TRANSIENT_CODES.has(x.code)) return true;
    if (typeof x.message === "string" && /other side closed|socket hang up|ECONNRESET|ECONNREFUSED/i.test(x.message)) {
      return true;
    }
    e = x.cause;
  }
  return false;
}

export interface TransientRetry {
  /** Waits before the 2nd, 3rd, ... attempt; its length + 1 is the attempt count. */
  delaysMs: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, why: string) => void;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * `send` once, and again after each delay for as long as the failure is a
 * transient one. Returns the last response (any status the caller has to judge
 * itself), or throws the last error once the delays are spent or the error is
 * not transient.
 */
export async function sendWithTransientRetry(
  send: () => Promise<Response>,
  retry: TransientRetry,
): Promise<Response> {
  const sleep = retry.sleep ?? realSleep;
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= retry.delaysMs.length;
    let resp: Response;
    try {
      resp = await send();
    } catch (err) {
      if (last || !isTransientFetchError(err)) throw err;
      retry.onRetry?.(attempt + 1, err instanceof Error ? err.message : String(err));
      await sleep(retry.delaysMs[attempt]!);
      continue;
    }
    if (last || !isTransientHttpStatus(resp.status)) return resp;
    retry.onRetry?.(attempt + 1, `HTTP ${resp.status}`);
    await resp.body?.cancel().catch(() => {});
    await sleep(retry.delaysMs[attempt]!);
  }
}
