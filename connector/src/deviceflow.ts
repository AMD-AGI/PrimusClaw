// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** RFC 8628 device authorization grant, the client side. */
import { DEFAULT_CLIENT_ID, parseTokenResponse, type TokenResponse } from "./credentials.js";
import { errMessage, isObject, secureUrl, sleep } from "./util.js";

export class DeviceFlowError extends Error {
  constructor(readonly code: "access_denied" | "expired_token" | "unreachable" | "protocol", message: string) { super(message); }
}

export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export interface DeviceFlowOptions {
  identityUrl: string;
  deviceName: string;
  clientId?: string;
  scope?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  print?: (line: string) => void;
  signal?: AbortSignal;
}

const form = (o: Record<string, string>) => new URLSearchParams(o);

export async function startDeviceAuthorization(o: DeviceFlowOptions): Promise<DeviceAuthorization> {
  secureUrl(o.identityUrl, "the identity service URL");
  const f = o.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(`${o.identityUrl}/oauth/device_authorization`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form({ client_id: o.clientId ?? DEFAULT_CLIENT_ID, ...(o.scope ? { scope: o.scope } : {}), device_name: o.deviceName }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new DeviceFlowError("unreachable", `could not reach the identity service: ${errMessage(e)}`);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok || !isObject(body) || typeof body.device_code !== "string" || typeof body.user_code !== "string" || typeof body.verification_uri !== "string") {
    const why = isObject(body) && typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new DeviceFlowError("protocol", `the identity service refused the sign-in request (${why})`);
  }
  return {
    device_code: body.device_code, user_code: body.user_code, verification_uri: body.verification_uri,
    verification_uri_complete: typeof body.verification_uri_complete === "string" ? body.verification_uri_complete : undefined,
    expires_in: typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 600,
    interval: typeof body.interval === "number" && body.interval > 0 ? body.interval : 5,
  };
}

/** Poll the token endpoint at the server's interval until the user confirms, refuses, or the code expires. */
export async function pollDeviceToken(o: DeviceFlowOptions, auth: DeviceAuthorization): Promise<TokenResponse> {
  const f = o.fetch ?? fetch;
  const wait = o.sleep ?? sleep;
  const now = o.now ?? Date.now;
  const deadline = now() + auth.expires_in * 1000;
  let interval = auth.interval;
  let unreachable = 0;
  for (;;) {
    await wait(interval * 1000, o.signal);
    if (o.signal?.aborted) throw new DeviceFlowError("protocol", "sign-in cancelled");
    if (now() >= deadline) throw new DeviceFlowError("expired_token", "the code expired before it was confirmed; run login again");
    let res: Response;
    try {
      res = await f(`${o.identityUrl}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: form({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: auth.device_code, client_id: o.clientId ?? DEFAULT_CLIENT_ID }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      if (++unreachable >= 5) throw new DeviceFlowError("unreachable", `could not reach the identity service: ${errMessage(e)}`);
      continue;
    }
    // A server that keeps failing is given up on after five answers; only a real answer starts the count again.
    if (res.status >= 500) {
      if (++unreachable >= 5) throw new DeviceFlowError("unreachable", `the identity service keeps answering ${res.status}`);
      continue;
    }
    unreachable = 0;
    const body: unknown = await res.json().catch(() => null);
    if (res.ok) {
      const tok = parseTokenResponse(body);
      if (!tok || !tok.refresh_token) throw new DeviceFlowError("protocol", "the identity service answered a confirmed sign-in without a refresh token");
      return tok;
    }
    const err = isObject(body) && typeof body.error === "string" ? body.error : "";
    if (err === "authorization_pending") continue;
    if (err === "slow_down") { interval += 5; continue; }
    if (err === "access_denied") throw new DeviceFlowError("access_denied", "the sign-in was denied in the browser");
    if (err === "expired_token") throw new DeviceFlowError("expired_token", "the code expired before it was confirmed; run login again");
    throw new DeviceFlowError("protocol", `the identity service refused the sign-in (${err || `HTTP ${res.status}`})`);
  }
}

/** Run the whole flow, telling the user where to go. */
export async function deviceLogin(o: DeviceFlowOptions): Promise<TokenResponse> {
  const auth = await startDeviceAuthorization(o);
  const say = o.print ?? (() => {});
  say(`To connect this machine, open:  ${auth.verification_uri_complete ?? auth.verification_uri}`);
  if (auth.verification_uri_complete) say(`or open ${auth.verification_uri} and enter the code:  ${auth.user_code}`);
  else say(`and enter the code:  ${auth.user_code}`);
  say(`The code works for ${Math.round(auth.expires_in / 60)} minutes. Waiting for you to confirm...`);
  return pollDeviceToken(o, auth);
}
