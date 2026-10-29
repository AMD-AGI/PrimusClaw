// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A stand-in identity provider on a real socket, so the client's HTTP path is
 * the one that runs: redirects, timeouts, body limits and Basic credentials are
 * all behaviours of the wire, and a stubbed `fetch` could not show any of them.
 *
 * Every route answers from a function the test replaces, and every request is
 * recorded, so "one upstream call" is a count and not an inference.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, sign as cryptoSign, type KeyObject, type JsonWebKey } from "node:crypto";
import { Endpoints } from "../src/identity/discovery.js";
import { ExchangeClient } from "../src/identity/exchange.js";
import { Introspector, type IntrospectionSettings } from "../src/identity/introspection.js";
import {
  IdentityClient, IDENTITY_DEFAULTS,
  type IdentityClientSettings, type IdentityMetrics, type IdentityOp, type CacheResult, type UpstreamOutcome,
} from "../src/index.js";

export interface Recorded {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  form: URLSearchParams;
}

export interface Reply {
  status?: number;
  /** An object is sent as JSON; a string is sent as is. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Hold the response this long before answering. */
  delayMs?: number;
  /** Drop the connection without answering. */
  destroy?: boolean;
}

export const CLIENT_ID = "svc-test";
export const CLIENT_SECRET = "s3cret:with+reserved/chars=";

export class FakeIdentity {
  readonly requests: Recorded[] = [];
  /** Replaceable per route. The defaults describe a healthy provider that knows no tokens. */
  discovery: (r: Recorded) => Reply = () => ({ body: this.discoveryDocument() });
  jwks: (r: Recorded) => Reply = () => ({ body: { keys: [] } });
  introspect: (r: Recorded) => Reply = () => ({ body: { active: false } });
  token: (r: Recorded) => Reply = () => ({ status: 400, body: { error: "invalid_grant" } });
  resolveCredential: (r: Recorded) => Reply = () => ({ status: 404, body: { error: "not_bound" } });

  private constructor(private readonly server: http.Server) {}

  static async start(): Promise<FakeIdentity> {
    let self!: FakeIdentity;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const path = (req.url ?? "").split("?")[0] ?? "";
        const rec: Recorded = {
          method: req.method ?? "", path, headers: req.headers, body, form: new URLSearchParams(body),
        };
        self.requests.push(rec);
        let reply: Reply;
        if (path === "/.well-known/openid-configuration") reply = self.discovery(rec);
        else if (path === "/.well-known/jwks.json") reply = self.jwks(rec);
        else if (path === "/oauth/introspect") reply = self.introspect(rec);
        else if (path === "/oauth/token") reply = self.token(rec);
        else if (path === "/oauth/external-credentials/resolve") reply = self.resolveCredential(rec);
        else reply = { status: 404, body: "not found" };
        void respond(res, reply);
      });
    });
    self = new FakeIdentity(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return self;
  }

  get issuer(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  discoveryDocument(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      token_endpoint: `${this.issuer}/oauth/token`,
      jwks_uri: `${this.issuer}/.well-known/jwks.json`,
      introspection_endpoint: `${this.issuer}/oauth/introspect`,
    };
  }

  count(path: string): number {
    return this.requests.filter((r) => r.path === path).length;
  }

  last(path: string): Recorded {
    const found = this.requests.filter((r) => r.path === path).at(-1);
    if (!found) throw new Error(`no request to ${path}`);
    return found;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

async function respond(res: http.ServerResponse, reply: Reply): Promise<void> {
  if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
  if (reply.destroy) { res.socket?.destroy(); return; }
  const isJson = reply.body !== undefined && typeof reply.body !== "string";
  res.writeHead(reply.status ?? 200, {
    ...(isJson ? { "Content-Type": "application/json" } : {}),
    ...reply.headers,
  });
  res.end(reply.body === undefined ? "" : isJson ? JSON.stringify(reply.body) : (reply.body as string));
}

/** A clock the test moves by hand. */
export class Clock {
  constructor(public t = 1_800_000_000_000) {}
  now = (): number => this.t;
  advance(ms: number): void { this.t += ms; }
  get seconds(): number { return Math.floor(this.t / 1000); }
}

/** An {@link IdentityMetrics} that keeps what it was told. */
export class RecordingMetrics implements IdentityMetrics {
  cache: Array<[IdentityOp, CacheResult]> = [];
  stale: IdentityOp[] = [];
  upstream: Array<[IdentityOp, UpstreamOutcome]> = [];
  onCache(op: IdentityOp, result: CacheResult): void { this.cache.push([op, result]); }
  onStaleServed(op: IdentityOp): void { this.stale.push(op); }
  onUpstream(op: IdentityOp, outcome: UpstreamOutcome): void { this.upstream.push([op, outcome]); }

  cacheCount(op: IdentityOp, result: CacheResult): number {
    return this.cache.filter(([o, r]) => o === op && r === result).length;
  }
  staleCount(op: IdentityOp): number { return this.stale.filter((o) => o === op).length; }
  upstreamCount(op: IdentityOp, outcome: UpstreamOutcome): number {
    return this.upstream.filter(([o, r]) => o === op && r === outcome).length;
  }
}

export function settingsFor(fake: FakeIdentity, over: Partial<IdentityClientSettings> = {}): IdentityClientSettings {
  return {
    issuerUrl: fake.issuer,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    ...IDENTITY_DEFAULTS,
    ...over,
  };
}

export interface Harness {
  fake: FakeIdentity;
  clock: Clock;
  metrics: RecordingMetrics;
  client: IdentityClient;
}

export async function harness(over: Partial<IdentityClientSettings> = {}): Promise<Harness> {
  const fake = await FakeIdentity.start();
  const clock = new Clock();
  const metrics = new RecordingMetrics();
  const client = new IdentityClient(settingsFor(fake, over), { now: clock.now, metrics });
  return { fake, clock, metrics, client };
}

// --- JWT minting ---------------------------------------------------------------

export interface TestKey {
  kid: string;
  alg: "RS256" | "ES256";
  privateKey: KeyObject;
  jwk: JsonWebKey;
}

let rsa: ReturnType<typeof generateKeyPairSync> | undefined;
let ec: ReturnType<typeof generateKeyPairSync> | undefined;

/** Generated once per process: RSA key generation is the slow part of this suite. */
export function testKey(alg: "RS256" | "ES256", kid: string, fresh = false): TestKey {
  let pair;
  if (alg === "RS256") {
    pair = fresh ? generateKeyPairSync("rsa", { modulusLength: 2048 }) : (rsa ??= generateKeyPairSync("rsa", { modulusLength: 2048 }));
  } else {
    pair = fresh ? generateKeyPairSync("ec", { namedCurve: "P-256" }) : (ec ??= generateKeyPairSync("ec", { namedCurve: "P-256" }));
  }
  const jwk = pair.publicKey.export({ format: "jwk" });
  return { kid, alg, privateKey: pair.privateKey, jwk: { ...jwk, kid, use: "sig", alg } };
}

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");

export function signJwt(opts: {
  key: TestKey;
  claims: Record<string, unknown>;
  /** Replace or add header members; `alg: undefined` removes it. */
  header?: Record<string, unknown>;
  /** Sign with this algorithm regardless of the header. */
  signWith?: "RS256" | "ES256";
}): string {
  const header = { alg: opts.key.alg, typ: "at+jwt", kid: opts.key.kid, ...opts.header };
  const head = b64(header);
  const payload = b64(opts.claims);
  const data = Buffer.from(`${head}.${payload}`, "ascii");
  const alg = opts.signWith ?? opts.key.alg;
  const sig = alg === "RS256"
    ? cryptoSign("sha256", data, opts.key.privateKey)
    : cryptoSign("sha256", data, { key: opts.key.privateKey, dsaEncoding: "ieee-p1363" });
  return `${head}.${payload}.${sig.toString("base64url")}`;
}

export function activeAnswer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    active: true, sub: "user-1", username: "u1@example.com", email: "u1@example.com",
    roles: ["default"], groups: [], token_type: "session", ...over,
  };
}

// --- the pieces on their own, for what the facade fixes (cache capacity) ---------

function pieces(fake: FakeIdentity, clock: Clock) {
  const deps = { fetch, now: clock.now, metrics: new RecordingMetrics(), logger: { warn() {} } };
  const http = { timeoutMs: 2000, maxBodyBytes: 1 << 20 };
  const endpoints = new Endpoints({
    issuer: fake.issuer,
    overrides: { introspectionUrl: `${fake.issuer}/oauth/introspect`, tokenUrl: `${fake.issuer}/oauth/token` },
    refreshMs: 1000, staleIfErrorMs: 0, retryAfterFailureMs: 0, http,
  }, deps);
  return { deps, http, endpoints };
}

/** An {@link Introspector} whose cache holds `maxEntries`. */
export function smallIntrospector(fake: FakeIdentity, clock: Clock, maxEntries: number, over: Partial<IntrospectionSettings> = {}): Introspector {
  const { deps, http, endpoints } = pieces(fake, clock);
  return new Introspector({
    clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, positiveTtlMs: 30_000, negativeTtlMs: 5_000,
    staleIfErrorMs: 0, retryAfterFailureMs: 0, maxEntries, http, ...over,
  }, endpoints, deps);
}

/** An {@link ExchangeClient} whose token cache holds `maxEntries`. */
export function smallExchange(fake: FakeIdentity, clock: Clock, maxEntries: number): ExchangeClient {
  const { deps, http, endpoints } = pieces(fake, clock);
  return new ExchangeClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshSkewMs: 30_000, maxEntries, http }, endpoints, deps);
}
