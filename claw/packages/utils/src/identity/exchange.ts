// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Endpoints } from "./discovery.js";
import { IdentityExchangeRefusedError, IdentityUnavailableError } from "./errors.js";
import { basicAuthHeader, classifyStatus, digest, parseJsonObject, send, type HttpSettings } from "./http.js";
import { observe } from "./refreshing.js";
import type { IdentityDeps } from "./types.js";

/** RFC 8693 section 2.1 grant type. */
export const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";

/**
 * RFC 8693 section 3 token type of an access token. As a `subjectTokenType` it says the subject is the user an
 * access token the provider issued names, and the token itself is the proof (no consent on record is needed): a
 * service that was sent the user's token uses it to ask for one for another service that acts for that user.
 */
export const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

export interface ExchangeRequest {
  subjectToken: string;
  /**
   * RFC 8693 `subject_token_type`. Required and never defaulted here: which
   * types an authorization server accepts is its own business, and a default
   * would only be right for one of them.
   */
  subjectTokenType: string;
  audience?: string;
  scope?: string | readonly string[];
  resource?: string;
  requestedTokenType?: string;
  /**
   * Ignore a cached token and fetch a new one: for a caller whose last token was
   * refused downstream. Also disables the fall-back to a cached token when the
   * upstream is down, since that token is the one that was just refused.
   */
  forceRefresh?: boolean;
  /**
   * A cached token is reused only while it has at least this long left.
   * Defaults to the client's refresh skew.
   */
  minRemainingMs?: number;
}

export interface ExchangedToken {
  accessToken: string;
  tokenType: string;
  issuedTokenType?: string;
  scope?: string;
  /** Epoch milliseconds, or null when the response did not say. A token with no stated lifetime is never cached. */
  expiresAt: number | null;
}

export interface ExchangeSettings {
  clientId: string;
  clientSecret: string;
  /** A cached token with less than this left is replaced before it is handed out. */
  refreshSkewMs: number;
  maxEntries: number;
  http: HttpSettings;
}

/**
 * An answer that ends the authority of a token already held: the provider
 * refused the request (a decision, such as a withdrawn binding) or refused this
 * client. An outage ends nothing, so it is not one.
 */
function withdrawsHeldToken(err: unknown): boolean {
  return err instanceof IdentityExchangeRefusedError ||
    (err instanceof IdentityUnavailableError && err.reason === "client_rejected");
}

function scopeString(scope: ExchangeRequest["scope"]): string {
  return Array.isArray(scope) ? scope.join(" ") : (scope as string | undefined) ?? "";
}

/**
 * An RFC 8693 token exchange client with a token cache.
 *
 * The cache key covers everything that can change what comes back (subject,
 * subject type, audience, scope, resource, requested type), so a token minted
 * for one subject or audience is never handed to another. The subject token is
 * digested into the key rather than stored in it.
 *
 * Nothing is cached about a refusal: a binding revoked a second ago must stop
 * working on the next call, and one granted a second ago must start. So a token
 * the provider refuses to replace is dropped, not merely left unreplaced: an
 * `invalid_grant` or a rejected client, and any `forceRefresh` (whose caller says
 * the held token was refused downstream), evict what was cached for that request,
 * whether or not the new call then succeeds. After that, neither a plain call nor
 * the stale-if-error path can hand the old token out again.
 */
export class ExchangeClient {
  private readonly cache = new Map<string, ExchangedToken>();
  private readonly inflight = new Map<string, Promise<ExchangedToken>>();
  private readonly authorization: string;

  constructor(
    private readonly s: ExchangeSettings,
    private readonly endpoints: Endpoints,
    private readonly deps: IdentityDeps,
  ) {
    this.authorization = basicAuthHeader(s.clientId, s.clientSecret);
  }

  async exchange(req: ExchangeRequest): Promise<ExchangedToken> {
    if (!req.subjectToken) throw new TypeError("subjectToken is required");
    if (!req.subjectTokenType) throw new TypeError("subjectTokenType is required");

    const key = digest(
      req.subjectTokenType, req.subjectToken, req.audience ?? "", scopeString(req.scope),
      req.resource ?? "", req.requestedTokenType ?? "",
    );
    const now = this.deps.now();
    // The caller is replacing a token it says was refused downstream. Drop it
    // before asking, so a failed replacement leaves nothing to be served later.
    if (req.forceRefresh) this.cache.delete(key);
    const held = this.cache.get(key);
    const minRemaining = req.minRemainingMs ?? this.s.refreshSkewMs;
    if (!req.forceRefresh && held && held.expiresAt !== null && held.expiresAt - now > minRemaining) {
      this.deps.metrics.onCache("exchange", "hit");
      return held;
    }

    let flight = this.inflight.get(key);
    if (flight && !req.forceRefresh) {
      this.deps.metrics.onCache("exchange", "coalesced");
    } else {
      this.deps.metrics.onCache("exchange", "miss");
      // Only the newest flight for a key may touch the cache: an older one that
      // finishes late must not overwrite what a forced refresh stored since.
      const started: Promise<ExchangedToken> = this.fetchToken(req, now).then(
        (token) => {
          if (this.inflight.get(key) === started) this.store(key, token);
          return token;
        },
        (err: unknown) => {
          if (this.inflight.get(key) === started && withdrawsHeldToken(err)) this.cache.delete(key);
          throw err;
        },
      );
      flight = started;
      this.inflight.set(key, started);
      const clear = (): void => { if (this.inflight.get(key) === started) this.inflight.delete(key); };
      started.then(clear, clear);
    }
    try {
      return await flight;
    } catch (err) {
      // The upstream could not be asked, and the token already held is still
      // inside its lifetime: handing it out beats failing. Not for a refusal (a
      // decision), not for a rejected client (it must stop), not on forceRefresh.
      // And only if it is still the cached one: a refusal or a forced refresh that
      // ran while this call waited has evicted it, and that eviction stands.
      if (
        !req.forceRefresh && held && this.cache.get(key) === held && held.expiresAt !== null &&
        held.expiresAt > this.deps.now() &&
        err instanceof IdentityUnavailableError && err.reason !== "client_rejected"
      ) {
        this.deps.metrics.onStaleServed("exchange");
        this.deps.logger.warn({ op: "exchange", reason: err.reason, status: err.status }, "identity.stale_if_error");
        return held;
      }
      throw err;
    }
  }

  private async fetchToken(req: ExchangeRequest, startedAt: number): Promise<ExchangedToken> {
    const answer = await observe(this.deps, "exchange", async () => {
      const url = await this.endpoints.token();
      const form = new URLSearchParams({
        grant_type: TOKEN_EXCHANGE_GRANT,
        subject_token: req.subjectToken,
        subject_token_type: req.subjectTokenType,
      });
      if (req.audience) form.set("audience", req.audience);
      const scope = scopeString(req.scope);
      if (scope) form.set("scope", scope);
      if (req.resource) form.set("resource", req.resource);
      if (req.requestedTokenType) form.set("requested_token_type", req.requestedTokenType);
      const { status, body } = await send("exchange", this.deps.fetch, url, {
        method: "POST",
        headers: {
          Authorization: this.authorization,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: form.toString(),
      }, this.s.http);

      if (status === 200) {
        const raw = parseJsonObject("exchange", status, body);
        if (typeof raw.access_token !== "string" || raw.access_token === "") {
          throw new IdentityUnavailableError("exchange", "bad_response", status);
        }
        const ttl = typeof raw.expires_in === "number" && Number.isFinite(raw.expires_in) && raw.expires_in > 0
          ? raw.expires_in
          : null;
        const token: ExchangedToken = {
          accessToken: raw.access_token,
          tokenType: typeof raw.token_type === "string" ? raw.token_type : "Bearer",
          issuedTokenType: typeof raw.issued_token_type === "string" ? raw.issued_token_type : undefined,
          scope: typeof raw.scope === "string" ? raw.scope : undefined,
          expiresAt: ttl === null ? null : startedAt + ttl * 1000,
        };
        return { value: token as ExchangedToken | IdentityExchangeRefusedError, outcome: "ok" as const };
      }

      // A 400 with an OAuth error body is the server's decision. A 401/403 is it
      // refusing this client, which is a configuration fault, not a decision about
      // the user; everything else is "no answer".
      const reason = classifyStatus(status, true);
      if (reason === "http_4xx") {
        let code: unknown;
        let description: unknown;
        try {
          const raw = parseJsonObject("exchange", status, body);
          code = raw.error;
          description = raw.error_description;
        } catch {
          code = undefined;
        }
        if (typeof code === "string" && code !== "") {
          const refused = new IdentityExchangeRefusedError(code, status, typeof description === "string" ? description : undefined);
          return { value: refused as ExchangedToken | IdentityExchangeRefusedError, outcome: "refused" as const };
        }
      }
      throw new IdentityUnavailableError("exchange", reason, status);
    });
    if (answer instanceof IdentityExchangeRefusedError) throw answer;
    return answer;
  }

  private store(key: string, token: ExchangedToken): void {
    this.cache.delete(key);
    if (token.expiresAt === null) return;
    if (this.cache.size >= this.s.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, token);
  }
}
