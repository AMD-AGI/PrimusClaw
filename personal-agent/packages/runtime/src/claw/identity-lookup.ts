// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import {
  ClawUnreachable,
  isApiKey,
  pyLower,
  pyStrip,
  pyStrOf,
  pyTruthy,
  type IdentityLookup,
  type KeyOwner,
  type Logger,
} from "@primusclaw/personal-agent";
import { ClawHttp, DEFAULT_TIMEOUT_MS, readText, type Fetch } from "./http.js";

/** Where a lookup asks besides the platform, and where it says that an answer was not 200. */
export interface IdentityLookupOptions {
  /**
   * Claw's API without a trailing slash (Settings.clawApiUrl). An exchanged identity token is asked about here, at
   * `GET /v1/me`: it is a token for Claw's audience, which the platform's `/users/self` refuses (401). Without it a
   * token has no owner.
   */
  readonly clawApiUrl?: string;
  /** Where an answer other than 200 is noted: its status, the route and the kind of credential, never the credential. */
  readonly logger?: Logger;
}

/**
 * Who a credential belongs to. A person's own key (`ak-...`) is asked of the platform's `/users/self` with the key itself
 * (the Python worker's `safe.whoami`, `safe.safe_user` and `safe.user_id_of`, which read the same answer). An identity
 * token exchanged for them (TEAMS_EXCHANGE_FOR_CHAT) is asked of Claw's `/v1/me` with the token, when Claw's URL is
 * given: the platform does not take such a token on its data routes, and Claw answers with the platform's id, name and
 * email of the token's subject (it has no account type: ""). Any failure is no owner: an answer other than 200, a timeout
 * or a broken connection, a body that is not JSON or not an object. The caller says so, or tries again later (the
 * subscriptions' timer that fills in Claw user ids).
 */
export class HttpIdentityLookup implements IdentityLookup {
  private readonly safe: ClawHttp;
  private readonly claw: ClawHttp | undefined;
  private readonly logger: Logger | undefined;

  /** `safeApiUrl` is the platform API without a trailing slash (Settings.safeApiUrl). */
  constructor(
    safeApiUrl: string,
    fetchImpl: Fetch = fetch,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    options: IdentityLookupOptions = {},
  ) {
    this.safe = new ClawHttp(safeApiUrl, fetchImpl);
    this.claw = options.clawApiUrl ? new ClawHttp(options.clawApiUrl, fetchImpl) : undefined;
    this.logger = options.logger;
  }

  async ownerOfKey(key: string): Promise<KeyOwner | undefined> {
    if (isApiKey(key)) {
      const body = await this.ask(this.safe, "/users/self", key, "api_key");
      return body === undefined ? undefined : ownerIn(body);
    }
    if (this.claw === undefined) return undefined;
    const body = await this.ask(this.claw, "/v1/me", key, "identity_token");
    return body === undefined ? undefined : ownerInMe(body);
  }

  /** The JSON answer of `GET what` asked with `key`; undefined on any failure. */
  private async ask(http: ClawHttp, what: string, key: string, kind: string): Promise<unknown> {
    let text: string;
    try {
      const response = await http.send({ method: "GET", path: what, key, timeoutMs: this.timeoutMs });
      if (response.status !== 200) {
        await response.body?.cancel();
        this.logger?.info("identity lookup: no owner", { route: what, status: response.status, credential: kind });
        return undefined;
      }
      text = await readText(response, what);
    } catch (err) {
      // unreachable, timed out, or broken while read (Python: httpx.HTTPError)
      if (err instanceof ClawUnreachable) return undefined;
      throw err;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined; // not JSON (Python: ValueError)
    }
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

/** The owner in Claw's `/v1/me` answer (`userId`, `name`, `email`); none when not an object. */
function ownerInMe(body: unknown): KeyOwner | undefined {
  if (!isObject(body)) return undefined;
  return { id: field(body, "userId"), name: field(body, "name"), email: field(body, "email"), accountType: "" };
}
