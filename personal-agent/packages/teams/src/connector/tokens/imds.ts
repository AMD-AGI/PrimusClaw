// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The bot's Bot Connector token from Azure IMDS: the node's managed identity is the bot, so there is no secret. Cached
 * until five minutes before it expires; concurrent callers share one fetch.
 */
import { silentLogger, type Clock, type Logger } from "@primusclaw/personal-agent";
import { TokenError } from "../errors.js";
import { CachedTokenProvider, parseTokenAnswer } from "./cached.js";
import { tokenRequest } from "./http.js";

export const BOT_CONNECTOR_RESOURCE = "https://api.botframework.com";
export const IMDS_TOKEN_URL = "http://169.254.169.254/metadata/identity/oauth2/token";
export const IMDS_API_VERSION = "2018-02-01";
export const IMDS_TIMEOUT_MS = 5_000;

export interface ImdsOptions {
  readonly clock: Clock;
  /** Default `globalThis.fetch` (which uses no proxy from the environment: IMDS is link-local and must never go through one). */
  readonly fetch?: typeof fetch;
  readonly logger?: Logger;
  readonly url?: string;
}

export class ImdsTokenProvider extends CachedTokenProvider {
  readonly source = "imds";
  private readonly fetch: typeof fetch;
  private readonly logger: Logger;
  private readonly url: string;

  constructor(
    private readonly clientId: string,
    options: ImdsOptions,
  ) {
    super(options.clock);
    if (!clientId) throw new Error("the managed identity's client id is required");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.logger = options.logger ?? silentLogger;
    this.url = options.url ?? IMDS_TOKEN_URL;
  }

  protected async fetchToken(signal?: AbortSignal): Promise<string> {
    const query = new URLSearchParams({
      "api-version": IMDS_API_VERSION,
      resource: BOT_CONNECTOR_RESOURCE,
      client_id: this.clientId,
    });
    const { status, text } = await tokenRequest(
      { fetch: this.fetch, clock: this.clock },
      "IMDS",
      `${this.url}?${query.toString()}`,
      { method: "GET", headers: { Metadata: "true" } },
      IMDS_TIMEOUT_MS,
      signal,
    );
    if (status !== 200) {
      throw new TokenError(`IMDS answered ${String(status)}`, [404, 410, 429].includes(status) || status >= 500);
    }
    const answer = parseTokenAnswer(text);
    if (answer === undefined) throw new TokenError("IMDS answered without a usable token");
    this.keep(answer.token, answer.expiresIn);
    this.logger.info("bot connector token fetched from IMDS", { validForS: answer.expiresIn });
    return answer.token;
  }
}
