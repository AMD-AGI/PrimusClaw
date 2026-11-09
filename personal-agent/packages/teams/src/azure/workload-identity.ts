// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker's own Azure identity, by workload identity federation, for Key Vault and Service Bus.
 *
 * The worker signs a short assertion with the key it already holds for the bot (BOT_ASSERTION_KEY_FILE, issuer
 * BOT_ASSERTION_ISSUER, tenant BOT_TENANT_ID) and Entra ID trades it for a token of the user-assigned identity
 * WORKER_IDENTITY_CLIENT_ID, whose federated credential names WORKER_IDENTITY_SUBJECT. It is a separate identity from the
 * bot's: the bot's identity is also assigned to the ingress Function, which must not read the worker's vault.
 *
 * `FederatedCredential` has the shape of an Azure SDK `TokenCredential` (`getToken(scopes)` resolving to `{ token,
 * expiresOnTimestamp }`), defined here so no Azure package is needed. Tokens are cached per scope; the key and the tokens
 * are never logged.
 */
import { readFileSync } from "node:fs";
import { silentLogger, type Clock, type Logger } from "@primusclaw/personal-agent";
import { TokenError } from "../connector/errors.js";
import { reasonOf } from "../connector/timer.js";
import { loadAssertionKey } from "../connector/tokens/assertion.js";
import { FederatedTokenProvider } from "../connector/tokens/federated.js";

/** An Azure SDK access token: the bearer token and when it expires (milliseconds since the epoch). */
export interface AccessToken {
  readonly token: string;
  readonly expiresOnTimestamp: number;
}

/** The part of an Azure SDK `TokenCredential` this worker implements. */
export interface TokenCredential {
  getToken(scopes: string | string[], options?: { abortSignal?: AbortSignal }): Promise<AccessToken | null>;
}

/** The worker identity is missing a setting or its key cannot be used: the worker does not start. */
export class WorkerIdentityError extends Error {
  override name = "WorkerIdentityError";
}

/** Entra ID gave no token for the worker identity (what an Azure SDK credential reports as an authentication error). */
export class CredentialAuthenticationError extends Error {
  override name = "CredentialAuthenticationError";
}

const SETTINGS = {
  clientId: "WORKER_IDENTITY_CLIENT_ID",
  tenantId: "BOT_TENANT_ID",
  issuer: "BOT_ASSERTION_ISSUER",
  subject: "WORKER_IDENTITY_SUBJECT",
  keyFile: "BOT_ASSERTION_KEY_FILE",
} as const;

export interface WorkerIdentity {
  readonly clientId: string;
  readonly tenantId: string;
  /** The https issuer registered in the federated credential, without a trailing slash. */
  readonly issuer: string;
  readonly subject: string;
  readonly keyFile: string;
}

/** The identity from the environment; `why` (the setting that needs it) is named when something is missing. */
export function workerIdentityFromEnv(env: Readonly<Record<string, string | undefined>>, why: string): WorkerIdentity {
  const get = (name: string): string => (env[name] ?? "").trim();
  const missing = Object.values(SETTINGS).filter((name) => !get(name));
  if (missing.length) throw new WorkerIdentityError(`${why} needs the worker identity: set ${missing.join(", ")}`);
  const issuer = get(SETTINGS.issuer);
  if (!issuer.startsWith("https://")) {
    throw new WorkerIdentityError(
      "BOT_ASSERTION_ISSUER must be the https issuer URL registered in the federated credential",
    );
  }
  return {
    clientId: get(SETTINGS.clientId),
    tenantId: get(SETTINGS.tenantId),
    issuer: issuer.replace(/\/+$/, ""),
    subject: get(SETTINGS.subject),
    keyFile: get(SETTINGS.keyFile),
  };
}

/** The signing key's PEM. A key that cannot be read or is not an RSA key stops the worker at start. */
export function readWorkerKey(identity: WorkerIdentity, read: (path: string) => Buffer = readFileSync): Buffer {
  let pem: Buffer;
  try {
    pem = read(identity.keyFile);
  } catch (error) {
    const kind = error instanceof Error && "code" in error ? String(error.code) : "error";
    throw new WorkerIdentityError(`BOT_ASSERTION_KEY_FILE cannot be read (${kind})`, { cause: error });
  }
  try {
    loadAssertionKey(pem);
  } catch (error) {
    throw new WorkerIdentityError(`BOT_ASSERTION_KEY_FILE: ${(error as Error).message}`, { cause: error });
  }
  return pem;
}

export interface CredentialOptions {
  readonly clock: Clock;
  readonly fetch?: typeof fetch;
  readonly logger?: Logger;
  /** The token endpoint; default Entra ID's for the tenant. */
  readonly url?: string;
}

/** A token credential for the worker identity: one cached token per scope, each from Entra ID for a fresh assertion. */
export class FederatedCredential implements TokenCredential {
  private readonly providers = new Map<string, FederatedTokenProvider>();

  /** Throws AssertionKeyError now, rather than at the first token, when the key cannot sign. */
  constructor(
    private readonly identity: WorkerIdentity,
    private readonly keyPem: string | Uint8Array,
    private readonly options: CredentialOptions,
  ) {
    loadAssertionKey(keyPem);
  }

  get clientId(): string {
    return this.identity.clientId;
  }

  private provider(scope: string): FederatedTokenProvider {
    let provider = this.providers.get(scope);
    if (provider === undefined) {
      const { identity, options } = this;
      provider = new FederatedTokenProvider({
        clientId: identity.clientId,
        tenantId: identity.tenantId,
        keyPem: this.keyPem,
        issuer: identity.issuer,
        subject: identity.subject,
        clock: options.clock,
        logger: options.logger ?? silentLogger,
        scope,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.url === undefined ? {} : { url: options.url }),
      });
      this.providers.set(scope, provider);
    }
    return provider;
  }

  /** The bearer token for `scope`; throws TokenError (with `transient`) when Entra ID gives none. */
  token(scope: string, signal?: AbortSignal): Promise<string> {
    return this.provider(scope).get(signal);
  }

  async getToken(scopes: string | string[], options: { abortSignal?: AbortSignal } = {}): Promise<AccessToken> {
    const list = typeof scopes === "string" ? [scopes] : scopes;
    const [scope] = list;
    if (list.length !== 1 || scope === undefined) throw new RangeError("exactly one scope is supported");
    const provider = this.provider(scope);
    let token: string;
    try {
      token = await provider.get(options.abortSignal);
    } catch (error) {
      const signal = options.abortSignal;
      if (signal?.aborted) throw reasonOf(signal); // the caller gave up: theirs, not an authentication failure
      if (!(error instanceof TokenError)) throw error;
      throw new CredentialAuthenticationError(`worker identity ${this.clientId}: ${error.message}`, { cause: error });
    }
    return { token, expiresOnTimestamp: this.options.clock.epochMs() + provider.validForMs() };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
