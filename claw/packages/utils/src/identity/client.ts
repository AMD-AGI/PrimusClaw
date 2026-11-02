// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { CredentialClient, type ResolveCredentialRequest, type ResolvedCredential } from "./credentials.js";
import { Endpoints } from "./discovery.js";
import { ExchangeClient, type ExchangedToken, type ExchangeRequest } from "./exchange.js";
import { Introspector, type IntrospectionResult, type IntrospectOptions } from "./introspection.js";
import { JwksCache } from "./jwks.js";
import { verifyJwt, type JwtVerifyOptions, type VerifiedJwt } from "./jwt.js";
import { NOOP_LOGGER, NOOP_METRICS, type IdentityDeps } from "./types.js";

export interface IdentityClientSettings {
  /** The issuer identifier, exactly as tokens carry it in `iss`. */
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  /** Where to fetch the discovery document; the standard well-known path under the issuer when unset. */
  discoveryUrl?: string;
  /** Pinned addresses, for a deployment where the advertised ones are not reachable. */
  introspectionUrl?: string;
  tokenUrl?: string;
  jwksUrl?: string;
  /** Where an external credential is resolved; derived from the token endpoint when unset. */
  credentialResolveUrl?: string;

  positiveTtlMs: number;
  negativeTtlMs: number;
  /** How long a stale positive introspection answer may be served while the upstream is down. Zero disables. */
  staleIfErrorMs: number;
  requestTimeoutMs: number;
  /** How often discovery and the key set are re-read. */
  keysRefreshMs: number;
  /** How long the discovery document and key set may be served past that while the upstream is down. */
  keysStaleIfErrorMs: number;
  /** A cached exchanged token with less than this left is replaced before use. */
  exchangeRefreshSkewMs: number;
}

/** Shipped values. The 30 s / 5 s / 30 min trio is the contract callers were promised. */
export const IDENTITY_DEFAULTS = {
  positiveTtlMs: 30_000,
  negativeTtlMs: 5_000,
  staleIfErrorMs: 30 * 60_000,
  requestTimeoutMs: 5_000,
  keysRefreshMs: 5 * 60_000,
  keysStaleIfErrorMs: 24 * 60 * 60_000,
  exchangeRefreshSkewMs: 30_000,
} as const;

const RETRY_AFTER_FAILURE_MS = 5_000;
const MIN_FORCED_JWKS_RELOAD_MS = 30_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_INTROSPECTION_ENTRIES = 10_000;
const MAX_EXCHANGE_ENTRIES = 1_000;

/**
 * One client for the three things a service asks the identity provider: who owns
 * this opaque credential (RFC 7662), is this JWT genuine (OIDC discovery and
 * JWKS), and give me a token for this user (RFC 8693). It holds no credential of
 * the user's and talks to nothing but the issuer.
 *
 * Construction does no I/O. Nothing here is wired into request authentication;
 * a caller opts in by building one.
 */
export class IdentityClient {
  private readonly deps: IdentityDeps;
  private readonly endpoints: Endpoints;
  private readonly keys: JwksCache;
  private readonly introspector: Introspector;
  private readonly exchanger: ExchangeClient;
  private readonly credentials: CredentialClient;

  constructor(private readonly settings: IdentityClientSettings, deps: Partial<IdentityDeps> = {}) {
    this.deps = {
      fetch: deps.fetch ?? fetch,
      now: deps.now ?? Date.now,
      metrics: deps.metrics ?? NOOP_METRICS,
      logger: deps.logger ?? NOOP_LOGGER,
    };
    const http = { timeoutMs: settings.requestTimeoutMs, maxBodyBytes: MAX_BODY_BYTES };
    this.endpoints = new Endpoints({
      issuer: settings.issuerUrl,
      discoveryUrl: settings.discoveryUrl,
      overrides: {
        introspectionUrl: settings.introspectionUrl,
        tokenUrl: settings.tokenUrl,
        jwksUrl: settings.jwksUrl,
        credentialResolveUrl: settings.credentialResolveUrl,
      },
      refreshMs: settings.keysRefreshMs,
      staleIfErrorMs: settings.keysStaleIfErrorMs,
      retryAfterFailureMs: RETRY_AFTER_FAILURE_MS,
      http,
    }, this.deps);
    this.keys = new JwksCache({
      refreshMs: settings.keysRefreshMs,
      staleIfErrorMs: settings.keysStaleIfErrorMs,
      retryAfterFailureMs: RETRY_AFTER_FAILURE_MS,
      minForcedReloadMs: MIN_FORCED_JWKS_RELOAD_MS,
      http,
    }, this.endpoints, this.deps);
    this.introspector = new Introspector({
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      positiveTtlMs: settings.positiveTtlMs,
      negativeTtlMs: settings.negativeTtlMs,
      staleIfErrorMs: settings.staleIfErrorMs,
      retryAfterFailureMs: RETRY_AFTER_FAILURE_MS,
      maxEntries: MAX_INTROSPECTION_ENTRIES,
      http,
    }, this.endpoints, this.deps);
    this.exchanger = new ExchangeClient({
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      refreshSkewMs: settings.exchangeRefreshSkewMs,
      maxEntries: MAX_EXCHANGE_ENTRIES,
      http,
    }, this.endpoints, this.deps);
    this.credentials = new CredentialClient({
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      http,
    }, this.endpoints, this.deps);
  }

  /**
   * Who owns this credential. Resolves `{active:false}` only when the upstream
   * said so; throws {@link IdentityUnavailableError} when it could not be asked.
   */
  introspect(token: string, opts?: IntrospectOptions): Promise<IntrospectionResult> {
    return this.introspector.introspect(token, opts);
  }

  /** A token for the subject, from the cache while it has life left. */
  exchange(req: ExchangeRequest): Promise<ExchangedToken> {
    return this.exchanger.exchange(req);
  }

  /**
   * A user's third-party credential (a GitHub token), for one use and not kept.
   * Throws {@link IdentityCredentialRefusedError} when there is none or it has
   * expired, {@link IdentityUnavailableError} when the provider could not be asked.
   */
  resolveExternalCredential(req: ResolveCredentialRequest): Promise<ResolvedCredential> {
    return this.credentials.resolve(req);
  }

  /** Verify a JWT locally against the issuer's keys; `issuer` defaults to the configured one. */
  verifyJwt(token: string, opts: Omit<JwtVerifyOptions, "issuer"> & { issuer?: string }): Promise<VerifiedJwt> {
    return verifyJwt(token, { ...opts, issuer: opts.issuer ?? this.settings.issuerUrl }, this.keys, this.deps.now);
  }

  /**
   * Read discovery and the key set now, so a wrong issuer or an unreachable
   * upstream shows at start-up instead of at the first request. Throws what the
   * failing fetch threw; whether that is fatal is the caller's call.
   */
  async warmup(): Promise<void> {
    await this.endpoints.warm();
    await this.keys.warm();
  }
}
