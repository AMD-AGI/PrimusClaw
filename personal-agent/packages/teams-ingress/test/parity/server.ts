// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The local server the parity cases' settings point at (`{base}`): the OpenID metadata, the JWKS and a
 * managed-identity token endpoint, each in the variants the cases name, recording every request it gets.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";

import { type KeyPair } from "../helpers.js";

type Reply = (status: number, body: unknown) => void;

function jwk(key: KeyPair, kid: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const { n, e } = key.jwk as { n: string; e: string };
  return { kty: "RSA", use: "sig", kid, n, e, ...extra };
}

function openid(variant: string, base: string, reply: Reply): void {
  if (variant === "openid500") reply(500, { error: "down" });
  else if (variant === "openidNoUri") reply(200, { issuer: "x" });
  else reply(200, { jwks_uri: `${base}/jwks/${variant}` });
}

const JWKS: Readonly<Record<string, (key: KeyPair, other: KeyPair) => [number, unknown]>> = {
  jwks500: () => [500, { error: "down" }],
  jwksEmpty: () => [200, { keys: [] }],
  jwksNotJson: () => [200, "<html>"],
  jwksEnc: (key) => [200, { keys: [jwk(key, "k1", { use: "enc" })] }],
  jwksTwo: (key, other) => [200, { keys: [jwk(other, "k2"), jwk(key, "k1")] }],
  jwksForeign: () => [
    200,
    {
      keys: [
        { kty: "EC", crv: "P-256", kid: "k1", x: "AA", y: "AA" },
        { kty: "oct", kid: "k3", k: "c2VjcmV0" },
      ],
    },
  ],
};

function msi(variant: string, reply: Reply): void {
  if (variant === "msi500") reply(500, { error: "down" });
  else if (variant === "msiNoToken") reply(200, { expires_in: 3600 });
  else if (variant === "msiExpiresOn") {
    reply(200, { access_token: "msi-token", expires_on: String(Math.trunc(Date.now() / 1000) + 3600) });
  } else if (variant === "msiStringExpiry") reply(200, { access_token: "msi-token", expires_in: "3599" });
  else reply(200, { access_token: "msi-token", expires_in: 3600 });
}

export interface ParityServer {
  /** http://127.0.0.1:<port> */
  readonly base: string;
  /** The requests since the last `take()`, as "METHOD /area/variant?query" (and the identity header, if any). */
  take(): string[];
  close(): Promise<void>;
}

export async function parityServer(key: KeyPair, other: KeyPair): Promise<ParityServer> {
  let seen: string[] = [];
  let base = "";
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", base);
    const [, area = "", variant = ""] = url.pathname.split("/");
    const header = req.headers["x-identity-header"];
    seen.push(`${req.method ?? "GET"} /${area}/${variant}${url.search}${header ? ` hdr=${String(header)}` : ""}`);
    const reply: Reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (area === "openid") openid(variant, base, reply);
    else if (area === "jwks" && variant === "jwksRedirect") {
      res.writeHead(302, { Location: `${base}/jwks/ok` });
      res.end();
    } else if (area === "jwks") {
      const answer = Object.hasOwn(JWKS, variant) ? JWKS[variant] : undefined;
      const [status, body] = answer?.(key, other) ?? [200, { keys: [jwk(key, "k1")] }];
      reply(status, body);
    } else if (area === "msi") msi(variant, reply);
    else reply(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    base,
    take: () => {
      const out = seen;
      seen = [];
      return out;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
