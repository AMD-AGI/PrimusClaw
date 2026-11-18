// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the parity cases are built with: the settings, a valid token and its variants, and the case makers. Every case
 * is pushed onto `cases` in the order it is made.
 */
import { createHmac, sign } from "node:crypto";

import { type KeyPair } from "../helpers.js";
import { type Case } from "./driver.js";

export interface Keys {
  key: KeyPair;
  otherKey: KeyPair;
  b64url: (data: Buffer | string) => string;
}

export const APP = "00000000-0000-0000-0000-0000000000a1";
export const SU = "https://smba.trafficmanager.net/teams/";
export const ISS = "https://api.botframework.com";
export const CONV = { id: "19:abc@thread.v2" };

const b64 = (data: string | Buffer): string => Buffer.from(data).toString("base64");

export class Kit {
  constructor(readonly keys: Keys) {}

  readonly now = () => Math.trunc(Date.now() / 1000);
  readonly jwtWith = (
    claims: Record<string, unknown> | string,
    opts: {
      key?: KeyPair;
      header?: Record<string, unknown> | string;
      alg?: "RS256" | "HS256" | "none";
      raw?: boolean;
    } = {},
  ) => {
    const header =
      typeof opts.header === "string"
        ? opts.header
        : JSON.stringify(
            Object.fromEntries(
              Object.entries<unknown>({ alg: opts.alg ?? "RS256", kid: "k1", typ: "JWT", ...opts.header }).filter(
                ([, v]) => v !== null,
              ),
            ),
          );
    const payload = typeof claims === "string" ? claims : JSON.stringify(claims);
    const input = `${this.keys.b64url(header)}.${this.keys.b64url(payload)}`;
    if (opts.alg === "none") return `${input}.`;
    if (opts.alg === "HS256") {
      const pem = (opts.key ?? this.keys.key).publicKey.export({ format: "pem", type: "spki" });
      return `${input}.${this.keys.b64url(createHmac("sha256", pem).update(input).digest())}`;
    }
    return `${input}.${this.keys.b64url(sign("RSA-SHA256", Buffer.from(input), (opts.key ?? this.keys.key).privateKey))}`;
  };
  readonly claims = (overrides: Record<string, unknown> = {}) =>
    Object.fromEntries(
      Object.entries<unknown>({ iss: ISS, aud: APP, exp: this.now() + 600, serviceurl: SU, ...overrides }).filter(
        ([, v]) => v !== null,
      ),
    );
  readonly tok = (overrides: Record<string, unknown> = {}, opts: Parameters<Kit["jwtWith"]>[1] = {}) =>
    this.jwtWith(this.claims(overrides), opts);
  readonly bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  readonly httpEnv: Record<string, string> = {
    PRIMUSCLAW_BOT_APP_ID: APP,
    PRIMUSCLAW_SERVICEBUS_CONNECTION_STRING: "cs-in",
    BOT_OPENID_CONFIG_URL: "{base}/openid/ok",
  };
  readonly outEnv: Record<string, string> = {
    ...this.httpEnv,
    PRIMUSCLAW_OUTBOUND_SERVICEBUS: "cs-out",
    IDENTITY_ENDPOINT: "{base}/msi/ok",
    IDENTITY_HEADER: "hdr",
  };
  readonly message = (extra: Record<string, unknown> = {}) => ({
    type: "message",
    id: "a1",
    serviceUrl: SU,
    conversation: CONV,
    ...extra,
  });
  readonly cases: Case[] = [];
  readonly http = (
    name: string,
    body: unknown,
    headers: Record<string, string> = this.bearer(this.tok()),
    extra: Partial<Case> = {},
  ) =>
    this.cases.push({
      name,
      kind: "http",
      env: extra.env ?? this.httpEnv,
      headers: { "x-correlation-id": "corr-1", ...headers },
      body: Buffer.isBuffer(body)
        ? body.toString("base64")
        : b64(typeof body === "string" ? body : JSON.stringify(body)),
      ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "env")),
    });
  readonly outbound = (name: string, envelope: unknown, extra: Partial<Case> = {}) =>
    this.cases.push({
      name: `outbound: ${name}`,
      kind: "outbound",
      env: extra.env ?? this.outEnv,
      body: Buffer.isBuffer(envelope)
        ? envelope.toString("base64")
        : b64(typeof envelope === "string" ? envelope : JSON.stringify(envelope)),
      ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "env")),
    });
  readonly t = (name: string, token: string, env?: Record<string, string>, activity: unknown = this.message()) =>
    this.http(
      `token: ${name}`,
      activity,
      { ...this.bearer(token), "X-Forwarded-For": "198.51.100.9, 203.0.113.7:51234" },
      env ? { env } : {},
    );
  readonly keyEnv = (variant: string) => ({ ...this.httpEnv, BOT_OPENID_CONFIG_URL: `{base}/openid/${variant}` });
  readonly extended = {
    ...this.httpEnv,
    BOT_SERVICE_URL_HOSTS: "smba.trafficmanager.net; bots.contoso.example",
    BOT_SERVICE_URL_SUFFIXES: "*.botframework.com,.teams.contoso.example",
  };
  readonly NS = "example-bus.servicebus.windows.net";
  readonly SAS = `Endpoint=sb://${this.NS}/;SharedAccessKeyName=fn-send;SharedAccessKey=not-a-real-key`;
  readonly sb = (name: string, env: Record<string, string>) =>
    this.http(`service bus: ${name}`, this.message(), this.bearer(this.tok()), {
      env: { BOT_OPENID_CONFIG_URL: "{base}/openid/ok", PRIMUSCLAW_BOT_APP_ID: APP, ...env },
    });
  readonly card = { type: "invoke", name: "adaptiveCard/action", id: "c1", serviceUrl: SU, conversation: CONV };
  readonly feedback = { type: "invoke", name: "message/submitAction", id: "f1", serviceUrl: SU, conversation: CONV };
  readonly REF = {
    serviceUrl: "https://smba.trafficmanager.net/teams",
    conversation: CONV,
    bot: { id: "28:bot" },
    user: { id: "29:user" },
    activityId: "reply-to-1",
    channelId: "msteams",
  };
  readonly envelopes: [string, unknown][] = [
    ["reference a list", { reference: [1], activity: {} }],
    ["activity a list", { reference: this.REF, activity: [1] }],
    ["no reference", { activity: {} }],
    ["reference without serviceUrl", { reference: { conversation: CONV }, activity: {} }],
    ["reference without conversation", { reference: { serviceUrl: this.REF.serviceUrl }, activity: {} }],
    ["conversation a string", { reference: { serviceUrl: this.REF.serviceUrl, conversation: "19:abc" }, activity: {} }],
    ["update without activity_id", { operation: "update", reference: this.REF, activity: {} }],
    ["reference empty", { reference: {}, activity: {} }],
    ["activity null", { reference: this.REF, activity: null }],
    ["reference a string", { reference: "x", activity: {} }],
  ];
  readonly msi = (variant: string) => ({ ...this.outEnv, IDENTITY_ENDPOINT: `{base}/msi/${variant}` });
}
