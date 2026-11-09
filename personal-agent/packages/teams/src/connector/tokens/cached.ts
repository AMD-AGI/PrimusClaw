// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A bearer token cached until TOKEN_REFRESH_MARGIN before it expires; concurrent callers share one fetch. Subclasses
 * fetch (IMDS, Entra ID by federation); this module also reads a token endpoint's answer.
 */
import { z } from "zod";
import type { Clock } from "@primusclaw/personal-agent";
import { Lanes } from "../lanes.js";
import { pyInt } from "../py-parse.js";

/** A token is replaced this long before it expires. */
export const TOKEN_REFRESH_MARGIN_MS = 300_000;

/** What the outbox needs of the bot's token source. */
export interface TokenSource {
  /** The bearer token; throws TokenError. With `signal`, the wait and the fetch end when it aborts. */
  get(signal?: AbortSignal): Promise<string>;
  /** Forget `token` (the Connector refused it). A newer one another caller already fetched is kept. */
  invalidate(token: string): void;
  close(): Promise<void>;
}

export abstract class CachedTokenProvider implements TokenSource {
  private token = "";
  private expiresAt = 0;
  private readonly lock = new Lanes();

  protected constructor(protected readonly clock: Clock) {}

  async get(signal?: AbortSignal): Promise<string> {
    if (this.fresh()) return this.token;
    return this.lock.hold(
      "token",
      () => (this.fresh() ? Promise.resolve(this.token) : this.fetchToken(signal)),
      signal,
    );
  }

  /** Milliseconds the cached token is still handed out for (0 when there is none). */
  validForMs(): number {
    return this.token ? Math.max(this.expiresAt - this.clock.monotonicMs(), 0) : 0;
  }

  invalidate(token: string): void {
    if (this.token === token) {
      this.token = "";
      this.expiresAt = 0;
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  private fresh(): boolean {
    return this.token !== "" && this.clock.monotonicMs() < this.expiresAt;
  }

  /** Cache `token` for `expiresIn` seconds less the margin (half its life when it is short). */
  protected keep(token: string, expiresIn: number): void {
    const margin = TOKEN_REFRESH_MARGIN_MS / 1000;
    const keep = expiresIn > 2 * margin ? expiresIn - margin : Math.floor(expiresIn / 2);
    this.token = token;
    this.expiresAt = this.clock.monotonicMs() + Math.max(keep, 0) * 1000;
  }

  /** Fetch a token, `keep` it and return it; throws TokenError. */
  protected abstract fetchToken(signal?: AbortSignal): Promise<string>;
}

const TokenAnswer = z.object({ access_token: z.string().min(1), expires_in: z.unknown() });

/** The token and its lifetime in seconds from a token endpoint's JSON answer, or undefined when it has no usable token. */
export function parseTokenAnswer(text: string): { token: string; expiresIn: number } | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined; // not JSON: no usable token, which the caller reports
  }
  const parsed = TokenAnswer.safeParse(json);
  if (!parsed.success) return undefined;
  const expiresIn = pyInt(parsed.data.expires_in);
  return expiresIn === undefined ? undefined : { token: parsed.data.access_token, expiresIn };
}
