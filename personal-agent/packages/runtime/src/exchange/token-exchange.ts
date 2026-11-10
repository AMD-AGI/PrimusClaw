// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import {
  err,
  errorName,
  ok,
  type BindingRequest,
  type Clock,
  type ExchangeError,
  type ExchangeFailed,
  type ExchangeSettings,
  type ExchangeUnavailable,
  type Result,
  type TokenExchange,
} from "@primusclaw/personal-agent";
import { z } from "zod";
import { PerKeySerial } from "./serial.js";

export const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
export const USER_REF = "urn:primus:params:oauth:token-type:user-ref";
export const ACCESS_TOKEN = "urn:ietf:params:oauth:token-type:access_token";
/** A token with less than this left is never handed out. */
export const REFRESH_MARGIN_SECONDS = 60;
/** How long "not bound" is remembered, so chatter does not hammer the identity service. */
export const NOT_BOUND_TTL_SECONDS = 15;
/** A confirm link with less than this left is not handed out again. */
export const REQUEST_MARGIN_SECONDS = 60;

/** The exchange's answer; anything else (or a non-object) is a failed exchange. */
const exchanged = z.looseObject({ access_token: z.string().min(1), expires_in: z.number() });
/** The binding request's answer: an https link and its lifetime in whole seconds. */
const bindingAnswer = z.looseObject({
  confirm_url: z.string().refine((url) => /^https:/iu.test(url)),
  expires_in: z.number().int().positive(),
});

type Fetch = typeof fetch;

/** The JSON object of an answer ({} when it is not one). */
/** How long an exchange or a binding request may take, answer included. */
export const EXCHANGE_TIMEOUT_MS = 30_000;

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return objectIn(await textOf(response));
}

async function textOf(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * Whether the answer writes `expires_in` as a whole number (`600`), as Python's `isinstance(v, int)` reads its JSON:
 * `600.0` and `6e2` parse to the same JavaScript number but are floats to Python, and refused.
 */
function writtenAsInt(text: string): boolean {
  return /"expires_in"\s*:\s*-?\d+\s*[,}]/u.test(text);
}

function objectIn(text: string): Record<string, unknown> {
  try {
    const body: unknown = JSON.parse(text);
    return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Only the status and the OAuth error code are kept: the body may carry a token, and is not ours to log or show. */
function failed(what: string, status: number, body: Record<string, unknown>): ExchangeFailed {
  const code = body["error"];
  // Only an OAuth error word ("invalid_client"): anything else in that field may be what it should not be (a token).
  const word = typeof code === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(code) ? code : "";
  return { kind: "exchange_failed", reason: `${what} failed: ${String(status)} ${word}` };
}

const unreachable = (what: string, error: unknown): ExchangeFailed => ({
  kind: "exchange_failed",
  reason: `${what} endpoint unreachable: ${errorName(error)}`,
});

/**
 * Short-lived tokens from the identity service's OAuth 2.0 token exchange (RFC 8693). The worker is a service client:
 * for a channel user with a confirmed binding (issuer + their user id) it trades its own client credentials for a token
 * that acts as that person for about 10 minutes. Nothing long-lived is kept. A user with no binding gets `not_bound`
 * (remembered briefly) and is offered a binding request: a one-time link they open, sign in at and confirm once.
 */
export class HttpTokenExchange implements TokenExchange {
  readonly enabled = true;
  /** user -> (token, usable until) */
  private readonly tokens = new Map<string, { token: string; until: number }>();
  /** user -> remembered until */
  private readonly unbound = new Map<string, number>();
  /** user -> (open binding request, usable until) */
  private readonly requests = new Map<string, { request: BindingRequest; until: number }>();
  private readonly exchanges = new PerKeySerial();
  private readonly bindings = new PerKeySerial();
  private readonly authorization: string;

  constructor(
    private readonly settings: ExchangeSettings,
    private readonly clock: Clock,
    private readonly fetchFn: Fetch = fetch,
    /** The whole call, answer included (the Python worker's HTTP client had 30 s). */
    private readonly timeoutMs: number = EXCHANGE_TIMEOUT_MS,
  ) {
    this.authorization = `Basic ${Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString("base64")}`;
  }

  private now(): number {
    return this.clock.monotonicMs() / 1000;
  }

  invalidate(userId: string): void {
    this.tokens.delete(userId);
    this.unbound.delete(userId);
  }

  private cachedToken(userId: string): string | undefined {
    const cached = this.tokens.get(userId);
    return cached !== undefined && cached.until > this.now() ? cached.token : undefined;
  }

  /** A token acting as the person bound to `userId` (one exchange in flight per user). */
  async tokenFor(userId: string): Promise<Result<string, ExchangeError>> {
    const cached = this.cachedToken(userId);
    if (cached !== undefined) return ok(cached);
    if ((this.unbound.get(userId) ?? 0) > this.now()) return err({ kind: "not_bound" });
    return this.exchanges.run(userId, async () => {
      const again = this.cachedToken(userId);
      return again !== undefined ? ok(again) : this.exchange(userId);
    });
  }

  private async exchange(userId: string): Promise<Result<string, ExchangeError>> {
    const s = this.settings;
    const form = new URLSearchParams({
      grant_type: GRANT_TYPE,
      subject_token: `external:${s.issuer}|${userId}`,
      subject_token_type: USER_REF,
      audience: s.audience,
      scope: s.scope,
      requested_token_type: ACCESS_TOKEN,
    });
    let response: Response;
    try {
      response = await this.fetchFn(s.tokenUrl, {
        method: "POST",
        body: form,
        headers: { authorization: this.authorization },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "manual",
      });
    } catch (error) {
      return err(unreachable("token", error));
    }
    const body = await jsonOf(response);
    if (response.status === 400 && body["error"] === "invalid_grant") {
      this.unbound.set(userId, this.now() + NOT_BOUND_TTL_SECONDS);
      return err({ kind: "not_bound" });
    }
    const parsed = exchanged.safeParse(body);
    if (response.status !== 200 || !parsed.success) return err(failed("token exchange", response.status, body));
    const usableFor = parsed.data.expires_in - REFRESH_MARGIN_SECONDS;
    if (usableFor > 0) this.tokens.set(userId, { token: parsed.data.access_token, until: this.now() + usableFor });
    this.unbound.delete(userId);
    this.requests.delete(userId); // bound: the link has been used
    return ok(parsed.data.access_token);
  }

  private cachedRequest(userId: string): BindingRequest | undefined {
    const cached = this.requests.get(userId);
    return cached !== undefined && cached.until > this.now() ? cached.request : undefined;
  }

  /**
   * The confirm link for `userId`. A newer request withdraws the older link at the identity service, so the one still
   * open is handed out again. `email`, when the channel supplied one, restricts who can confirm it.
   */
  async bindingRequest(
    userId: string,
    email = "",
  ): Promise<Result<BindingRequest, ExchangeFailed | ExchangeUnavailable>> {
    const cached = this.cachedRequest(userId);
    if (cached !== undefined) return ok(cached);
    return this.bindings.run(userId, async () => {
      const again = this.cachedRequest(userId);
      return again !== undefined ? ok(again) : this.requestBinding(userId, email);
    });
  }

  /** The binding endpoint: as configured, else beside the token endpoint (.../oauth/token -> .../oauth/binding-requests). */
  bindingUrl(): string {
    const s = this.settings;
    return s.bindingRequestUrl || `${s.tokenUrl.slice(0, Math.max(s.tokenUrl.lastIndexOf("/"), 0))}/binding-requests`;
  }

  private async requestBinding(userId: string, email: string): Promise<Result<BindingRequest, ExchangeFailed>> {
    const s = this.settings;
    const payload = { issuer: s.issuer, subject: userId, ...(email ? { expected_email: email } : {}) };
    let response: Response;
    try {
      response = await this.fetchFn(this.bindingUrl(), {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { authorization: this.authorization, "content-type": "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "manual",
      });
    } catch (error) {
      return err(unreachable("binding", error));
    }
    const text = await textOf(response);
    const body = objectIn(text);
    const parsed = bindingAnswer.safeParse(body);
    if (response.status !== 200 || !parsed.success || !writtenAsInt(text)) {
      return err(failed("binding request", response.status, body));
    }
    const request: BindingRequest = { confirmUrl: parsed.data.confirm_url, expiresInSeconds: parsed.data.expires_in };
    if (request.expiresInSeconds > REQUEST_MARGIN_SECONDS) {
      this.requests.set(userId, { request, until: this.now() + request.expiresInSeconds - REQUEST_MARGIN_SECONDS });
    }
    return ok(request);
  }
}
