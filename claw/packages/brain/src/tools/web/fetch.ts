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
import type { WebToolContext } from "./types.js";

const logger = pino({ name: "web-fetch" });

const USER_AGENT = "Claw-User (primus-claw/2.0; +https://support.anthropic.com/)";
const MAX_REDIRECTS = 10;

// ── SSRF guard ──

/**
 * Addresses web_fetch never connects to: loopback, private, link-local (cloud
 * metadata), CGNAT -- the blocks cluster Service and Pod ranges are drawn from --
 * documentation and reserved ranges, and the IPv6 forms that embed or route to them.
 * BlockList also matches IPv4-mapped IPv6 (::ffff:a.b.c.d) against the IPv4 rules.
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
    ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
    ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10],
    ["fec0::", 10], ["ff00::", 8],
  ] as const) list.addSubnet(prefix, bits, "ipv6");
  return list;
})();

export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return true;
  return BLOCKED_ADDRESSES.check(ip, family === 6 ? "ipv6" : "ipv4");
}

/** Names that only mean something inside a cluster or a host, refused before any lookup. */
const INTERNAL_NAME_RE = /(?:^|\.)(?:localhost|local|internal|svc|home\.arpa)$/i;

type Resolve = (
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
        return callback(new Error(`SSRF: ${hostname} resolves to blocked address ${blocked.address}`), "", 0);
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
    throw new Error(`SSRF: address ${bare} is in a blocked range`);
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

type TurndownLike = new (opts: Record<string, string>) => { turndown: (html: string) => string };
let TurndownCtor: TurndownLike | null = null;

async function htmlToMarkdown(html: string): Promise<string> {
  if (!TurndownCtor) {
    const mod = await import("turndown");
    TurndownCtor = (mod.default ?? mod) as TurndownLike;
  }
  const td = new TurndownCtor({ headingStyle: "atx", codeBlockStyle: "fenced" });
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
      literalAddressCheck(current.hostname);

      const resp = await axios.get(current.toString(), {
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

      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.location;
        if (!location) throw new Error(`Redirect ${resp.status} without Location header`);

        let next: URL;
        try { next = new URL(location, current.toString()); }
        catch { throw new Error(`Invalid redirect URL: ${location}`); }

        if (next.protocol !== "https:" && next.protocol !== "http:") {
          throw new Error(`Redirect to unsupported protocol: ${next.protocol}`);
        }
        if (next.username || next.password) {
          throw new Error("Redirect URL must not contain credentials");
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

    throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
  } finally {
    httpAgent.destroy();
    httpsAgent.destroy();
  }
}

// ── WebFetchService ──

export class WebFetchService {
  constructor(private ctx: WebToolContext) {}

  async execute(input: Record<string, unknown>): Promise<string> {
    const url = input.url as string;
    const prompt = (input.prompt as string) ?? "";
    const maxBytes = Math.min(
      Math.max(input.max_bytes as number || WEB_FETCH_MAX_BYTES, 1024),
      WEB_FETCH_MAX_BYTES,
    );
    const raw = !!(input.raw as boolean);

    let parsed: URL;
    try { parsed = validateUrl(url); }
    catch (err: unknown) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (isDomainBlocked(parsed.hostname)) {
      return `Error: domain ${parsed.hostname} is blocked by WEB_FETCH_DOMAIN_DENYLIST`;
    }

    const ck = cacheKey(parsed.toString(), raw ? "raw" : "", raw);
    const cached = cache.get(ck);
    if (cached && !prompt) {
      return buildOutput(cached.finalUrl, cached.statusCode, cached.contentType, cached.body.length, cached.body, false);
    }

    let result: FetchResult;
    try {
      result = await fetchWithRedirects(parsed, maxBytes, this.ctx.signal);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("SSRF")) return `Error: ${msg}`;
      if (msg.includes("ENOTFOUND")) return `Error: DNS resolution failed for ${parsed.hostname}`;
      if (msg.includes("EGRESS_BLOCKED") || (err as any)?.response?.headers?.["x-proxy-error"] === "blocked-by-allowlist") {
        return `Error: EGRESS_BLOCKED — the URL is blocked by the egress proxy allowlist`;
      }
      logger.warn({ url, err: msg }, "web_fetch_failed");
      return `Error: fetch failed — ${msg}`;
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

    // Fast path: preapproved markdown, no prompt, small enough
    if (
      !prompt &&
      !raw &&
      ct === "text/markdown" &&
      isPreapprovedHost(parsed.hostname, parsed.pathname) &&
      content.length < MAX_MARKDOWN_LENGTH
    ) {
      return buildOutput(result.finalUrl, result.statusCode, ct, result.body.length, content, false) + jsWarning;
    }

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

    return buildOutput(result.finalUrl, result.statusCode, ct, result.body.length, content, summarized, prompt) + jsWarning;
  }
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
): string {
  let header = `URL: ${url}\nStatus: ${statusCode}\nContent-Type: ${contentType}\nLength: ${byteLength} bytes`;
  if (byteLength > WEB_FETCH_MAX_BYTES) {
    header += ` (truncated to ${WEB_FETCH_MAX_BYTES})`;
  }
  if (summarized) {
    header += `\nSummarized: yes (${WEB_FETCH_SUMMARIZE_MODEL}, prompt="${(prompt ?? "").slice(0, 80)}")`;
  }
  header += "\n---\n";

  let body = content;
  if (body.length > WEB_FETCH_MAX_OUTPUT_CHARS) {
    body = body.slice(0, WEB_FETCH_MAX_OUTPUT_CHARS) + "\n\n[Content truncated due to length...]";
  }

  return header + body;
}
