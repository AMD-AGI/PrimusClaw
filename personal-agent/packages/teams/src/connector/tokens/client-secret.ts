// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A token from Entra ID for an app registration's client secret (the OAuth client credentials grant): the most common
 * way to run a bot outside Azure, where neither a managed identity nor a federated credential is at hand. By default the
 * scope is the bot's Bot Connector scope.
 *
 * The secret goes into the token request's form and nowhere else: it is never logged, never part of an error message,
 * and hidden from `JSON.stringify` and `util.inspect` of the provider. A refusal by Entra (400/401: wrong tenant, client
 * id or secret, an expired secret) is not transient; a 429, a 5xx or a network error is. Errors name the AADSTS codes
 * only, never the description (it can echo the request).
 */
import { silentLogger, type Clock, type Logger } from "@primusclaw/personal-agent";
import { TokenError } from "../errors.js";
import { pyQuote } from "../py-parse.js";
import { CachedTokenProvider, parseTokenAnswer } from "./cached.js";
import { BOT_CONNECTOR_SCOPE, ENTRA_TIMEOUT_MS, ENTRA_TOKEN_HOST, entraCodes } from "./federated.js";
import { tokenRequest } from "./http.js";

export interface ClientSecretOptions {
  readonly clientId: string;
  readonly tenantId: string;
  readonly clientSecret: string;
  readonly clock: Clock;
  readonly fetch?: typeof fetch;
  readonly logger?: Logger;
  /** The token endpoint; default Entra ID's for the tenant. */
  readonly url?: string;
  readonly scope?: string;
}

export class ClientSecretTokenProvider extends CachedTokenProvider {
  readonly source = "secret";
  readonly scope: string;
  readonly clientId: string;
  readonly tenantId: string;
  readonly #secret: string;
  private readonly fetch: typeof fetch;
  private readonly logger: Logger;
  private readonly url: string;

  /** Throws (an Error naming the missing setting, never a value) rather than at the first token. */
  constructor(options: ClientSecretOptions) {
    super(options.clock);
    const named: [string, string][] = [
      ["client id", options.clientId],
      ["tenant id", options.tenantId],
      ["client secret", options.clientSecret],
    ];
    for (const [name, value] of named) {
      if (!value) throw new Error(`the client secret token needs the ${name}`);
    }
    this.clientId = options.clientId;
    this.tenantId = options.tenantId;
    this.#secret = options.clientSecret;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.logger = options.logger ?? silentLogger;
    this.url = options.url || `${ENTRA_TOKEN_HOST}/${pyQuote(options.tenantId, "")}/oauth2/v2.0/token`;
    this.scope = options.scope ?? BOT_CONNECTOR_SCOPE;
  }

  protected async fetchToken(signal?: AbortSignal): Promise<string> {
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.#secret,
      scope: this.scope,
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
      this.logger.info("bot connector token fetched with the client secret", { validForS: answer.expiresIn });
    } else {
      this.logger.info("token fetched with the client secret", {
        scope: this.scope,
        clientId: this.clientId,
        validForS: answer.expiresIn,
      });
    }
    return answer.token;
  }
}
