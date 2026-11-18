// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Bot Connector tokens for a bot that signs in as a user-assigned managed identity (the Python Function's bot_msi.py),
 * for the outbound trigger. The worker's own token sources (@primusclaw/personal-agent-teams) read IMDS or a federated
 * credential; a Function app's identity endpoint is IDENTITY_ENDPOINT with IDENTITY_HEADER, so this reads that first.
 *
 * No client secret: the Function App's assigned identity is the bot. The identity endpoint hands out a token for
 * `https://api.botframework.com`, which is what the Connector accepts as the bot's bearer.
 */
import { type Clock, type Env, type Fetch, SYSTEM_CLOCK } from "./env.js";
import { type Logger } from "./log.js";
import { get, int, isObject, type JsonObject, or, str, strip } from "./py.js";

const EXPIRY_MARGIN_SECONDS = 300;
const IMDS = "http://169.254.169.254/metadata/identity/oauth2/token";
const IMDS_API = "2019-08-01";
const RESOURCE = "https://api.botframework.com";
const TIMEOUT_MS = 15_000;

export class MsiTokenError extends Error {
  override name = "MsiTokenError";
}

/** Caches a Bot Connector token minted by the Function's managed identity. */
export class MsiTokenProvider {
  token: string | null = null;
  private expiresAt = 0;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly clientId: string,
    private readonly setting: string,
    private readonly env: Env,
    private readonly fetchImpl: Fetch,
    private readonly log: Logger,
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {}

  /** The cached token, or a new one; `log` is where a fetch reports it (the invocation's log). */
  async get(log: Logger = this.log): Promise<string> {
    if (this.token && this.clock.monotonic() < this.expiresAt) return this.token;
    // One fetch at a time, like the provider's lock.
    this.inflight ??= this.fetch(log).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  invalidate(): void {
    this.token = null;
    this.expiresAt = 0;
  }

  private async fetch(log: Logger): Promise<string> {
    if (!this.clientId) throw new MsiTokenError(`${this.setting} is not configured`);
    const endpoint = strip(this.env["IDENTITY_ENDPOINT"] ?? "");
    const header = strip(this.env["IDENTITY_HEADER"] ?? "");
    const payload = endpoint && header ? await this.fromAppService(endpoint, header) : await this.fromImds();
    const token = str(or(get(payload, "access_token"), ""));
    if (!token) throw new MsiTokenError("managed identity returned no access_token");
    let expiresIn = int(or(or(get(payload, "expires_in"), get(payload, "expires_on")), 3600));
    // App Service sometimes returns an absolute unix expires_on; normalize.
    if (expiresIn > 10_000) expiresIn = Math.max(Math.trunc(expiresIn - this.clock.time()), 60);
    this.token = token;
    this.expiresAt = this.clock.monotonic() + expiresIn - EXPIRY_MARGIN_SECONDS;
    log.info(`acquired bot connector token via managed identity for ${this.clientId}`);
    return token;
  }

  private async request(
    url: string,
    params: [string, string][],
    headers: Record<string, string>,
    failure: string,
  ): Promise<JsonObject> {
    const target = new URL(url);
    for (const [name, value] of params) target.searchParams.append(name, value);
    const response = await this.fetchImpl(target, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status !== 200) throw new MsiTokenError(`${failure} returned ${String(response.status)}`);
    const payload: unknown = JSON.parse(await response.text());
    // requests' .json() hands back whatever the document is; a non-object fails on .get(), as here.
    if (!isObject(payload)) throw new TypeError("the managed identity answer is not a JSON object");
    return payload;
  }

  private fromAppService(endpoint: string, header: string): Promise<JsonObject> {
    return this.request(
      endpoint,
      [
        ["resource", RESOURCE],
        ["client_id", this.clientId],
        ["api-version", "2019-08-01"],
      ],
      { "X-IDENTITY-HEADER": header },
      "IDENTITY_ENDPOINT",
    );
  }

  private fromImds(): Promise<JsonObject> {
    return this.request(
      IMDS,
      [
        ["api-version", IMDS_API],
        ["resource", RESOURCE],
        ["client_id", this.clientId],
      ],
      { Metadata: "true" },
      "IMDS",
    );
  }
}
