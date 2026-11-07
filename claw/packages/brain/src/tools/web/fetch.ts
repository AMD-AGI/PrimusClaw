// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * WebFetchService — URL fetching with SSRF guard, HTML-to-Markdown conversion,
 * LRU cache, redirect handling, and optional Haiku summarization.
 *
 * Behavior parity target is Claude Code's public `WebFetch` tool; the SSRF
 * guard here is deliberately stronger (DNS resolution plus IP-range checks on
 * every hop) because Brain runs inside a cluster with no egress allowlist.
 */

import type { AxiosResponse } from "axios";
import { LRUCache } from "lru-cache";
import pino from "pino";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { URL } from "node:url";
import {
  WEB_FETCH_MAX_BYTES,
  WEB_FETCH_MAX_OUTPUT_CHARS,
  WEB_FETCH_DOMAIN_DENYLIST,
  WEB_FETCH_TIMEOUT_MS,
  WEB_FETCH_SUMMARIZE,
  WEB_FETCH_SUMMARIZE_MODEL,
  WEB_FETCH_CACHE_TTL_MS,
  WEB_FETCH_CACHE_MAX_BYTES,
} from "../../config.js";
import { isPreapprovedHost } from "./preapproved.js";
import { summarizeContent, MAX_MARKDOWN_LENGTH } from "./summarize.js";
import type { WebToolContext, WebToolOutcome } from "./types.js";
import { webSource } from "../citations.js";

const logger = pino({ name: "web-fetch" });

const USER_AGENT = "Claw-User (primus-claw/2.0; +https://support.anthropic.com/)";
const MAX_REDIRECTS = 10;

// ── SSRF guard ──

/**
 * Addresses web_fetch never connects to: loopback, private, link-local (cloud
 * metadata), CGNAT -- the blocks cluster Service and Pod ranges are drawn from --
 * documentation and reserved ranges, and the IPv6 forms that route to them.
 * IPv6 forms that carry an IPv4 address are judged by that address: see embeddedIPv4.
 */
const BLOCKED_ADDRESSES = (() => {
  const list = new net.BlockList();
  for (const [prefix, bits] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
    ["224.0.0.0", 3],
  ] as const) list.addSubnet(prefix, bits, "ipv4");
  for (const [prefix, bits] of [
    ["64:ff9b:1::", 48], ["100::", 64],
    ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10],
    ["fec0::", 10], ["ff00::", 8],
  ] as const) list.addSubnet(prefix, bits, "ipv6");
  return list;
})();

/** The 16 bytes of an IPv6 address, including a dotted IPv4 tail. */
function ipv6Bytes(ip: string): number[] {
  let text = ip;
  const tail: number[] = [];
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    text = dotted[1].endsWith("::") ? dotted[1] : dotted[1].slice(0, -1);
    const v4 = dotted[2].split(".").map(Number);
    tail.push(v4[0], v4[1], v4[2], v4[3]);
  }
  const [head, rest] = text.split("::");
  const groups = (part?: string) => (part ? part.split(":").filter(Boolean).map((g) => parseInt(g, 16)) : []);
  const left = groups(head);
  const right = rest === undefined ? [] : groups(rest);
  const missing = 8 - tail.length / 2 - left.length - right.length;
  const words = [...left, ...Array(rest === undefined ? 0 : missing).fill(0), ...right];
  return [...words.flatMap((w) => [w >> 8, w & 0xff]), ...tail];
}

/**
 * The IPv4 address an IPv6 address carries in its last 32 bits, for the forms
 * that do: IPv4-compatible (::/96, deprecated, so `[::169.254.169.254]` is
 * the metadata address), IPv4-mapped (::ffff:0:0/96), IPv4-translated
 * (::ffff:0:0:0/96) and NAT64 (64:ff9b::/96).
 */
function embeddedIPv4(ip: string): string | null {
  const b = ipv6Bytes(ip);
  const prefix = b.slice(0, 12);
  const zero = (xs: number[]) => xs.every((x) => x === 0);
  const carries =
    zero(prefix)
    || (zero(prefix.slice(0, 10)) && prefix[10] === 0xff && prefix[11] === 0xff)
    || (zero(prefix.slice(0, 8)) && prefix[8] === 0xff && prefix[9] === 0xff && zero(prefix.slice(10)))
    || (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(prefix.slice(4)));
  return carries ? b.slice(12).join(".") : null;
}

export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return true;
  if (family === 6) {
    const v4 = embeddedIPv4(ip);
    if (v4 !== null) return BLOCKED_ADDRESSES.check(v4, "ipv4");
    return BLOCKED_ADDRESSES.check(ip, "ipv6");
  }
  return BLOCKED_ADDRESSES.check(ip, "ipv4");
}

/** Names that only mean something inside a cluster or a host, refused before any lookup. */
const INTERNAL_NAME_RE = /(?:^|\.)(?:localhost|local|internal|svc|home\.arpa)$/i;

/** The guard refused an address: one a name resolved to, or an IP literal. Its message is for the log (`WebFetchFailure`). */
class BlockedAddressError extends Error {}

/**
 * A failed fetch, said in this file's own words. `text` is what the model is told, and it is built from fixed phrases, numbers
 * (an HTTP status, a limit), and the host the model itself asked for, and from nothing else: no status text, body or header a
 * server sent (a Location included), no certificate field, no address a name resolved to, no part of a redirect target. A
 * failed call counts as having read nothing (`WebToolOutcome`), so its text must hold nothing anyone else wrote. The error it
 * stands for is `cause`, for the log.
 */
export class WebFetchFailure extends Error {
  constructor(readonly text: string, options?: { cause?: unknown }) {
    super(text, options);
    this.name = "WebFetchFailure";
  }
}

/** Errors whose `code` names what went wrong, each in fixed words. Any other is "the request failed". */
const FAILURE_BY_CODE: Record<string, string> = {
  EAI_AGAIN: "the DNS lookup did not complete",
  ECONNREFUSED: "the connection was refused",
  ECONNRESET: "the connection was reset",
  EPIPE: "the connection was reset",
  EHOSTUNREACH: "the host is unreachable",
  ENETUNREACH: "the network is unreachable",
  ETIMEDOUT: "timed out",
  ECONNABORTED: "timed out",
  ERR_CANCELED: "cancelled",
  ERR_TLS_CERT_ALTNAME_INVALID: "the server's TLS certificate is not for this host",
  CERT_HAS_EXPIRED: "the server's TLS certificate has expired",
  CERT_NOT_YET_VALID: "the server's TLS certificate is not valid yet",
  DEPTH_ZERO_SELF_SIGNED_CERT: "the server's TLS certificate is not trusted",
  SELF_SIGNED_CERT_IN_CHAIN: "the server's TLS certificate is not trusted",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "the server's TLS certificate is not trusted",
  UNABLE_TO_GET_ISSUER_CERT: "the server's TLS certificate is not trusted",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "the server's TLS certificate is not trusted",
  CERT_UNTRUSTED: "the server's TLS certificate is not trusted",
  CERT_REVOKED: "the server's TLS certificate is revoked",
  ERR_BAD_RESPONSE: "the response could not be read (too large, or malformed)",
};

/**
 * What a request that threw is told as (`WebFetchFailure`): by the error's class, its HTTP status or its code, never by its
 * message, which can carry what the server sent (a certificate's names, an address). `host` is the host the model asked for,
 * or null on a hop after a redirect, whose host came from a Location header.
 */
function requestFailure(err: unknown, host: string | null): string {
  const chain = [err, (err as { cause?: unknown } | null)?.cause];
  if (chain.some((e) => e instanceof BlockedAddressError)) {
    return `SSRF: ${host ?? "a redirect target"} resolves to a blocked address (private, internal or reserved)`;
  }
  const e = err as { code?: unknown; response?: { status?: unknown; headers?: Record<string, unknown> } } | null;
  if (e?.response?.headers?.["x-proxy-error"] === "blocked-by-allowlist") {
    return "EGRESS_BLOCKED — the URL is blocked by the egress proxy allowlist";
  }
  const status = e?.response?.status;
  if (typeof status === "number" && Number.isInteger(status)) {
    return `fetch failed — ${host ? "the server" : "a redirect target"} answered HTTP ${status}`;
  }
  const code = typeof e?.code === "string" ? e.code : "";
  if (code === "ENOTFOUND") return `DNS resolution failed for ${host ?? "a redirect target"}`;
  if (code.startsWith("HPE_")) return "fetch failed — the server's response could not be parsed";
  const said = Object.hasOwn(FAILURE_BY_CODE, code) ? FAILURE_BY_CODE[code] : "the request failed";
  return `fetch failed — ${host ? "" : "on a redirect target, "}${said}`;
}

export type Resolve = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void;

/**
 * The `lookup` the HTTP agents connect through.
 *
 * The check sits here, on the address the socket is about to dial, rather than
 * in a lookup made before the request: a separate lookup answers a different
 * question than the connection's own, and a name with a short TTL can answer
 * public to the first and private to the second. The name is resolved as
 * absolute (trailing dot) so the resolver's search domains cannot turn
 * `service.namespace` into an in-cluster address.
 */
export function guardedLookup(resolve: Resolve = dns.lookup as unknown as Resolve): net.LookupFunction {
  return (hostname, options, callback) => {
    const name = hostname.endsWith(".") ? hostname : `${hostname}.`;
    resolve(name, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      const blocked = addresses.find((a) => isBlockedAddress(a.address));
      if (blocked) {
        return callback(new BlockedAddressError(`SSRF: ${hostname} resolves to blocked address ${blocked.address}`), "", 0);
      }
      if (addresses.length === 0) {
        return callback(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }), "", 0);
      }
      if ((options as dns.LookupOptions).all) return callback(null, addresses as unknown as string);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

/** An IP-literal host never reaches `lookup`, so it is checked on its own. */
function literalAddressCheck(hostname: string): void {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(bare) && isBlockedAddress(bare)) {
    throw new BlockedAddressError(`SSRF: address ${bare} is in a blocked range`);
  }
}

// ── URL validation ──

function validateUrl(raw: string): URL {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("URL is required");

  let urlStr = raw.trim();
  if (urlStr.startsWith("http://")) urlStr = "https://" + urlStr.slice(7);
  if (!urlStr.startsWith("https://")) {
    if (!urlStr.includes("://")) urlStr = "https://" + urlStr;
    else throw new Error(`Unsupported protocol: only http(s) allowed`);
  }

  const parsed = new URL(urlStr);
  if (parsed.username || parsed.password) throw new Error("URL must not contain credentials");
  if (!parsed.hostname.includes(".")) throw new Error("Hostname must contain at least one dot");
  if (INTERNAL_NAME_RE.test(parsed.hostname.replace(/\.$/, ""))) {
    throw new Error(`SSRF: ${parsed.hostname} is an internal name`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }
  return parsed;
}

function isDomainBlocked(hostname: string): boolean {
  const denylist = WEB_FETCH_DOMAIN_DENYLIST.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const h = hostname.toLowerCase();
  return denylist.some((d) => h === d || h.endsWith("." + d));
}

// ── Redirect validation ──

function isSameHost(a: URL, b: URL): boolean {
  const norm = (h: string) => h.replace(/^www\./, "").toLowerCase();
  return norm(a.hostname) === norm(b.hostname) && a.port === b.port && a.protocol === b.protocol;
}

// ── HTML → Markdown conversion ──

interface TurndownNode { nodeName: string; getAttribute?: (name: string) => string | null }
type TurndownLike = new (opts: Record<string, string>) => {
  turndown: (html: string) => string;
  addRule: (key: string, rule: { filter: (node: TurndownNode) => boolean; replacement: (content: string, node: TurndownNode) => string }) => void;
};
let TurndownCtor: TurndownLike | null = null;

/** The most values of one condition key `showCondition` names before it says how many more there are. */
const SHOW_COND_VALUES_MAX = 12;
const BLOCK_NODES = new Set(["DIV", "TABLE", "TBODY", "THEAD", "TR", "SECTION", "UL", "OL", "P"]);

/**
 * What a page's `data-show-cond` (rocm-docs selectors: a cell or block shown only for some GPUs, OS families or versions) says, as
 * text, or null. A page that picks what to show by script is flattened to every variant at once; without this, a reader cannot tell
 * which row belongs to which choice (parity R2: Rocky Linux 9 read as an MI355X distribution when the page shows it for MI300X only).
 */
export function showCondition(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let cond: unknown;
  try { cond = JSON.parse(raw); } catch { return null; }
  if (!cond || typeof cond !== "object" || Array.isArray(cond)) return null;
  const parts: string[] = [];
  for (const [key, values] of Object.entries(cond as Record<string, unknown>).slice(0, 4)) {
    if (!Array.isArray(values)) continue;
    const vs = values.filter((v): v is string | number => typeof v === "string" || typeof v === "number").map((v) => String(v).slice(0, 60));
    if (!vs.length) continue;
    const more = vs.length > SHOW_COND_VALUES_MAX ? `, +${vs.length - SHOW_COND_VALUES_MAX} more` : "";
    parts.push(`${key.slice(0, 30)}: ${vs.slice(0, SHOW_COND_VALUES_MAX).join(", ")}${more}`);
  }
  return parts.length ? `(shown only for ${parts.join("; ")})` : null;
}

export async function htmlToMarkdown(html: string): Promise<string> {
  if (!TurndownCtor) {
    const mod = await import("turndown");
    TurndownCtor = (mod.default ?? mod) as TurndownLike;
  }
  const td = new TurndownCtor({ headingStyle: "atx", codeBlockStyle: "fenced" });
  td.addRule("showCondition", {
    filter: (node) => !!showCondition(node.getAttribute?.("data-show-cond")),
    replacement: (content, node) => {
      const note = showCondition(node.getAttribute?.("data-show-cond"))!;
      return BLOCK_NODES.has(node.nodeName) ? `\n\n${note}\n${content}\n\n` : ` ${note} ${content} `;
    },
  });
  return td.turndown(html);
}

// ── JS shell detection ──

/**
 * Heuristic: does this page look like an empty JS app shell (a React/Next/Vue
 * root div and little else) rather than a document with readable prose?
 *
 * The `replace(/<[^>]*>/g, "")` below is NOT a sanitiser, and `stripped` is not
 * sanitised output — static analysis (CodeQL js/incomplete-multi-character-
 * sanitization) flags it as one, so this note is here to keep the next reader
 * from "hardening" it. It is a cheap estimate of how much visible text the page
 * has, and its only consumer is the `.length` comparison on the very next line.
 * `stripped` is never returned, never concatenated into the tool result, and
 * never handed to a browser: web_fetch returns plain text that a model reads,
 * the real HTML→Markdown conversion is done by Turndown in htmlToMarkdown(),
 * and nothing in this repo renders a tool result as HTML. A crafted input like
 * `<<div>div>` does leave a residual `<div` in `stripped`, but the worst that
 * buys an attacker is shifting this length estimate by a few characters and
 * flipping an advisory "JS_RENDER_REQUIRED" hint — there is no injection sink
 * on this path, so looping the strip until fixpoint would defend nothing.
 *
 * If you ever make `stripped` escape this function — return it, log it, put it
 * in the tool output — that reasoning stops holding and it must be re-examined.
 */
function looksLikeJsShell(text: string): boolean {
  const stripped = text.replace(/<[^>]*>/g, "").trim();
  if (stripped.length > 500) return false;
  const markers = ['<div id="root">', '<div id="app">', "<noscript>", "enable JavaScript", "id=\"__next\""];
  return markers.some((m) => text.includes(m));
}

// ── LRU cache ──

interface CacheEntry {
  body: string;
  contentType: string;
  statusCode: number;
  finalUrl: string;
}

const cache = new LRUCache<string, CacheEntry>({
  maxSize: WEB_FETCH_CACHE_MAX_BYTES,
  sizeCalculation: (v) => v.body.length,
  ttl: WEB_FETCH_CACHE_TTL_MS,
});

function cacheKey(url: string, contentType: string, raw: boolean): string {
  return `${url}|${contentType}|${raw}`;
}

// ── Core fetch with redirect handling ──

interface FetchResult {
  body: Buffer;
  contentType: string;
  statusCode: number;
  finalUrl: string;
  redirectInfo?: string;
}

/**
 * Fetch `startUrl`, following redirects to the same host. Every failure is thrown as a `WebFetchFailure`, whose text names at
 * most the host the model asked for: a hop after a redirect is "a redirect target", since its address came from the server.
 */
export async function fetchWithRedirects(
  startUrl: URL,
  maxBytes: number,
  signal?: AbortSignal,
  resolve?: Resolve,
): Promise<FetchResult> {
  const { default: axios } = await import("axios");
  const lookup = guardedLookup(resolve);
  // Fresh agents, so no pooled socket dialled before this check is reused.
  const httpAgent = new http.Agent({ lookup });
  const httpsAgent = new https.Agent({ lookup });
  let current = startUrl;

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let resp: AxiosResponse<ArrayBuffer>;
      try {
        literalAddressCheck(current.hostname);
        resp = await axios.get(current.toString(), {
          httpAgent,
          httpsAgent,
          // A proxy would resolve the name itself and the guard above would never see it.
          proxy: false,
          maxRedirects: 0,
          maxContentLength: maxBytes,
          responseType: "arraybuffer",
          timeout: WEB_FETCH_TIMEOUT_MS,
          headers: { "User-Agent": USER_AGENT },
          signal,
          validateStatus: (s: number) => s < 400 || (s >= 300 && s < 400),
        });
      } catch (err: unknown) {
        throw new WebFetchFailure(requestFailure(err, hop === 0 ? startUrl.hostname : null), { cause: err });
      }

      if (resp.status >= 300 && resp.status < 400) {
        // Not the header's text, nor any part of the address it names: what a server sends never reaches a failure's text.
        const location = resp.headers.location;
        if (!location) throw new WebFetchFailure(`fetch failed — a redirect (HTTP ${resp.status}) came without a Location header`);

        let next: URL;
        try { next = new URL(String(location), current.toString()); }
        catch { throw new WebFetchFailure("fetch failed — a redirect named an invalid URL in its Location header"); }

        if (next.protocol !== "https:" && next.protocol !== "http:") {
          throw new WebFetchFailure("fetch failed — a redirect named a protocol other than http or https");
        }
        if (next.username || next.password) {
          throw new WebFetchFailure("fetch failed — a redirect named a URL with credentials in it");
        }

        if (!isSameHost(current, next)) {
          const statusText = { 301: "Moved Permanently", 302: "Found", 307: "Temporary Redirect", 308: "Permanent Redirect" };
          return {
            body: Buffer.alloc(0),
            contentType: "",
            statusCode: resp.status,
            finalUrl: next.toString(),
            redirectInfo: [
              "REDIRECT DETECTED: The URL redirects to a different host.",
              `Original URL: ${startUrl.toString()}`,
              `Redirected URL: ${next.toString()}`,
              `Status: ${resp.status} ${(statusText as any)[resp.status] ?? "Redirect"}`,
              "",
              "Please call web_fetch again with the redirected URL and the same prompt if you still want this content.",
            ].join("\n"),
          };
        }

        current = next;
        continue;
      }

      return {
        body: Buffer.from(resp.data),
        contentType: String(resp.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase(),
        statusCode: resp.status,
        finalUrl: current.toString(),
      };
    }

    throw new WebFetchFailure(`fetch failed — too many redirects (more than ${MAX_REDIRECTS})`);
  } finally {
    httpAgent.destroy();
    httpsAgent.destroy();
  }
}

// ── WebFetchService ──

export class WebFetchService {
  /** `resolve`: the name lookup the connection's guard asks (`guardedLookup`); the system's by default. */
  constructor(private ctx: WebToolContext, private resolve?: Resolve) {}

  /**
   * A failure before any page was read (the URL refused, the address refused, the name unresolved, the request failed) is marked
   * in `outcome`, and its text is in this file's own words: fixed phrases, a number, and the URL the model gave
   * (`WebFetchFailure`). What a page sent is never marked, a redirect to another host or a content type it named included: it
   * is text a server chose, and a failed call counts as having read nothing (`WebToolOutcome`).
   */
  async execute(input: Record<string, unknown>, outcome?: WebToolOutcome): Promise<string> {
    const fail = (text: string): string => {
      if (outcome) outcome.isError = true;
      return text;
    };
    const url = input.url as string;
    const prompt = (input.prompt as string) ?? "";
    const maxBytes = Math.min(
      Math.max(input.max_bytes as number || WEB_FETCH_MAX_BYTES, 1024),
      WEB_FETCH_MAX_BYTES,
    );
    const raw = !!(input.raw as boolean);
    const part = pagePart(input);

    let parsed: URL;
    try { parsed = validateUrl(url); }
    catch (err: unknown) {
      return fail(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (isDomainBlocked(parsed.hostname)) {
      return fail(`Error: domain ${parsed.hostname} is blocked by WEB_FETCH_DOMAIN_DENYLIST`);
    }

    // The page this call read whole, as a source (`tools/citations.ts`, which keeps it only where it confirms an address the turn
    // already had): only a page it returned, never a redirect it reported, an error or content it would not read.
    const read = (finalUrl: string): void => {
      const source = outcome && webSource(finalUrl);
      if (outcome && source) outcome.sources = [source];
    };

    const ck = cacheKey(parsed.toString(), raw ? "raw" : "", raw);
    const cached = cache.get(ck);
    if (cached && !prompt) {
      read(cached.finalUrl);
      const shown = selectPart(cached.body, part);
      return buildOutput(cached.finalUrl, cached.statusCode, cached.contentType, cached.body.length, shown.text, false, undefined, shown.note);
    }

    let result: FetchResult;
    try {
      result = await fetchWithRedirects(parsed, maxBytes, this.ctx.signal, this.resolve);
    } catch (err: unknown) {
      // The error's own message (a certificate's names, an address, what a server sent) goes to the log only.
      const cause = err instanceof WebFetchFailure ? err.cause : err;
      logger.warn({ url, err: cause instanceof Error ? cause.message : String(cause) }, "web_fetch_failed");
      return fail(`Error: ${err instanceof WebFetchFailure ? err.text : "fetch failed — the request failed"}`);
    }

    if (result.redirectInfo) return result.redirectInfo;

    const ct = result.contentType;
    const bodyStr = result.body.toString("utf-8");

    if (!ct.startsWith("text/") && ct !== "application/json" && ct !== "application/xml") {
      return `Error: unsupported binary content-type ${ct}. Use a browser MCP tool for this content.`;
    }

    let content: string;
    if (raw) {
      content = bodyStr;
    } else if (ct === "text/html") {
      try { content = await htmlToMarkdown(bodyStr); }
      catch { content = bodyStr; }
    } else {
      content = bodyStr;
    }

    read(result.finalUrl);

    // Cache the fetched/decoded content (not summarized)
    cache.set(ck, {
      body: content,
      contentType: ct,
      statusCode: result.statusCode,
      finalUrl: result.finalUrl,
    });

    // JS shell detection
    let jsWarning = "";
    if (!raw && ct === "text/html" && looksLikeJsShell(content)) {
      jsWarning = "\n\nJS_RENDER_REQUIRED: This page appears to require JavaScript rendering.\n" +
        "Use the configured browser/Playwright MCP tool to inspect it.";
    }

    // The part of the page asked for (`find`, `offset`), and what the reader is told about the rest. A page larger than one answer
    // is read in parts: the part that holds a word, or from an offset on, instead of its first part only.
    const shown = selectPart(content, part, WEB_FETCH_SUMMARIZE && prompt && !raw ? MAX_MARKDOWN_LENGTH : WEB_FETCH_MAX_OUTPUT_CHARS);

    // Fast path: preapproved markdown, no prompt, small enough
    if (
      !prompt &&
      !raw &&
      ct === "text/markdown" &&
      isPreapprovedHost(parsed.hostname, parsed.pathname) &&
      content.length < MAX_MARKDOWN_LENGTH
    ) {
      return buildOutput(result.finalUrl, result.statusCode, ct, result.body.length, shown.text, false, undefined, shown.note) + jsWarning;
    }
    content = shown.text;

    // Summarize if enabled and prompt is set
    let summarized = false;
    if (WEB_FETCH_SUMMARIZE && prompt && !raw) {
      try {
        content = await summarizeContent({
          markdown: content,
          prompt,
          url: result.finalUrl,
          anthropic: this.ctx.anthropic,
          sessionCost: this.ctx.sessionCost,
          signal: this.ctx.signal,
        });
        summarized = true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ url, err: msg }, "summarize_fallback_to_raw");
      }
    }

    return buildOutput(result.finalUrl, result.statusCode, ct, result.body.length, content, summarized, prompt, shown.note) + jsWarning;
  }
}

// ── Reading a large page in parts ──

/** Around each place `find` matches, this much of the page before and after it is shown. */
export const FIND_CONTEXT_CHARS = 1500;
/** At most this many places are shown for one `find`. */
export const FIND_MAX_MATCHES = 20;

export interface PagePart { offset: number; find: string }

/** What a call asks to read of a page: from `offset` (a character of the converted page), or around each match of `find`. */
export function pagePart(input: Record<string, unknown>): PagePart {
  const n = Number(input.offset);
  const offset = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  const find = typeof input.find === "string" ? input.find.trim().slice(0, 200) : "";
  return { offset, find };
}

/**
 * The part of `content` a call reads, at most `max` characters, and a note that says what part it is and how to read the rest. With
 * `find`: the text around each place it appears (case-insensitive), joined where they overlap, in page order; none found is said, with
 * the page's length. Otherwise: `max` characters from `offset`. A page that fits whole, read from its start, has no note.
 *
 * The feature-gate page of Kubernetes converts to several hundred thousand characters; its first 50,000 end in the letter C, so
 * `SchedulerQueueingHints` could not be read at all and the answer was given from a blog post (2026-11-06 parity run, R1).
 */
export function selectPart(content: string, part: PagePart, max: number = WEB_FETCH_MAX_OUTPUT_CHARS): { text: string; note: string } {
  const total = content.length;
  if (part.find) {
    const hay = content.toLowerCase();
    const needle = part.find.toLowerCase();
    const spans: Array<[number, number]> = [];
    let matches = 0;
    for (let at = hay.indexOf(needle); at >= 0 && matches < FIND_MAX_MATCHES; at = hay.indexOf(needle, at + needle.length)) {
      matches += 1;
      const span: [number, number] = [Math.max(0, at - FIND_CONTEXT_CHARS), Math.min(total, at + needle.length + FIND_CONTEXT_CHARS)];
      const last = spans.at(-1);
      if (last && span[0] <= last[1]) last[1] = span[1];
      else spans.push(span);
    }
    if (!matches) {
      return { text: "", note: `"${part.find}" does not appear on this page (${total} characters). Read it with offset, or find another word.` };
    }
    let text = "";
    let shownUpTo = 0;
    for (const [a, b] of spans) {
      const piece = `[characters ${a}-${b} of ${total}]\n${content.slice(a, b)}\n\n`;
      if (text.length + piece.length > max) break;
      text += piece;
      shownUpTo = b;
    }
    if (!text) text = `[characters ${spans[0][0]}-${spans[0][0] + max} of ${total}]\n${content.slice(spans[0][0], spans[0][0] + max)}`;
    const more = matches >= FIND_MAX_MATCHES || shownUpTo < spans.at(-1)![1] ? " There may be more matches: narrow find, or read on with offset." : "";
    return { text, note: `Showing the page around ${matches} match${matches > 1 ? "es" : ""} of "${part.find}" (the page has ${total} characters).${more}` };
  }
  const start = Math.min(part.offset, total);
  const end = Math.min(total, start + max);
  if (start === 0 && end === total) return { text: content, note: "" };
  const rest = end < total
    ? ` Call web_fetch again with offset=${end} to read on, or with find set to a word of the part you need.`
    : " That is the end of the page.";
  return { text: content.slice(start, end), note: `Showing characters ${start}-${end} of ${total}.${rest}` };
}

// ── Build output header ──

function buildOutput(
  url: string,
  statusCode: number,
  contentType: string,
  byteLength: number,
  content: string,
  summarized: boolean,
  prompt?: string,
  part = "",
): string {
  let header = `URL: ${url}\nStatus: ${statusCode}\nContent-Type: ${contentType}\nLength: ${byteLength} bytes`;
  if (byteLength > WEB_FETCH_MAX_BYTES) {
    header += ` (truncated to ${WEB_FETCH_MAX_BYTES})`;
  }
  if (summarized) {
    header += `\nSummarized: yes (${WEB_FETCH_SUMMARIZE_MODEL}, prompt="${(prompt ?? "").slice(0, 80)}")`;
  }
  if (part) header += `\nPart: ${part}`;
  header += "\n---\n";

  let body = content;
  if (body.length > WEB_FETCH_MAX_OUTPUT_CHARS) {
    body = body.slice(0, WEB_FETCH_MAX_OUTPUT_CHARS) + "\n\n[Content truncated due to length...]";
  }

  return header + body;
}
