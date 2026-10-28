// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Endpoints } from "./discovery.js";
import { IdentityUnavailableError } from "./errors.js";
import { basicAuthHeader, classifyStatus, digest, parseJsonObject, send, type HttpSettings } from "./http.js";
import { observe } from "./refreshing.js";
import type { IdentityDeps } from "./types.js";

/** An RFC 7662 answer for a token that is valid for the caller. */
export interface ActiveIntrospection {
  active: true;
  sub?: string;
  username?: string;
  preferredUsername?: string;
  email?: string;
  name?: string;
  roles: string[];
  groups: string[];
  audience: string[];
  scope: string[];
  clientId?: string;
  tokenType?: string;
  jti?: string;
  /** Epoch milliseconds, from `exp`. */
  expiresAt?: number;
  /** The whole response, for the extension members this type does not name. */
  claims: Record<string, unknown>;
}

/** Deliberately says nothing about why: the upstream does not either. */
export interface InactiveIntrospection {
  active: false;
}

export type IntrospectionResult = ActiveIntrospection | InactiveIntrospection;

export interface IntrospectionSettings {
  clientId: string;
  clientSecret: string;
  positiveTtlMs: number;
  negativeTtlMs: number;
  staleIfErrorMs: number;
  retryAfterFailureMs: number;
  maxEntries: number;
  http: HttpSettings;
}

export interface IntrospectOptions {
  /** RFC 7662 `token_type_hint`. */
  tokenTypeHint?: string;
  /**
   * Extra form members the upstream understands (an audience to narrow the check
   * to, the address the credential came from). They are part of the question, so
   * they are part of the cache key: an answer for one audience is never served
   * for another.
   */
  params?: Record<string, string>;
}

interface Entry {
  result: IntrospectionResult;
  /** Served without asking until this instant. */
  freshUntil: number;
  /** Positive answers only: the last instant a failed refresh may fall back to this entry. */
  staleUntil: number;
  /** The token's own `exp`, which no cache window may outlive. */
  expiresAt: number | undefined;
  /** After a failed refresh, do not try again before this instant. */
  retryAt: number;
}

const INACTIVE: InactiveIntrospection = Object.freeze({ active: false });
const RESERVED_PARAMS = new Set(["token", "token_type_hint", "client_id", "client_secret"]);

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function optString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function parseActive(raw: Record<string, unknown>): ActiveIntrospection {
  const scope = typeof raw.scope === "string" ? raw.scope.split(/\s+/).filter(Boolean) : [];
  const aud = typeof raw.aud === "string" ? [raw.aud] : stringList(raw.aud);
  const exp = typeof raw.exp === "number" && Number.isFinite(raw.exp) && raw.exp > 0 ? raw.exp * 1000 : undefined;
  return {
    active: true,
    sub: optString(raw.sub),
    username: optString(raw.username),
    preferredUsername: optString(raw.preferred_username),
    email: optString(raw.email),
    name: optString(raw.name),
    roles: stringList(raw.roles),
    groups: stringList(raw.groups),
    audience: aud,
    scope,
    clientId: optString(raw.client_id),
    tokenType: optString(raw.token_type),
    jti: optString(raw.jti),
    expiresAt: exp,
    claims: raw,
  };
}

/**
 * RFC 7662 token introspection with the caching the callers need to stay fast
 * and to survive the upstream being down.
 *
 *  - A positive answer is kept for `positiveTtlMs` (never past the token's own
 *    `exp`), an inactive one for `negativeTtlMs`. The negative window is short
 *    because a credential that was refused a moment ago may just have been issued.
 *  - Concurrent lookups of one credential share a single upstream call.
 *  - When the upstream cannot be asked (network, timeout, 5xx, 429, an
 *    unreadable answer) a positive entry that has gone stale is served for up to
 *    `staleIfErrorMs` more, counted in `onStaleServed`. Anything else is an
 *    {@link IdentityUnavailableError}. An outage is NEVER turned into
 *    `{active:false}`, and an inactive answer is NEVER served stale.
 *  - A refusal of this client's own credentials (401/403) is not an outage and
 *    is never answered from a stale entry.
 */
export class Introspector {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<IntrospectionResult>>();
  private readonly authorization: string;

  constructor(
    private readonly s: IntrospectionSettings,
    private readonly endpoints: Endpoints,
    private readonly deps: IdentityDeps,
  ) {
    this.authorization = basicAuthHeader(s.clientId, s.clientSecret);
  }

  async introspect(token: string, opts: IntrospectOptions = {}): Promise<IntrospectionResult> {
    if (!token) return INACTIVE;
    const params = Object.entries(opts.params ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [name] of params) {
      if (RESERVED_PARAMS.has(name)) throw new TypeError(`introspection parameter ${name} is reserved`);
    }
    const key = digest(token, opts.tokenTypeHint ?? "", ...params.flat());

    const now = this.deps.now();
    const entry = this.entries.get(key);
    if (entry && now < entry.freshUntil) {
      this.deps.metrics.onCache("introspection", entry.result.active ? "hit" : "hit_negative");
      return entry.result;
    }
    if (entry && this.canServeStale(entry, now) && now < entry.retryAt) {
      this.deps.metrics.onStaleServed("introspection");
      return entry.result;
    }

    let flight = this.inflight.get(key);
    if (flight) {
      this.deps.metrics.onCache("introspection", "coalesced");
    } else {
      this.deps.metrics.onCache("introspection", "miss");
      flight = this.fetchAndStore(key, token, opts.tokenTypeHint, params, now);
      this.inflight.set(key, flight);
      const started = flight;
      const clear = (): void => { if (this.inflight.get(key) === started) this.inflight.delete(key); };
      started.then(clear, clear);
    }
    try {
      return await flight;
    } catch (err) {
      if (
        entry && err instanceof IdentityUnavailableError && err.reason !== "client_rejected" &&
        this.canServeStale(entry, this.deps.now())
      ) {
        entry.retryAt = this.deps.now() + this.s.retryAfterFailureMs;
        this.deps.metrics.onStaleServed("introspection");
        this.deps.logger.warn({ op: "introspection", reason: err.reason, status: err.status }, "identity.stale_if_error");
        return entry.result;
      }
      throw err;
    }
  }

  /**
   * An entry past freshness, inside its stale window, and for a token that has not
   * itself expired. An inactive entry is stored with `staleUntil` 0, which is what
   * keeps a refused credential from being revived by an outage.
   */
  private canServeStale(entry: Entry, now: number): boolean {
    return now < entry.staleUntil && (entry.expiresAt === undefined || now < entry.expiresAt);
  }

  private async fetchAndStore(
    key: string,
    token: string,
    hint: string | undefined,
    params: [string, string][],
    startedAt: number,
  ): Promise<IntrospectionResult> {
    const result = await observe(this.deps, "introspection", async () => {
      const url = await this.endpoints.introspection();
      const form = new URLSearchParams({ token });
      if (hint) form.set("token_type_hint", hint);
      for (const [name, value] of params) form.set(name, value);
      const { status, body } = await send("introspection", this.deps.fetch, url, {
        method: "POST",
        headers: {
          Authorization: this.authorization,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: form.toString(),
      }, this.s.http);
      if (status !== 200) throw new IdentityUnavailableError("introspection", classifyStatus(status, true), status);
      const raw = parseJsonObject("introspection", status, body);
      if (typeof raw.active !== "boolean") throw new IdentityUnavailableError("introspection", "bad_response", status);
      if (!raw.active) return { value: INACTIVE as IntrospectionResult, outcome: "inactive" as const };
      return { value: parseActive(raw) as IntrospectionResult, outcome: "ok" as const };
    });
    this.store(key, result, startedAt);
    return result;
  }

  private store(key: string, result: IntrospectionResult, startedAt: number): void {
    // Re-inserted rather than updated, so a refreshed key moves to the young end
    // and eviction (oldest first) takes the ones nobody asked about lately.
    this.entries.delete(key);
    let entry: Entry;
    if (result.active) {
      const freshUntil = Math.min(startedAt + this.s.positiveTtlMs, result.expiresAt ?? Infinity);
      // With positive caching off nothing positive is kept, not even for the stale path.
      if (this.s.positiveTtlMs <= 0) return;
      entry = { result, freshUntil, staleUntil: freshUntil + this.s.staleIfErrorMs, expiresAt: result.expiresAt, retryAt: 0 };
    } else {
      if (this.s.negativeTtlMs <= 0) return;
      entry = { result, freshUntil: startedAt + this.s.negativeTtlMs, staleUntil: 0, expiresAt: undefined, retryAt: 0 };
    }
    if (this.entries.size >= this.s.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, entry);
  }
}
