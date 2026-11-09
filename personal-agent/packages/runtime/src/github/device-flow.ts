// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * RFC 8628 against github.com with a public client (no secret); the scope asked for is always `repo`. Nothing GitHub
 * answers is kept but the fields read: a failure is only its reason, never a body, a code or a token.
 */

import {
  type Clock,
  type DeviceCode,
  type DeviceFlow,
  type DeviceFlowCancelled,
  type DeviceFlowFailed,
  type Result,
  SCOPE,
  err,
  ok,
} from "@primusclaw/personal-agent";
import { z } from "zod";

import type { FetchLike } from "./api.js";

export const DEVICE_CODE_URL = "https://github.com/login/device/code";
export const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const DEVICE_PAGE_HOST = "github.com";
/** What GitHub's slow_down adds to the polling interval (RFC 8628 section 3.5). */
const SLOW_DOWN_SECONDS = 5;
export const MAX_DEVICE_WAIT_SECONDS = 15 * 60;

const int = z.number().int().positive();
const started = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string(),
  expires_in: int,
  interval: int.optional().default(5),
});
const polled = z.object({
  error: z.unknown().optional(),
  interval: z.unknown().optional(),
  access_token: z.unknown().optional(),
});

const failed = (reason: DeviceFlowFailed["reason"]): Result<never, DeviceFlowFailed> =>
  err({ kind: "device_flow_failed", reason });
const cancelled = (): Result<never, DeviceFlowCancelled> => err({ kind: "device_flow_cancelled" });

function githubPage(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === "https:" && url.hostname.toLowerCase() === DEVICE_PAGE_HOST;
  } catch {
    return false;
  }
}

export interface DeviceFlowOptions {
  readonly clientId: string;
  readonly clock: Clock;
  readonly fetch?: FetchLike;
}

export class GithubDeviceFlow implements DeviceFlow {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: DeviceFlowOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  private async post(url: string, form: Readonly<Record<string, string>>): Promise<{ status: number; body: unknown }> {
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, body: await response.json() };
  }

  async start(): Promise<Result<DeviceCode, DeviceFlowFailed>> {
    let answer: { status: number; body: unknown };
    try {
      answer = await this.post(DEVICE_CODE_URL, { client_id: this.options.clientId, scope: SCOPE });
    } catch {
      return failed("unavailable");
    }
    const parsed = started.safeParse(answer.status === 200 ? answer.body : {});
    // (the page a person is sent to is GitHub's)
    if (!parsed.success || !githubPage(parsed.data.verification_uri)) return failed("unavailable");
    const data = parsed.data;
    return ok({
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      expiresIn: data.expires_in,
      interval: data.interval,
    });
  }

  /**
   * Polls until the person approves: the token, or why not. Honours `interval` and `slow_down`; gives up when the code runs
   * out (or after MAX_DEVICE_WAIT_SECONDS, whichever is first).
   */
  async waitForToken(
    code: DeviceCode,
    signal?: AbortSignal,
  ): Promise<Result<string, DeviceFlowFailed | DeviceFlowCancelled>> {
    const clock = this.options.clock;
    const deadline = clock.monotonicMs() + Math.min(code.expiresIn, MAX_DEVICE_WAIT_SECONDS) * 1000;
    let interval = code.interval;
    for (;;) {
      try {
        await clock.sleep(interval * 1000, signal);
      } catch {
        return cancelled();
      }
      if (clock.monotonicMs() >= deadline) return failed("expired");
      const step = await this.poll(code);
      if (step.kind === "wait") continue;
      if (step.kind === "slower") {
        interval = step.interval > interval ? step.interval : interval + SLOW_DOWN_SECONDS;
        continue;
      }
      return step.result;
    }
  }

  private async poll(
    code: DeviceCode,
  ): Promise<
    { kind: "wait" } | { kind: "slower"; interval: number } | { kind: "done"; result: Result<string, DeviceFlowFailed> }
  > {
    let answer: { status: number; body: unknown };
    try {
      answer = await this.post(ACCESS_TOKEN_URL, {
        client_id: this.options.clientId,
        device_code: code.deviceCode,
        grant_type: DEVICE_GRANT,
      });
    } catch {
      return { kind: "done", result: failed("unavailable") };
    }
    const parsed = polled.safeParse(answer.body);
    if (!parsed.success) return { kind: "done", result: failed("unavailable") };
    const { error, interval, access_token: token } = parsed.data;
    if (error === "authorization_pending") return { kind: "wait" };
    if (error === "slow_down") {
      return { kind: "slower", interval: typeof interval === "number" && Number.isInteger(interval) ? interval : 0 };
    }
    if (error === "expired_token") return { kind: "done", result: failed("expired") };
    if (error === "access_denied") return { kind: "done", result: failed("denied") };
    if (error || answer.status !== 200 || typeof token !== "string" || !token) {
      return { kind: "done", result: failed("unavailable") };
    }
    return { kind: "done", result: ok(token) };
  }
}
