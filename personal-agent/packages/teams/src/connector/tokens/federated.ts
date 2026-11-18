// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A token from Entra ID by workload identity federation: the worker signs a short assertion with its own key and trades
 * it for the managed identity's token (client credentials with a client assertion). Nothing has to be attached to the
 * node. By default the scope is the bot's Bot Connector scope; the worker's own identity uses the same exchange for Key
 * Vault and Service Bus (`azure/workload-identity.ts`).
 *
 * A refusal by Entra (400/401: the federated credential, issuer, subject or key does not match) is not transient; a 429,
 * a 5xx or a network error is. Errors name the AADSTS codes only, never the description (it can echo the request).
 */
import { z } from "zod";
import { cpHead, pyStr, silentLogger, type Clock, type Logger } from "@primusclaw/personal-agent";
import { TokenError } from "../errors.js";
import { pyInt, pyQuote, pyTruthy } from "../py-parse.js";
import { ASSERTION_TYPE, loadAssertionKey, signAssertion, type AssertionKey } from "./assertion.js";
import { CachedTokenProvider, parseTokenAnswer } from "./cached.js";
import { tokenRequest } from "./http.js";

export const ENTRA_TOKEN_HOST = "https://login.microsoftonline.com";
export const BOT_CONNECTOR_SCOPE = "https://api.botframework.com/.default";
export const ENTRA_TIMEOUT_MS = 10_000;

export interface FederatedOptions {
  readonly clientId: string;
  readonly tenantId: string;
  /** The PEM of the RSA key that signs the assertion. */
  readonly keyPem: string | Uint8Array;
  /** The https issuer registered in the federated credential. */
  readonly issuer: string;
  readonly subject: string;
  readonly clock: Clock;
  readonly fetch?: typeof fetch;
  readonly logger?: Logger;
  /** The token endpoint; default Entra ID's for the tenant. */
  readonly url?: string;
  readonly scope?: string;
}

export class FederatedTokenProvider extends CachedTokenProvider {
  readonly source = "federated";
  readonly scope: string;
  private readonly signer: AssertionKey;
  private readonly fetch: typeof fetch;
  private readonly logger: Logger;
  private readonly url: string;

  /** Throws (AssertionKeyError for the key, Error for a missing or non-https setting) rather than at the first token. */
  constructor(private readonly options: FederatedOptions) {
    super(options.clock);
    const named: [string, string][] = [
      ["client id", options.clientId],
      ["tenant id", options.tenantId],
      ["issuer", options.issuer],
      ["subject", options.subject],
    ];
    for (const [name, value] of named) {
      if (!value) throw new Error(`the federated token needs the ${name}`);
    }
    if (!options.issuer.startsWith("https://")) throw new Error("the assertion issuer must be an https URL");
    this.signer = loadAssertionKey(options.keyPem);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.logger = options.logger ?? silentLogger;
    this.url = options.url || `${ENTRA_TOKEN_HOST}/${pyQuote(options.tenantId, "")}/oauth2/v2.0/token`;
    this.scope = options.scope ?? BOT_CONNECTOR_SCOPE;
  }

  get keyId(): string {
    return this.signer.kid;
  }

  get clientId(): string {
    return this.options.clientId;
  }

  /** A fresh signed assertion. */
  assertion(): string {
    const { issuer, subject } = this.options;
    return signAssertion(this.signer, { issuer, subject, now: this.clock.epochMs() / 1000 });
  }

  protected async fetchToken(signal?: AbortSignal): Promise<string> {
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.options.clientId,
      scope: this.scope,
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: this.assertion(),
    });
    const { status, text } = await tokenRequest(
      { fetch: this.fetch, clock: this.clock },
      "Entra ID",
      this.url,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() },
      ENTRA_TIMEOUT_MS,
      signal,
    );
    if (status !== 200) {
      throw new TokenError(`Entra ID answered ${String(status)}${entraCodes(text)}`, status === 429 || status >= 500);
    }
    const answer = parseTokenAnswer(text);
    if (answer === undefined) throw new TokenError("Entra ID answered without a usable token");
    this.keep(answer.token, answer.expiresIn);
    if (this.scope === BOT_CONNECTOR_SCOPE) {
      this.logger.info("bot connector token fetched by workload identity federation", { validForS: answer.expiresIn });
    } else {
      this.logger.info("token fetched by workload identity federation", {
        scope: this.scope,
        clientId: this.options.clientId,
        validForS: answer.expiresIn,
      });
    }
    return answer.token;
  }
}

const EntraError = z.object({ error: z.unknown().optional(), error_codes: z.unknown().optional() });

/**
 * " (error: AADSTS1,AADSTS2)" from an Entra error answer: its `error` and up to three `error_codes`, which say what did
 * not match and carry nothing secret. "" when it has neither or is not the expected JSON.
 */
export function entraCodes(text: string): string {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return ""; // not JSON: no codes to show
  }
  const parsed = EntraError.safeParse(json);
  if (!parsed.success) return "";
  const raw = parsed.data.error_codes;
  // `payload.get("error_codes") or []`: a missing or empty value is no codes, anything but a list is not readable
  const list: unknown[] | undefined = Array.isArray(raw) ? raw : pyTruthy(raw) ? undefined : [];
  if (list === undefined) return "";
  const codes = list.map(pyInt);
  if (codes.some((code) => code === undefined)) return "";
  const error = pyStr(parsed.data.error);
  const shown = codes
    .slice(0, 3)
    .map((code) => `AADSTS${String(code)}`)
    .join(",");
  if (!(codes.length || error)) return "";
  return ` (${cpHead(error, 40)}${error && shown ? ": " : ""}${shown})`;
}
