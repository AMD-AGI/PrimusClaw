// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One webhook POST: pinned address, no redirects, short timeout, and the
 * response body is neither read nor kept.
 */
import http from "node:http";
import https from "node:https";
import type { GuardResult } from "./url-guard.js";

export const DELIVERY_TIMEOUT_MS = 5000;

export interface OutboundRequest {
  target: Extract<GuardResult, { ok: true }>;
  headers: Record<string, string>;
  body: string;
  timeoutMs?: number;
}

/** Resolves with the HTTP status, rejects on a connection error or timeout. */
export type Transport = (req: OutboundRequest) => Promise<number>;

export const httpTransport: Transport = ({ target, headers, body, timeoutMs }) =>
  new Promise<number>((resolve, reject) => {
    const { url } = target;
    const secure = url.protocol === "https:";
    const mod = secure ? https : http;
    const req = mod.request({
      host: target.address,
      family: target.family,
      port: url.port || (secure ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: "POST",
      servername: secure ? url.hostname : undefined,
      headers: {
        ...headers,
        host: url.host,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      },
      timeout: timeoutMs ?? DELIVERY_TIMEOUT_MS,
    }, (res) => {
      // Only the status matters; drop the body unread.
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
