// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { ClawUnreachable, pyTruthy, type KeyRevoker } from "@primusclaw/personal-agent";
import { ClawHttp, DEFAULT_TIMEOUT_MS, readText, type Fetch } from "./http.js";

/**
 * Deletes a person's own platform key with the key itself (the Python worker's `safe.revoke_own_key`): it asks
 * `/apikeys/current` for the key's id, then deletes `/apikeys/{id}`. True only when the delete answered below 300. Any
 * failure is false, and nothing is thrown for it: an answer other than 200 to the first call, a timeout or a broken
 * connection, a body that is not JSON, not an object or without an id. The caller tells the person to delete the key
 * themselves; the link goes either way.
 *
 * The id goes into the delete's path only as one path segment (`pathId`): a positive integer, or a string of URL
 * unreserved characters that is not a dot segment. For any other id nothing is deleted and the answer is false: the
 * HTTP client would resolve "../users/self" into a request for another endpoint.
 */
export class HttpKeyRevoker implements KeyRevoker {
  private readonly http: ClawHttp;

  /** `safeApiUrl` is the platform API without a trailing slash (Settings.safeApiUrl). */
  constructor(
    safeApiUrl: string,
    fetchImpl: Fetch = fetch,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    this.http = new ClawHttp(safeApiUrl, fetchImpl);
  }

  async revoke(key: string): Promise<boolean> {
    try {
      const id = await this.currentKeyId(key);
      if (id === undefined) return false;
      const deleted = await this.http.send({
        method: "DELETE",
        path: `/apikeys/${id}`, // one path segment (pathId)
        key,
        timeoutMs: this.timeoutMs,
      });
      await discard(deleted);
      return deleted.status < 300;
    } catch (err) {
      // unreachable, timed out or broken while read (Python: httpx.HTTPError)
      if (err instanceof ClawUnreachable) return false;
      throw err;
    }
  }

  /** The key's id from `/apikeys/current` (Python: `body.get("id") or (body.get("data") or {}).get("id")`), or none. */
  private async currentKeyId(key: string): Promise<string | undefined> {
    const what = "/apikeys/current";
    const current = await this.http.send({ method: "GET", path: what, key, timeoutMs: this.timeoutMs });
    if (current.status !== 200) {
      await discard(current);
      return undefined;
    }
    let body: unknown;
    try {
      body = JSON.parse(await readText(current, what));
    } catch (err) {
      if (err instanceof SyntaxError) return undefined; // not JSON (Python: ValueError)
      throw err;
    }
    return idIn(body);
  }
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const own = (object: Readonly<Record<string, unknown>>, name: string): unknown =>
  Object.hasOwn(object, name) ? object[name] : undefined;

/** The key id in an `/apikeys/current` answer, as Python reads it, then as a path segment (`pathId`); or none. */
function idIn(body: unknown): string | undefined {
  if (!isObject(body)) return undefined;
  let id = own(body, "id");
  if (!pyTruthy(id)) {
    const data = own(body, "data");
    if (!isObject(data)) return undefined; // Python: `(data or {}).get`, AttributeError on a non-object
    id = own(data, "id");
    if (!pyTruthy(id)) return undefined;
  }
  return pathId(id);
}

const KEY_ID = /^[A-Za-z0-9._~-]{1,200}$/;

/**
 * `value` as the one path segment of the key's delete (Python `_path_id`): a positive integer (the platform's own ids
 * are numbers), or a string of unreserved characters that is not "." or ".."; else none. A boolean is no id. An integer
 * past 2^53 is none here, where Python keeps it exact: JavaScript has already rounded it, to another key's id perhaps.
 */
function pathId(value: unknown): string | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  if (typeof value === "string" && KEY_ID.test(value) && value !== "." && value !== "..") return value;
  return undefined;
}

/** Drops an answer's body unread; a body that fails as it is dropped changes nothing. */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
