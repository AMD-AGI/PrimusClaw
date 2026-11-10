// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import {
  ClawUnreachable,
  pyLower,
  pyStrip,
  pyStrOf,
  pyTruthy,
  type IdentityLookup,
  type KeyOwner,
} from "@primusclaw/personal-agent";
import { ClawHttp, DEFAULT_TIMEOUT_MS, readText, type Fetch } from "./http.js";

/**
 * Who a key belongs to, from the platform's `/users/self` asked with the key itself (the Python worker's `safe.whoami`,
 * `safe.safe_user` and `safe.user_id_of`, which read the same answer). Any failure is no owner: an answer other than
 * 200, a timeout or a broken connection, a body that is not JSON or not an object. The caller says so, or tries again
 * later (the subscriptions' timer that fills in Claw user ids).
 */
export class HttpIdentityLookup implements IdentityLookup {
  private readonly http: ClawHttp;

  /** `safeApiUrl` is the platform API without a trailing slash (Settings.safeApiUrl). */
  constructor(
    safeApiUrl: string,
    fetchImpl: Fetch = fetch,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    this.http = new ClawHttp(safeApiUrl, fetchImpl);
  }

  async ownerOfKey(key: string): Promise<KeyOwner | undefined> {
    const what = "/users/self";
    let text: string;
    try {
      const response = await this.http.send({ method: "GET", path: what, key, timeoutMs: this.timeoutMs });
      if (response.status !== 200) {
        await response.body?.cancel();
        return undefined;
      }
      text = await readText(response, what);
    } catch (err) {
      // unreachable, timed out, or broken while read (Python: httpx.HTTPError)
      if (err instanceof ClawUnreachable) return undefined;
      throw err;
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return undefined; // not JSON (Python: ValueError)
    }
    return ownerIn(body);
  }
}

/** Python's `str(x or "").strip()` of an answer's field. */
function field(user: Readonly<Record<string, unknown>>, name: string): string {
  const value = Object.hasOwn(user, name) ? user[name] : undefined;
  return pyTruthy(value) ? pyStrip(pyStrOf(value)) : "";
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The owner in a `/users/self` answer: its `data` when that is an object, else the answer itself; none when not an object. */
function ownerIn(body: unknown): KeyOwner | undefined {
  if (!isObject(body)) return undefined;
  const data = Object.hasOwn(body, "data") ? body["data"] : undefined;
  const user = isObject(data) ? data : body;
  return {
    id: field(user, "id"),
    name: field(user, "name"),
    email: field(user, "email"),
    accountType: pyLower(field(user, "type")),
  };
}
