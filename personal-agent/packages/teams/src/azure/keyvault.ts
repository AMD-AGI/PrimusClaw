// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * SECRETS_SOURCE=keyvault: the worker's secrets, read once at start from Azure Key Vault as the worker's own identity
 * (`workload-identity.ts`) and kept in memory only. A transient failure (network, 429, 5xx) is tried again with a
 * doubling wait, a refusal (401/403/404) is not, and the whole read has one deadline. A secret that cannot be read
 * throws SecretsUnavailable, naming the secret and the vault's error code, never a value or a token.
 */
import { z } from "zod";
import {
  cpSlice,
  errorName,
  pyStr,
  pyStrip,
  SecretsUnavailable,
  silentLogger,
  type Clock,
  type Logger,
  type SecretName,
  type SecretSource,
} from "@primusclaw/personal-agent";
import { DeadlineError, TokenError } from "../connector/errors.js";
import { pyQuote, pyTruthy } from "../connector/py-parse.js";
import { raceAbort, startTimer } from "../connector/timer.js";
import {
  KEYVAULT_API_VERSION,
  KEYVAULT_SCOPE,
  LEGACY_VAULT_NAMES,
  shadowedSettings,
  VAULT_NAMES,
  vaultHost,
  vaultUrl,
  type Env,
} from "./keyvault-config.js";
import { FederatedCredential, readWorkerKey, workerIdentityFromEnv } from "./workload-identity.js";

/** Tries per secret (and for the token) on a transient failure, with waits of 2, 4, 8 and 16 s between them. */
export const ATTEMPTS = 5;
export const BACKOFF_MS = 2_000;
export const KEYVAULT_TIMEOUT_MS = 10_000;
/** Everything one load does together; past it the worker stops with a clear line (the startup probe allows two minutes). */
export const LOAD_DEADLINE_MS = 90_000;

/** The token the vault is read with: `FederatedCredential` has this shape. */
export interface VaultCredential {
  readonly clientId: string;
  /** Throws TokenError (with `transient`) when Entra ID gives no token. */
  token(scope: string, signal?: AbortSignal): Promise<string>;
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface KeyVaultOptions {
  readonly clock: Clock;
  readonly fetch?: typeof fetch;
  readonly logger?: Logger;
  /** The environment, only to name the settings the vault replaces that are set anyway. */
  readonly env?: Env;
  /** The wait between tries; default the clock's. */
  readonly sleep?: Sleep;
  readonly deadlineMs?: number;
}

type Attempt =
  { readonly value: string } | { readonly reason: string; readonly transient: boolean; readonly missing: boolean };

/** What one secret was read as: its value, and the vault entry it came from. */
interface Read {
  readonly value: string;
  readonly from: string;
}

const Dict = z.record(z.string(), z.unknown());
const SecretAnswer = z.object({ value: z.string() });

/** `x or {}` that must be a dict: undefined when it is something else (Python's AttributeError). */
function dictOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!pyTruthy(value)) return {};
  if (Array.isArray(value)) return undefined;
  const parsed = Dict.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** " (Forbidden: AccessDenied)": Key Vault's error code and inner code, which carry nothing secret; never its message. */
export function vaultErrorCode(text: string): string {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return ""; // not JSON: no code to show
  }
  const body = Array.isArray(json) ? undefined : Dict.safeParse(json).data;
  const error = body === undefined ? undefined : dictOf(body["error"]);
  const inner = error === undefined ? undefined : dictOf(error["innererror"]);
  if (error === undefined || inner === undefined) return "";
  const codes = [error["code"], inner["code"]].map((code) => cpSlice(pyStr(code), 0, 60)).filter(Boolean);
  return codes.length ? ` (${codes.join(": ")})` : "";
}

/** The stripped value of a 200 answer; an answer without a non-blank string value is a failure, not a retry. */
function secretValue(name: string, text: string): string {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined; // not JSON: no value
  }
  const parsed = SecretAnswer.safeParse(json);
  const value = parsed.success ? pyStrip(parsed.data.value) : "";
  if (!value) throw new SecretsUnavailable(`Key Vault secret ${name} is empty or has no value`);
  return value;
}

export class KeyVaultSecretSource implements SecretSource {
  readonly name = "keyvault";
  private readonly fetch: typeof fetch;
  private readonly logger: Logger;
  private readonly sleep: Sleep;

  /** `url`: a vault address `vaultUrl` accepted. */
  constructor(
    readonly url: string,
    private readonly credential: VaultCredential,
    private readonly options: KeyVaultOptions,
  ) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.logger = options.logger ?? silentLogger;
    this.sleep = options.sleep ?? ((ms, signal) => options.clock.sleep(ms, signal));
  }

  async load(names: readonly SecretName[]): Promise<ReadonlyMap<SecretName, string>> {
    const shadowed = shadowedSettings(this.options.env ?? {}, names);
    if (shadowed.length) {
      this.logger.warn(
        `secrets: SECRETS_SOURCE=keyvault, so ${shadowed.join(", ")} from the environment ` +
          `${shadowed.length === 1 ? "is" : "are"} ignored`,
      );
    }
    const deadlineMs = this.options.deadlineMs ?? LOAD_DEADLINE_MS;
    const deadline = startTimer(this.options.clock, deadlineMs, "the secrets were not read in time");
    let values: Map<SecretName, Read>;
    try {
      values = await raceAbort(deadline.signal, this.readAll(names, deadline.signal));
    } catch (error) {
      if (error instanceof DeadlineError && deadline.signal.aborted) {
        throw new SecretsUnavailable(
          `Key Vault ${vaultHost(this.url)}: the secrets were not read within ${String(deadlineMs / 1000)}s`,
        );
      }
      throw error;
    } finally {
      deadline.dispose();
    }
    const legacy = names.filter((name) => values.get(name)?.from === LEGACY_VAULT_NAMES[name]);
    if (legacy.length) {
      this.logger.warn(
        `secrets: deprecated Key Vault secret names: ${legacy.map((n) => `${LEGACY_VAULT_NAMES[n]} (now ${VAULT_NAMES[n]})`).join(", ")}; ` +
          "they are still read when the new name is missing; store the secrets under the new names",
      );
    }
    this.logger.info(
      `secrets: ${String(values.size)} read from Key Vault ${vaultHost(this.url)} as client ` +
        `${this.credential.clientId} (${[...values.values()].map((r) => r.from).join(", ")})`,
    );
    return new Map([...values].map(([name, r]) => [name, r.value]));
  }

  private async readAll(names: readonly SecretName[], signal: AbortSignal): Promise<Map<SecretName, Read>> {
    const token = await this.token(signal);
    const values = new Map<SecretName, Read>();
    for (const name of names) values.set(name, await this.readSecret(name, token, signal));
    return values;
  }

  /** A secret under its name, else (the vault has no such entry) under its deprecated name; never written under either. */
  private async readSecret(name: SecretName, token: string, signal: AbortSignal): Promise<Read> {
    const current = VAULT_NAMES[name];
    const legacy = LEGACY_VAULT_NAMES[name];
    const found = await this.read(current, token, signal);
    if (typeof found === "string") return { value: found, from: current };
    const old = await this.read(legacy, token, signal);
    if (typeof old === "string") return { value: old, from: legacy };
    throw new SecretsUnavailable(
      `Key Vault secret ${current}: ${found.missing} (nor under its deprecated name ${legacy})`,
    );
  }

  private async token(signal: AbortSignal): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.credential.token(KEYVAULT_SCOPE, signal);
      } catch (error) {
        if (!(error instanceof TokenError)) throw error;
        if (!error.transient || attempt === ATTEMPTS) {
          throw new SecretsUnavailable(
            `no Key Vault token for the worker identity ${this.credential.clientId}: ${error.message}`,
          );
        }
        this.logger.warn(
          `secrets: Key Vault token attempt ${String(attempt)} of ${String(ATTEMPTS)} failed (${error.message}); ` +
            "trying again",
        );
      }
      await this.sleep(BACKOFF_MS * 2 ** (attempt - 1), signal);
    }
  }

  /** `name`'s value, or why not when the vault has no such secret (it answered 404). */
  private async read(name: string, token: string, signal: AbortSignal): Promise<string | { readonly missing: string }> {
    const target = `${this.url}/secrets/${pyQuote(name, "")}?api-version=${KEYVAULT_API_VERSION}`;
    for (let attempt = 1; ; attempt++) {
      const answer = await this.readOnce(target, name, token, signal);
      if ("value" in answer) return answer.value;
      if (answer.missing) return { missing: answer.reason };
      if (!answer.transient || attempt === ATTEMPTS) {
        throw new SecretsUnavailable(`Key Vault secret ${name}: ${answer.reason}`);
      }
      this.logger.warn(
        `secrets: reading ${name}, attempt ${String(attempt)} of ${String(ATTEMPTS)} failed (${answer.reason}); ` +
          "trying again",
      );
      await this.sleep(BACKOFF_MS * 2 ** (attempt - 1), signal);
    }
  }

  private async readOnce(target: string, name: string, token: string, signal: AbortSignal): Promise<Attempt> {
    const timer = startTimer(this.options.clock, KEYVAULT_TIMEOUT_MS, "Key Vault timed out", signal);
    let status: number;
    let text: string;
    try {
      const response = await this.fetch(target, {
        headers: { authorization: `Bearer ${token}` },
        redirect: "manual",
        signal: timer.signal,
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      return { reason: `Key Vault unreachable (${errorName(error)})`, transient: true, missing: false };
    } finally {
      timer.dispose();
    }
    if (status === 200) return { value: secretValue(name, text) };
    return {
      reason: `Key Vault answered ${String(status)}${vaultErrorCode(text)}`,
      transient: status === 429 || status >= 500,
      missing: status === 404,
    };
  }
}

export interface KeyVaultEnvOptions extends Omit<KeyVaultOptions, "env"> {
  /** The Entra ID token endpoint; default the tenant's. */
  readonly tokenUrl?: string;
}

/**
 * The Key Vault source for SECRETS_SOURCE=keyvault: KEYVAULT_URL checked, the worker identity from the environment and
 * its key read now. Throws SecretsUnavailable naming the setting when one of them cannot work.
 */
export function keyVaultSourceFromEnv(env: Env, options: KeyVaultEnvOptions): KeyVaultSecretSource {
  const url = vaultUrl(env);
  let credential: FederatedCredential;
  try {
    const identity = workerIdentityFromEnv(env, "SECRETS_SOURCE=keyvault");
    credential = new FederatedCredential(identity, readWorkerKey(identity), {
      clock: options.clock,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.tokenUrl === undefined ? {} : { url: options.tokenUrl }),
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new SecretsUnavailable(error.message); // the setting and the reason; the cause stays out of the message
  }
  return new KeyVaultSecretSource(url, credential, { ...options, env });
}
