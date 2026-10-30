// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import pino from "pino";
import { Agent, fetch as undiciFetch } from "undici";
import {
  IdentityExchangeRefusedError, IdentityUnavailableError,
  type ExchangedToken, type ExchangeRequest,
} from "@claw/utils";
import { A2A_CLIENT_ENABLED, A2A_STREAM_IDLE_TIMEOUT_MS, A2A_STREAM_MAX_MS } from "../config.js";
import { identityClient } from "./identity.js";
import {
  INTERRUPTED_STATES, SseParser, TERMINAL_STATES, TaskView, renderResult, resultIsFailure,
  type A2AResult, type WireMessage, type WireTask,
} from "./a2a-result.js";

const logger = pino({ name: "a2a-client" });
const A2A_VERSION = "1.0";

/** RFC 8693 subject_token_type primus-identity takes for "the user a client acts for". */
const USER_REF_TOKEN_TYPE = "urn:primus:params:oauth:token-type:user-ref";

// ---------------------------------------------------------------------------
// A2A v1.0 types — aligned with routes/a2a-types.ts on the server side
// ---------------------------------------------------------------------------

export interface AgentCard {
  name: string;
  description: string;
  version: string;
  supportedInterfaces?: Array<{ url: string; protocolBinding: string; protocolVersion: string }>;
  provider?: { url: string; organization: string };
  capabilities: { streaming?: boolean; pushNotifications?: boolean };
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  skills: Array<{ id: string; name: string; description: string; tags?: string[] }>;
  securitySchemes?: Record<string, unknown>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: string | number;
  result: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown[] };
}

type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

function isErrorResponse(r: JsonRpcResponse): r is JsonRpcErrorResponse {
  return "error" in r;
}

// ---------------------------------------------------------------------------
// Peer registry
//
// `a2a_call` reaches only the peers an operator named in A2A_AGENTS. The model
// picks a name; it never supplies a URL, and it never supplies or receives a
// credential. What a peer is sent as Authorization is decided by its own entry:
//   - `audience`: the session owner's identity. Brain exchanges (RFC 8693) a
//     short-lived token for that user at primus-identity, audience = the peer, and
//     calls the peer as them. The token lives in this process and in the request
//     to the peer; the model and the sandbox never see it.
//   - `auth_env`: a service credential the operator put in the environment. The
//     peer sees Claw, not the user.
//   - neither: nothing is sent.
// The user's LLM key and the platform key are never sent to a peer.
//
// A2A_AGENTS takes either form:
//   name=url,name=url                                  (no credential)
//   [{"name":"ci","url":"https://ci.example.com","auth_env":"A2A_PEER_TOKEN_CI","allow_local":false},
//    {"name":"claw2","card_url":"https://claw.example.com/claw-api/a2a/plugins/7/.well-known/agent-card.json",
//     "audience":"claw-api","scope":"claw.api"}]
//
// Where a request goes is read from the peer's Agent Card (its JSONRPC 1.0
// `supportedInterfaces` entry), not guessed. A card may name only an endpoint on
// the origin the operator wrote down (`card_url`'s, or `url`'s): a peer that could
// redirect the call, and the credential with it, to another host would defeat the
// allowlist.
// ---------------------------------------------------------------------------
export interface A2APeer {
  name: string;
  /** Base URL without a trailing slash, when the entry gave one. Its origin is trusted for the card's endpoint. */
  url?: string;
  /** Where the Agent Card is: the entry's `card_url`, else `<url>/.well-known/agent-card.json`. */
  cardUrl: string;
  /** Name of the env var holding this peer's own bearer token. */
  authEnv?: string;
  /** primus-identity audience: set, the peer is called on behalf of the session owner. */
  audience?: string;
  /** Space-separated scopes asked for in that exchange; the client's own allowed scopes when unset. */
  scope?: string;
  /** Operator's explicit exception to the loopback / link-local refusal below. */
  allowLocal: boolean;
  /**
   * Whose entry this is. Absent: the operator's, visible to every session. Per-user
   * entries (a user adding a public peer of their own) are the next step; the owner
   * is here so that step changes the registry and not every caller.
   */
  owner?: string;
}

const agentRegistry = new Map<string, A2APeer>();

const PEER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const AUDIENCE = /^[\x21-\x7e]{1,256}$/;
const SCOPE = /^[A-Za-z0-9._:/-]+( [A-Za-z0-9._:/-]+)*$/;
const ENTRY_KEYS = new Set(["name", "url", "card_url", "auth_env", "allow_local", "audience", "scope"]);

function httpUrl(name: string, what: string, value: unknown): URL {
  let parsed: URL;
  try { parsed = new URL(String(value)); } catch { throw new Error(`peer "${name}": ${what} is not a URL`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`peer "${name}": ${what} must be http(s)`);
  if (parsed.username || parsed.password) throw new Error(`peer "${name}": ${what} must not embed credentials (use auth_env or audience)`);
  return parsed;
}

const CARD_PATH = "/.well-known/agent-card.json";

/** The card of a peer given only as a base URL: well-known, under the base path. */
function cardUrlFor(baseUrl: string): string {
  const u = new URL(baseUrl);
  u.search = "";
  u.hash = "";
  u.pathname = `${u.pathname.replace(/\/+$/, "")}${CARD_PATH}`;
  return u.toString();
}

/** Where a peer given only as a base URL has always been called when its card does not say. */
function guessedEndpoint(baseUrl: string): string {
  const u = new URL(baseUrl);
  const path = u.pathname.replace(/\/+$/, "");
  u.pathname = path.endsWith("/a2a") ? path : `${path}/a2a`;
  return u.toString();
}

function toPeer(e: Record<string, unknown>): A2APeer {
  const { name, url, card_url: cardUrl, auth_env: authEnv, allow_local: allowLocal, audience, scope } = e;
  if (typeof name !== "string" || !PEER_NAME.test(name)) throw new Error(`invalid peer name ${JSON.stringify(name)}`);
  for (const key of Object.keys(e)) {
    // A misspelt key (`audiance`, `cardUrl`) would otherwise be ignored and the peer called without
    // the credential its operator meant it to have.
    if (!ENTRY_KEYS.has(key)) throw new Error(`peer "${name}": unknown key ${JSON.stringify(key)}`);
  }
  if (url === undefined && cardUrl === undefined) throw new Error(`peer "${name}": url or card_url is required`);
  const base = url === undefined ? undefined : httpUrl(name, "url", url);
  const card = cardUrl === undefined ? undefined : httpUrl(name, "card_url", cardUrl);
  if (authEnv !== undefined && (typeof authEnv !== "string" || !ENV_NAME.test(authEnv))) {
    throw new Error(`peer "${name}": auth_env must be an environment variable name`);
  }
  if (allowLocal !== undefined && typeof allowLocal !== "boolean") throw new Error(`peer "${name}": allow_local must be a boolean`);
  if (audience !== undefined && (typeof audience !== "string" || !AUDIENCE.test(audience))) {
    throw new Error(`peer "${name}": audience must be a non-empty token without spaces`);
  }
  if (scope !== undefined && (typeof scope !== "string" || !SCOPE.test(scope))) {
    throw new Error(`peer "${name}": scope must be space-separated scope names`);
  }
  if (authEnv !== undefined && audience !== undefined) {
    throw new Error(`peer "${name}": auth_env and audience are two ways to authenticate; set one`);
  }
  if (scope !== undefined && audience === undefined) throw new Error(`peer "${name}": scope only applies with audience`);
  const baseUrl = base ? String(url).replace(/\/$/, "") : undefined;
  return {
    name,
    url: baseUrl,
    cardUrl: card ? String(cardUrl) : cardUrlFor(baseUrl!),
    authEnv: authEnv as string | undefined,
    audience: audience as string | undefined,
    scope: scope as string | undefined,
    allowLocal: allowLocal === true,
  };
}

/** Parses A2A_AGENTS. A bad entry is dropped and reported, never half-applied. */
export function parseA2AAgents(raw: string): { peers: A2APeer[]; errors: string[] } {
  const peers: A2APeer[] = [];
  const errors: string[] = [];
  const text = raw.trim();
  if (!text) return { peers, errors };
  const add = (make: () => A2APeer) => {
    try { peers.push(make()); } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
  };
  if (text.startsWith("[")) {
    let list: unknown;
    try { list = JSON.parse(text); } catch { return { peers, errors: ["A2A_AGENTS is not valid JSON"] }; }
    if (!Array.isArray(list)) return { peers, errors: ["A2A_AGENTS JSON must be an array of peers"] };
    for (const e of list as unknown[]) {
      add(() => {
        if (e === null || typeof e !== "object" || Array.isArray(e)) throw new Error("A2A_AGENTS entry is not an object");
        return toPeer(e as Record<string, unknown>);
      });
    }
  } else {
    for (const entry of text.split(",")) {
      const eq = entry.indexOf("=");
      if (eq < 0) { if (entry.trim()) errors.push(`entry ${JSON.stringify(entry.trim())} is not name=url`); continue; }
      add(() => toPeer({ name: entry.slice(0, eq).trim(), url: entry.slice(eq + 1).trim() }));
    }
  }
  return { peers, errors };
}

export function initA2ARegistry(raw: string | undefined = process.env.A2A_AGENTS): void {
  agentRegistry.clear();
  cardCache.clear();
  const { peers, errors } = parseA2AAgents(raw ?? "");
  for (const e of errors) logger.error({ reason: e }, "a2a.registry.entry_refused");
  if (peers.length > 0 && !A2A_CLIENT_ENABLED) {
    logger.warn({ peers: peers.length }, "a2a.registry.unused: A2A_AGENTS names peers but A2A_CLIENT_ENABLED is off, so a2a_call is not offered");
  }
  for (const peer of peers) {
    addPeer(peer);
    logger.info(
      {
        agent: peer.name, card: peer.cardUrl, auth: peer.audience ? "identity" : peer.authEnv ? "env" : "none",
        allowLocal: peer.allowLocal,
      },
      "a2a.registry.add",
    );
  }
}

/** The one door into the registry, so an entry's visibility is decided in one place. */
export function addPeer(peer: A2APeer): void {
  agentRegistry.set(peer.name, peer);
}

/**
 * A peer by name, as seen by this user. An operator's entry is everyone's; an entry
 * with an `owner` is its owner's alone and, to anyone else, does not exist.
 */
export function resolvePeer(name: string, userId?: string): A2APeer {
  const peer = agentRegistry.get(name);
  if (peer && (peer.owner === undefined || peer.owner === userId)) return peer;
  const available = Array.from(agentRegistry.values())
    .filter((p) => p.owner === undefined || p.owner === userId)
    .map((p) => p.name).join(", ") || "(none configured: an operator sets A2A_AGENTS)";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(name)) {
    throw new Error(`a2a_call takes the name of a configured peer, not a URL. Available: ${available}`);
  }
  throw new Error(`Unknown agent "${name}". Available: ${available}`);
}

// ---------------------------------------------------------------------------
// Where a peer may be: not loopback, link-local (cloud metadata) or unspecified
// unless its entry says allow_local. The address actually connected to is the
// one checked (the lookup runs at connect time), so a name cannot resolve one
// way for the check and another for the request. Private ranges stay allowed:
// an in-cluster peer lives there, and the operator named it.
// ---------------------------------------------------------------------------
const LOCAL_ADDRESSES = new BlockList();
for (const [net, prefix] of [["0.0.0.0", 8], ["127.0.0.0", 8], ["169.254.0.0", 16]] as const) {
  LOCAL_ADDRESSES.addSubnet(net, prefix, "ipv4"); // also matches ::ffff:a.b.c.d
}
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["fe80::", 10],
  // NAT64 embeds an IPv4 address in the address (RFC 6052). Both registered prefixes are decoded:
  // the well-known 64:ff9b::/96 carries it in the low 32 bits, the local-use 64:ff9b:1::/48
  // (RFC 8215) in bits 48-63 and 72-87. An operator's own network-specific prefix cannot be
  // told from any other IPv6 address, so it is judged as the IPv6 address it is.
  ["64:ff9b::", 104], ["64:ff9b::7f00:0", 104], ["64:ff9b::a9fe:0", 112],
  ["64:ff9b:1::", 56], ["64:ff9b:1:7f00::", 56], ["64:ff9b:1:a9fe::", 64],
] as const) LOCAL_ADDRESSES.addSubnet(net, prefix, "ipv6");

export function isLocalAddress(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && LOCAL_ADDRESSES.check(address, family === 4 ? "ipv4" : "ipv6");
}

function localRefusal(address: string): Error {
  return new Error(
    `peer address ${address} is loopback or link-local; refused unless its A2A_AGENTS entry sets allow_local`,
  );
}

const GUARDED_AGENT = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err, "", 4);
        const bad = addresses.find((a) => isLocalAddress(a.address));
        if (bad) return callback(localRefusal(bad.address), "", 4);
        if (options.all) return callback(null, addresses);
        callback(null, addresses[0].address, addresses[0].family);
      });
    },
  },
});
const OPEN_AGENT = new Agent();

type PeerResponse = Awaited<ReturnType<typeof undiciFetch>>;

/**
 * Every request to a peer goes through here. IP literals never reach the lookup
 * above, so they are judged first. Redirects are refused: a peer that answers 3xx
 * could otherwise send the request, body and all, somewhere the registry never named.
 */
function peerFetch(peer: A2APeer, url: string, init: Parameters<typeof undiciFetch>[1]): Promise<PeerResponse> {
  if (!peer.allowLocal) {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    if (isLocalAddress(host)) return Promise.reject(localRefusal(host));
  }
  return undiciFetch(url, {
    ...init,
    redirect: "error",
    dispatcher: peer.allowLocal ? OPEN_AGENT : GUARDED_AGENT,
  });
}


// ---------------------------------------------------------------------------
// What one call carries besides its arguments
// ---------------------------------------------------------------------------
export interface A2AIdentitySource {
  exchange(req: ExchangeRequest): Promise<ExchangedToken>;
}

export interface A2ACallOptions {
  /** The run's owner: the user an identity-authenticated peer is called on behalf of. */
  userId?: string;
  sessionId?: string;
  /** Epoch ms at which the run's budget ends; a streamed call stops waiting a little before. */
  deadlineAtMs?: number;
  /** The run's abort signal (the user's Stop). It ends the call and cancels the peer's task. */
  signal?: AbortSignal;
  /** Whether an abort with this reason means the work is no longer wanted (a Stop) as against a restart that will resume it. */
  cancelOnAbort?: (reason: unknown) => boolean;
  /** Filled with whether the call did the work asked of it; see ToolRouter.route's `outcome`. */
  outcome?: { isError: boolean };
  /**
   * Every credential this call sent a peer, filled in as they are used. Whatever the peer writes back
   * is peer-authored text that reaches the model, so what leaves handleA2ACall is scrubbed of these.
   */
  sentCredentials?: Set<string>;
  /** Overrides, for tests: the identity client, and the stream's timing. */
  identity?: A2AIdentitySource | null;
  idleTimeoutMs?: number;
  maxStreamMs?: number;
}

/** Non-streaming calls give up after this long (a get, a cancel, a send that returns immediately). */
const RPC_TIMEOUT_MS = 30_000;
const DISCOVER_TIMEOUT_MS = 10_000;
const CANCEL_TIMEOUT_MS = 10_000;
/** A streamed call stops waiting this long before the run's own budget ends, so it can still report. */
const DEADLINE_MARGIN_MS = 10_000;
const MIN_STREAM_MS = 5_000;
/** One response from a peer is never read past this. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// The credential a peer is sent
// ---------------------------------------------------------------------------

/** The peer's own credential, or none. A declared but unobtainable one is an error, never a silent downgrade. */
async function peerBearer(peer: A2APeer, opts: A2ACallOptions, forceRefresh = false): Promise<string | undefined> {
  if (peer.audience) return exchangeForOwner(peer, peer.audience, opts, forceRefresh);
  if (!peer.authEnv) return undefined;
  const token = process.env[peer.authEnv]?.trim();
  if (!token) throw new Error(`peer "${peer.name}" names auth_env ${peer.authEnv}, which is empty here; not calling it unauthenticated`);
  return token;
}

/**
 * A short-lived token for the session owner, audience = the peer, from primus-identity.
 * The subject is `user_id:<owner>` (impersonation by a service client the operator
 * registered, so the owner needs a binding there; a revoked binding ends it at the
 * next exchange). The client caches tokens and refreshes them before they expire.
 */
async function exchangeForOwner(peer: A2APeer, audience: string, opts: A2ACallOptions, forceRefresh: boolean): Promise<string> {
  const identity = opts.identity === undefined ? identityClient() : opts.identity;
  if (!identity) {
    throw new Error(
      `peer "${peer.name}" is called on behalf of the session's user through primus-identity, but this deployment has no `
      + "identity client (IDENTITY_CLIENT_ENABLED is off)",
    );
  }
  const owner = opts.userId?.trim();
  if (!owner) throw new Error(`peer "${peer.name}" is called on behalf of the session's user, and this run has none`);
  try {
    const token = await identity.exchange({
      subjectToken: `user_id:${owner}`,
      subjectTokenType: USER_REF_TOKEN_TYPE,
      audience,
      ...(peer.scope ? { scope: peer.scope } : {}),
      ...(forceRefresh ? { forceRefresh: true } : {}),
    });
    return token.accessToken;
  } catch (err) {
    if (err instanceof IdentityExchangeRefusedError) {
      throw new Error(
        `primus-identity refused to issue a token for this user to call peer "${peer.name}" (${err.code}): `
        + "the user is not set up to be acted for, or the binding was revoked",
      );
    }
    if (err instanceof IdentityUnavailableError) {
      throw new Error(`primus-identity could not be asked for a token for peer "${peer.name}" (${err.reason}); try again later`);
    }
    throw err;
  }
}

/**
 * fetch with the peer's credential. An identity token the peer refuses (401) is
 * replaced once with a freshly exchanged one: it may have been revoked, or have
 * aged out between the exchange and the request.
 */
async function authorizedFetch(
  peer: A2APeer, opts: A2ACallOptions, url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
): Promise<PeerResponse> {
  for (let attempt = 0; ; attempt++) {
    const bearer = await peerBearer(peer, opts, attempt > 0);
    if (bearer) opts.sentCredentials?.add(bearer);
    const headers = bearer ? { ...init.headers, Authorization: `Bearer ${bearer}` } : init.headers;
    const res = await peerFetch(peer, url, { ...init, headers });
    if (res.status === 401 && peer.audience && attempt === 0) {
      await res.body?.cancel().catch(() => {});
      continue;
    }
    return res;
  }
}

// ---------------------------------------------------------------------------
// Agent Card: where the peer is, and how it wants to be called
//
// Fetched from the entry's card URL (v1.0 spec 8.2) and cached by ETag /
// Cache-Control (8.6): a fresh entry is served as is, a stale one is revalidated
// with If-None-Match, and a peer that cannot be asked is answered from the entry
// held. A card behind identity is per user, so those entries are keyed by user: one
// user's view of a private agent is never served to another.
// ---------------------------------------------------------------------------
interface CardEntry {
  card: AgentCard;
  etag?: string;
  freshUntilMs: number;
  /** What the peer was sent when it gave us this card: it may have echoed it into the card, and a cached card outlives the call. */
  credentials: Set<string>;
}

const cardCache = new Map<string, CardEntry>();
const CARD_CACHE_MAX = 500;
const CARD_DEFAULT_TTL_MS = 5 * 60_000;
const CARD_MAX_TTL_MS = 60 * 60_000;

/** An entry that gave only a base URL (the `name=url` form): its card is where the base says, and it may predate v1.0. */
function isBareUrlPeer(peer: A2APeer): boolean {
  return peer.url !== undefined && peer.cardUrl === cardUrlFor(peer.url);
}

/** A peer that publishes no card at the address derived from its `url`, as against one that failed to answer. */
class CardNotPublished extends Error {}

function cardKey(peer: A2APeer, opts: A2ACallOptions): string {
  return `${peer.name}\u0000${peer.audience ? opts.userId ?? "" : ""}`;
}

/** How long the card may be served without asking: null for a card that must not be stored at all (`no-store`). */
function cardTtlMs(res: PeerResponse): number | null {
  const cc = res.headers.get("cache-control") ?? "";
  if (/\bno-store\b/i.test(cc)) return null;
  if (/\bno-cache\b/i.test(cc)) return 0; // stored, and revalidated every time
  const m = /\bmax-age=(\d+)/i.exec(cc);
  return m ? Math.min(Number(m[1]) * 1000, CARD_MAX_TTL_MS) : CARD_DEFAULT_TTL_MS;
}

function joinSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  return AbortSignal.any(signals.filter((s): s is AbortSignal => s !== undefined));
}

export async function discoverAgent(peer: A2APeer, opts: A2ACallOptions = {}, timeoutMs = DISCOVER_TIMEOUT_MS): Promise<AgentCard> {
  const key = cardKey(peer, opts);
  const held = cardCache.get(key);
  const remember = (creds: Iterable<string>): void => { for (const c of creds) opts.sentCredentials?.add(c); };
  if (held && Date.now() < held.freshUntilMs) {
    remember(held.credentials);
    return held.card;
  }
  const used = new Set<string>(held?.credentials);
  const fetching: A2ACallOptions = { ...opts, sentCredentials: used };

  // A peer given only as a base URL also answers to the pre-v1.0 card path.
  const candidates = isBareUrlPeer(peer)
    ? [peer.cardUrl, peer.cardUrl.replace(/agent-card\.json$/, "agent.json")]
    : [peer.cardUrl];
  let lastErr = "";
  for (const url of candidates) {
    let res: PeerResponse;
    try {
      res = await authorizedFetch(peer, fetching, url, {
        method: "GET",
        headers: { Accept: "application/json", ...(held?.etag ? { "If-None-Match": held.etag } : {}) },
        signal: joinSignals(AbortSignal.timeout(timeoutMs), opts.signal),
      });
    } catch (err) {
      remember(used);
      if (opts.signal?.aborted) throw err;
      if (held) {
        // The card changes rarely and only decides where to call; the call itself is judged on its own.
        logger.warn({ agent: peer.name, err: scrubCredentials(describeError(err), used) }, "a2a.card.stale_served");
        return held.card;
      }
      throw err;
    }
    remember(used);
    if (res.status === 304 && held) {
      await res.body?.cancel().catch(() => {});
      held.freshUntilMs = Date.now() + (cardTtlMs(res) ?? 0);
      held.credentials = used;
      return held.card;
    }
    if (res.ok) {
      const card = (await readJson(res)) as AgentCard;
      const ttl = cardTtlMs(res);
      if (ttl === null) {
        cardCache.delete(key);
      } else {
        if (cardCache.size >= CARD_CACHE_MAX && !cardCache.has(key)) {
          const oldest = cardCache.keys().next().value;
          if (oldest !== undefined) cardCache.delete(oldest);
        }
        cardCache.set(key, { card, etag: res.headers.get("etag") ?? undefined, freshUntilMs: Date.now() + ttl, credentials: used });
      }
      return card;
    }
    await res.body?.cancel().catch(() => {});
    if (res.status >= 500 && held) {
      logger.warn({ agent: peer.name, status: res.status }, "a2a.card.stale_served");
      return held.card;
    }
    lastErr = `${res.status} ${res.statusText}`;
    if (res.status !== 404) break; // only fall back on 404
  }
  const err = new Error(`Agent discovery failed: ${lastErr}`);
  if (lastErr.startsWith("404")) throw Object.assign(new CardNotPublished(err.message), { cause: err });
  throw err;
}

function originOf(url: string): string {
  return new URL(url).origin;
}

/**
 * The JSON-RPC endpoint to call: the card's JSONRPC 1.0 interface, on an origin the operator
 * wrote down. A peer written as a bare base URL that publishes no card at all keeps the
 * `<base>/a2a` path this client always used.
 */
async function resolveEndpoint(peer: A2APeer, opts: A2ACallOptions): Promise<{ endpoint: string; card?: AgentCard }> {
  const bareUrl = isBareUrlPeer(peer);
  const guessed = (card?: AgentCard) => ({ endpoint: guessedEndpoint(peer.url!), card });
  let card: AgentCard;
  try {
    card = await discoverAgent(peer, opts);
  } catch (err) {
    if (err instanceof CardNotPublished && bareUrl) return guessed();
    throw err;
  }
  const interfaces = Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : [];
  const iface = interfaces.find((i) =>
    typeof i?.url === "string" && String(i.protocolBinding).toUpperCase() === "JSONRPC" && /^1(\.|$)/.test(String(i.protocolVersion)));
  if (!iface) {
    // A peer given only as a base URL whose card names no interface at all is a pre-v1.0 one.
    if (bareUrl && interfaces.length === 0) return guessed(card);
    const found = interfaces.map((i) => `${i?.protocolBinding} ${i?.protocolVersion}`).join(", ") || "none";
    throw new Error(`peer "${peer.name}": its card lists no JSONRPC 1.0 interface (found: ${found})`);
  }
  let target: URL;
  try { target = httpUrl(peer.name, "the card's interface url", iface.url); } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
  const trusted = new Set([originOf(peer.cardUrl)]);
  if (peer.url) trusted.add(originOf(peer.url));
  if (!trusted.has(target.origin)) {
    throw new Error(
      `peer "${peer.name}": its card names an endpoint on ${target.origin}, which is not the origin of its card_url or url; `
      + "refused (set the entry's url to that origin if the operator trusts it)",
    );
  }
  return { endpoint: target.toString(), card };
}

// ---------------------------------------------------------------------------
// JSON-RPC over HTTP
// ---------------------------------------------------------------------------
let rpcIdCounter = 1;

/** The body, bounded: a peer is not trusted to stop. */
async function readText(res: PeerResponse): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let bytes = 0;
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error(`the peer's response is larger than ${MAX_RESPONSE_BYTES / 1024 / 1024} MiB`);
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

async function readJson(res: PeerResponse): Promise<unknown> {
  const text = await readText(res);
  try { return JSON.parse(text); } catch { throw new Error(`the peer answered something that is not JSON (HTTP ${res.status})`); }
}

function rpcBody(method: string, params: Record<string, unknown>): { id: number; body: string } {
  const id = rpcIdCounter++;
  const body: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
  return { id, body: JSON.stringify(body) };
}

function rpcError(e: JsonRpcErrorResponse["error"]): Error {
  return new Error(`A2A RPC error [${e.code}]: ${e.message}`);
}

async function rpcCall(
  peer: A2APeer, opts: A2ACallOptions, method: string, params: Record<string, unknown>,
  timeoutMs = RPC_TIMEOUT_MS, withoutRunSignal = false,
): Promise<unknown> {
  // `withoutRunSignal` is for a request sent because the run's signal fired (CancelTask on Stop), so
  // it covers the card fetch that finds the endpoint as much as the POST: a card that is not fresh is
  // fetched again, and with that signal already aborted the fetch would fail before anything was sent.
  const callOpts: A2ACallOptions = withoutRunSignal ? { ...opts, signal: undefined } : opts;
  const { endpoint } = await resolveEndpoint(peer, callOpts);
  const res = await authorizedFetch(peer, callOpts, endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "A2A-Version": A2A_VERSION },
    body: rpcBody(method, params).body,
    signal: joinSignals(AbortSignal.timeout(timeoutMs), callOpts.signal),
  });
  let json: JsonRpcResponse;
  try {
    json = (await readJson(res)) as JsonRpcResponse;
  } catch (err) {
    if (!res.ok) throw new Error(`${method} failed: HTTP ${res.status}`);
    throw err;
  }
  if (json && typeof json === "object" && isErrorResponse(json)) throw rpcError(json.error);
  if (!res.ok) throw new Error(`${method} failed: HTTP ${res.status}`);
  return (json as JsonRpcSuccessResponse).result;
}

function userMessage(text: string, opts: { contextId?: string; taskId?: string; approval?: { action_id: string; decision: string } }) {
  const parts: Array<Record<string, unknown>> = [];
  if (text) parts.push({ text });
  if (opts.approval) parts.push({ data: { actionId: opts.approval.action_id, decision: opts.approval.decision } });
  return {
    messageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: "ROLE_USER",
    parts,
    ...(opts.contextId ? { contextId: opts.contextId } : {}),
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
  };
}

export interface SendArgs {
  text: string;
  contextId?: string;
  taskId?: string;
  approval?: { action_id: string; decision: string };
  metadata?: Record<string, unknown>;
}

function sendParams(a: SendArgs, returnImmediately?: boolean): Record<string, unknown> {
  return {
    message: userMessage(a.text, a),
    ...(returnImmediately !== undefined ? { configuration: { returnImmediately } } : {}),
    ...(a.metadata ? { metadata: a.metadata } : {}),
  };
}

/** What GetTask, CancelTask and SendMessage answer, whichever shape: `{task}`, `{message}` or the Task itself. */
function viewOf(result: unknown): TaskView {
  const view = new TaskView();
  const r = (result ?? {}) as Record<string, unknown>;
  if (r.task) view.applyTask(r.task as WireTask);
  else if (r.message) view.applyDirectMessage(r.message as WireMessage);
  else if (typeof r.id === "string" && r.status) view.applyTask(r as WireTask);
  return view;
}

// ---------------------------------------------------------------------------
// SendMessage, GetTask, CancelTask
// ---------------------------------------------------------------------------
export async function sendMessage(
  peer: A2APeer, opts: A2ACallOptions, args: SendArgs, returnImmediately: boolean, timeoutMs = RPC_TIMEOUT_MS,
): Promise<A2AResult> {
  const view = viewOf(await rpcCall(peer, opts, "SendMessage", sendParams(args, returnImmediately), timeoutMs));
  if (!view.seen) throw new Error("SendMessage did not return a task or a message");
  return view.toResult(returnImmediately ? followUpNote(view) : undefined);
}

export async function getTask(peer: A2APeer, opts: A2ACallOptions, taskId: string): Promise<A2AResult> {
  const view = viewOf(await rpcCall(peer, opts, "GetTask", { id: taskId }));
  if (!view.seen) throw new Error("GetTask did not return a task");
  return view.toResult(followUpNote(view));
}

export async function cancelTask(
  peer: A2APeer, opts: A2ACallOptions, taskId: string, withoutRunSignal = false,
): Promise<A2AResult> {
  const view = viewOf(await rpcCall(peer, opts, "CancelTask", { id: taskId }, CANCEL_TIMEOUT_MS, withoutRunSignal));
  if (!view.seen) throw new Error("CancelTask did not return a task");
  return view.toResult();
}

/** What the model should do with a result it may not be done with. */
function followUpNote(view: TaskView): string | undefined {
  if (INTERRUPTED_STATES.has(view.state)) return INPUT_NOTE;
  if (!TERMINAL_STATES.has(view.state)) {
    return 'The peer\'s task is still running. Call a2a_call with mode "get" and this task_id to read it later, or mode "cancel" to stop it.';
  }
  return undefined;
}

const INPUT_NOTE =
  "The peer is waiting for input. Ask the user with ask_user_question if it needs their decision, then call a2a_call again "
  + "with this task_id and context_id and the answer in message; for an approval request pass approval {action_id, decision} "
  + "instead (an allow is held for the user's own approval).";

// ---------------------------------------------------------------------------
// SendStreamingMessage — JSON-RPC SSE
//
// Reads until the task ends or is interrupted, with two limits that end the WAIT and
// leave the peer's task alone: no event for the idle timeout, and the total time
// (the run's remaining budget, capped). A task that outlives the wait is not a failure:
// the result says `working` and carries the task_id for `get`. The one thing that does
// cancel the peer's task is the run being stopped.
// ---------------------------------------------------------------------------
export function streamBudgetMs(opts: Pick<A2ACallOptions, "maxStreamMs" | "deadlineAtMs">, now = Date.now()): number {
  const cap = opts.maxStreamMs ?? A2A_STREAM_MAX_MS;
  if (opts.deadlineAtMs === undefined) return cap;
  return Math.max(MIN_STREAM_MS, Math.min(cap, opts.deadlineAtMs - now - DEADLINE_MARGIN_MS));
}

type Ending = "idle" | "total" | "stop";

export async function sendStreamingMessage(peer: A2APeer, opts: A2ACallOptions, args: SendArgs): Promise<A2AResult> {
  const { endpoint, card } = await resolveEndpoint(peer, opts);
  // A peer that says it does not stream is asked the ordinary way.
  if (card && card.capabilities?.streaming === false) return sendMessage(peer, opts, args, false);

  const idleMs = opts.idleTimeoutMs ?? A2A_STREAM_IDLE_TIMEOUT_MS;
  const totalMs = streamBudgetMs(opts);
  const ctl = new AbortController();
  let ending: Ending | null = null;
  const end = (why: Ending): void => {
    if (ending) return;
    ending = why;
    ctl.abort();
  };
  const onStop = (): void => end("stop");
  opts.signal?.addEventListener("abort", onStop, { once: true });
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => end("idle"), idleMs);
  };
  const totalTimer = setTimeout(() => end("total"), totalMs);
  armIdle();

  const view = new TaskView();
  let peerClosed = false;
  try {
    const res = await authorizedFetch(peer, opts, endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", "A2A-Version": A2A_VERSION },
      body: rpcBody("SendStreamingMessage", sendParams(args)).body,
      signal: ctl.signal,
    });
    if (!res.ok) {
      // A refusal usually carries a JSON-RPC error body that says why.
      const refusal = await readJson(res).then((j) => j as JsonRpcResponse, () => undefined);
      if (refusal && typeof refusal === "object" && isErrorResponse(refusal)) throw rpcError(refusal.error);
      throw new Error(`SendStreamingMessage failed: HTTP ${res.status}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!/text\/event-stream/i.test(contentType)) {
      // A peer that answers a streaming request with one JSON document: an error, or a result.
      const j = (await readJson(res)) as JsonRpcResponse;
      if (j && typeof j === "object" && isErrorResponse(j)) throw rpcError(j.error);
      const one = viewOf((j as JsonRpcSuccessResponse | undefined)?.result);
      if (!one.seen) throw new Error("SendStreamingMessage returned no events");
      return one.toResult(followUpNote(one));
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("SendStreamingMessage returned no body");
    const decoder = new TextDecoder();
    const parser = new SseParser();
    let bytes = 0;
    let settled = false;
    const take = (data: string): void => {
      armIdle();
      let rpc: JsonRpcResponse;
      try { rpc = JSON.parse(data) as JsonRpcResponse; } catch { return; /* a malformed event is skipped */ }
      if (rpc && typeof rpc === "object" && isErrorResponse(rpc)) throw rpcError(rpc.error);
      view.applyEvent((rpc as JsonRpcSuccessResponse).result as Record<string, unknown>);
      // Terminal states close the stream (spec 3.1.2). An interrupted state leaves it open waiting
      // for the caller's reply, which is a new call here, so the wait is over either way.
      if (TERMINAL_STATES.has(view.state) || INTERRUPTED_STATES.has(view.state)) settled = true;
      // A Message with no task is the whole answer (spec 3.1.2): nothing follows it.
      if (!view.taskId && view.answered) settled = true;
    };
    try {
      while (!settled) {
        const { done, value } = await reader.read();
        if (done) { peerClosed = true; break; }
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new Error(`the peer's stream is larger than ${MAX_RESPONSE_BYTES / 1024 / 1024} MiB`);
        for (const data of parser.push(decoder.decode(value, { stream: true }))) {
          take(data);
          if (settled) break;
        }
      }
      if (peerClosed && !settled) for (const data of parser.flush()) take(data);
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch (err) {
    // An abort of ours surfaces as an AbortError from the read; any other error is the call's.
    if (!ending) throw err;
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    opts.signal?.removeEventListener("abort", onStop);
  }

  return concludeStream(peer, opts, view, ending, peerClosed);
}

async function concludeStream(
  peer: A2APeer, opts: A2ACallOptions, view: TaskView, ending: Ending | null, peerClosed: boolean,
): Promise<A2AResult> {
  if (ending === "stop") {
    const cancels = (opts.cancelOnAbort ?? (() => true))(opts.signal?.reason);
    if (!cancels) {
      return view.toResult("The run was interrupted (a restart); the peer's task was left running. Use mode \"get\" with this task_id to read it.");
    }
    if (!view.taskId) {
      return { ...view.toResult("The run was stopped before the peer reported a task, so there was nothing to cancel."), state: "canceled" };
    }
    try {
      // Not tied to the run's signal: that is exactly what has just fired.
      const cancelled = await cancelTask(peer, opts, view.taskId, true);
      return { ...cancelled, note: "The run was stopped; CancelTask was sent to the peer." };
    } catch (err) {
      // The error carries the peer's own words (a JSON-RPC error message), which may echo what it was sent.
      const sent = opts.sentCredentials ?? new Set<string>();
      logger.warn(
        { agent: peer.name, taskId: scrubCredentials(view.taskId, sent), err: scrubCredentials(describeError(err), sent) },
        "a2a.cancel_on_stop.failed",
      );
      return view.toResult(`The run was stopped; CancelTask to the peer failed (${describeError(err)}). Its task may still be running.`);
    }
  }
  if (ending === "idle" || ending === "total") {
    const why = ending === "idle" ? "no event arrived for a while" : "the time allowed for this call ran out";
    if (!view.taskId) throw new Error(`the peer did not report a task: ${why}`);
    const result = view.toResult(
      `Stopped waiting (${why}); the peer's task keeps running. Call a2a_call with mode "get" and this task_id to read it later, `
      + 'or mode "cancel" to stop it.',
    );
    if (!TERMINAL_STATES.has(result.state) && !INTERRUPTED_STATES.has(result.state)) result.state = "working";
    return result;
  }
  if (!view.seen) throw new Error("the peer's stream carried no events");
  if (peerClosed && !TERMINAL_STATES.has(view.state) && !INTERRUPTED_STATES.has(view.state)) {
    if (!view.taskId && view.answered) return view.toResult();
    return view.toResult('The peer closed the stream before the task finished. Use mode "get" with this task_id to read it.');
  }
  return view.toResult(followUpNote(view));
}

// ---------------------------------------------------------------------------
// A peer's words are not trusted with the peer's own credential. A peer can write the
// Authorization header it was sent into an artifact, a status message, an error or its
// card, and all of that is read by the model, which could then hand it to another tool.
// What leaves the handler has the credentials this call sent removed, in the spellings
// a peer can cheaply give them (as is, JSON-escaped, URL-encoded, base64 and base64url).
// A peer that re-encodes it further has already held the credential it was given; this
// keeps it out of the model's context, it does not make a peer that holds it harmless.
// ---------------------------------------------------------------------------
/** Below this a credential is only removed as a whole word: as a substring it would also remove ordinary text. */
const SUBSTRING_SCRUBBED_FROM = 8;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function scrubCredentials(text: string, sent: ReadonlySet<string>): string {
  let out = text;
  for (const token of sent) {
    if (!token) continue;
    const forms = new Set<string>([
      token,
      JSON.stringify(token).slice(1, -1),
      encodeURIComponent(token),
      Buffer.from(token).toString("base64"),
      Buffer.from(token).toString("base64").replace(/=+$/, ""),
      Buffer.from(token).toString("base64url"),
    ]);
    for (const form of forms) {
      if (!form) continue;
      out = token.length >= SUBSTRING_SCRUBBED_FROM
        ? out.split(form).join("[credential removed]")
        : out.replace(new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(form)}(?![A-Za-z0-9_-])`, "g"), "[credential removed]");
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// a2a_call tool handler — used by ToolRouter
// ---------------------------------------------------------------------------
const MODES = ["stream", "fire_and_forget", "discover", "get", "cancel"] as const;
type Mode = (typeof MODES)[number];

function text(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function parseApproval(v: unknown): SendArgs["approval"] | string {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object") return "'approval' must be an object {action_id, decision}";
  const a = v as Record<string, unknown>;
  if (typeof a.action_id !== "string" || !a.action_id) return "'approval.action_id' is required";
  if (a.decision !== "allow" && a.decision !== "deny") return "'approval.decision' must be \"allow\" or \"deny\"";
  return { action_id: a.action_id, decision: a.decision };
}

/**
 * Whether this a2a_call grants a peer's approval request on the user's behalf. A peer's text
 * is not the user's word: an allow goes to the user first (engine.ts holds it through the
 * same gate as any other approval), so a reply the peer wrote cannot talk the model into
 * approving itself.
 */
export function a2aApprovalHold(tool: string, input: Record<string, unknown>): string | null {
  if (tool !== "a2a_call") return null;
  const a = input.approval;
  return a && typeof a === "object" && (a as Record<string, unknown>).decision === "allow" ? "a2a_peer_approval" : null;
}

export async function handleA2ACall(input: Record<string, unknown>, opts: A2ACallOptions = {}): Promise<string> {
  const sent = new Set<string>();
  const out = await runA2ACall(input, { ...opts, sentCredentials: sent });
  return sent.size > 0 ? scrubCredentials(out, sent) : out;
}

async function runA2ACall(input: Record<string, unknown>, opts: A2ACallOptions): Promise<string> {
  const agent = text(input, "agent");
  const mode = (text(input, "mode") ?? "stream") as Mode;
  const message = text(input, "message");
  const taskId = text(input, "task_id");
  const contextId = text(input, "context_id");
  const metadata = (input.metadata as Record<string, unknown>) || undefined;
  const fail = (msg: string): string => {
    if (opts.outcome) opts.outcome.isError = true;
    return msg;
  };

  if (!agent) return fail("Error: 'agent' is required");
  if (!MODES.includes(mode)) return fail(`Error: unknown mode "${String(input.mode)}"; use one of ${MODES.join(", ")}`);
  const approval = parseApproval(input.approval);
  if (typeof approval === "string") return fail(`Error: ${approval}`);
  if ((mode === "stream" || mode === "fire_and_forget") && !message && !approval) return fail("Error: 'message' is required");
  if ((mode === "get" || mode === "cancel") && !taskId) return fail(`Error: 'task_id' is required for mode "${mode}"`);
  if (approval && !taskId) return fail("Error: 'approval' answers a task that is waiting; 'task_id' is required");
  if (opts.signal?.aborted) {
    return renderResult({ state: "canceled", text: "", artifacts: [], note: "The run was stopped before the call was made." });
  }

  const started = Date.now();
  try {
    const peer = resolvePeer(agent, opts.userId);
    const args: SendArgs = { text: message ?? "", contextId, taskId, approval, metadata };
    let result: A2AResult;
    switch (mode) {
      case "discover":
        return JSON.stringify(await discoverAgent(peer, opts), null, 2);
      case "fire_and_forget":
        result = await sendMessage(peer, opts, args, true);
        break;
      case "get":
        result = await getTask(peer, opts, taskId!);
        break;
      case "cancel":
        result = await cancelTask(peer, opts, taskId!);
        break;
      default:
        result = await sendStreamingMessage(peer, opts, args);
    }
    if (opts.outcome && resultIsFailure(result)) opts.outcome.isError = true;
    logger.info(
      {
        agent, mode, state: result.state, sessionId: opts.sessionId, elapsedMs: Date.now() - started,
        // The peer names the task, so it is scrubbed like everything else of the peer's that is written down.
        taskId: result.task_id === undefined ? undefined : scrubCredentials(result.task_id, opts.sentCredentials ?? new Set()),
      },
      "a2a.call",
    );
    return renderResult(result);
  } catch (err: unknown) {
    if (opts.signal?.aborted) {
      return renderResult({ state: "canceled", text: "", artifacts: [], note: "The run was stopped during the call." });
    }
    const msg = scrubCredentials(describeError(err), opts.sentCredentials ?? new Set());
    logger.error({ agent, mode, err: msg, sessionId: opts.sessionId }, "a2a_call failed");
    return fail(`A2A call to "${agent}" failed: ${msg}`);
  }
}

/** fetch reports every transport failure as "fetch failed"; the reason is on `cause`. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? err.cause.message : "";
  return cause && !err.message.includes(cause) ? `${err.message}: ${cause}` : err.message;
}
