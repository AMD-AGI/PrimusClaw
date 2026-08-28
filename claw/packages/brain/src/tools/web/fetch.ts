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
import dns from "node:dns/promises";
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

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return true;
  const [a, b] = parts.map((p) => parseInt(p, 10));
  if (a === 0) return true;                          // 0.0.0.0/8
  if (a === 10) return true;                          // 10.0.0.0/8
  if (a === 127) return true;                         // 127.0.0.0/8
  if (a === 169 && b === 254) return true;            // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 (CGNAT)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmark)
  if (a >= 224) return true;                          // multicast + reserved
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // fc00::/7
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
      normalized.startsWith("fea") || normalized.startsWith("feb")) return true; // fe80::/10
  // IPv4-mapped IPv6
  if (normalized.startsWith("::ffff:")) {
    const v4 = normalized.slice(7);
    if (v4.includes(".") && isBlockedIPv4(v4)) return true;
  }
  return false;
}

async function ssrfCheck(hostname: string): Promise<void> {
  const results = await dns.lookup(hostname, { all: true });
  for (const { address, family } of results) {
    if (family === 4 && isBlockedIPv4(address)) {
      throw new Error(`SSRF: resolved IP ${address} is in a blocked range`);
    }
    if (family === 6 && isBlockedIPv6(address)) {
      throw new Error(`SSRF: resolved IPv6 ${address} is in a blocked range`);
    }
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

async function fetchWithRedirects(
  startUrl: URL,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<FetchResult> {
  const { default: axios } = await import("axios");
  let current = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await ssrfCheck(current.hostname);

    const resp = await axios.get(current.toString(), {
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
