// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One webhook POST: pinned address, no redirects, short timeout, and the
 * response body is neither read nor kept.
 */
import http from "node:http";
import https from "node:https";
import type { GuardResult } from "./url-guard.js";

/** The whole exchange, connect to status line, not an idle gap: a receiver that
 *  trickles a byte at a time must not be able to hold a delivery open. */
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
    }, (res) => {
      // Only the status matters; drop the body unread, and the connection with it.
      clearTimeout(deadline);
      const code = res.statusCode ?? 0;
      res.destroy();
      resolve(code);
    });
    const deadline = setTimeout(() => req.destroy(new Error("deadline")), timeoutMs ?? DELIVERY_TIMEOUT_MS);
    req.on("error", (err) => { clearTimeout(deadline); reject(err); });
    req.end(body);
  });
