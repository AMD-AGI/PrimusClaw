// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * WebSearchService — unified web search dispatching to Anthropic native,
 * Tavily, Brave, Serper, or the keyless DuckDuckGo HTML backend.
 *
 * The Anthropic native path wraps the server-side search tool in a short
 * auxiliary Messages call, so `web_search` stays an ordinary client-side tool
 * from the main agent loop's point of view.
 */

import pino from "pino";
import {
  WEB_SEARCH_PROVIDER,
  WEB_SEARCH_FALLBACK,
  WEB_SEARCH_MAX_USES,
  WEB_SEARCH_MODEL,
  WEB_SEARCH_FORCE_TOOL,
  WEB_SEARCH_DOMAIN_DENYLIST,
  TAVILY_API_KEY,
  BRAVE_API_KEY,
  SERPER_API_KEY,
} from "../../config.js";
import type { CiteSource } from "@claw/protocol";
import type { WebToolContext, WebToolOutcome, WebSearchProvider, SearchHit } from "./types.js";
import { webSource } from "../citations.js";

const logger = pino({ name: "web-search" });

const MAX_RESULT_SIZE_CHARS = 100_000;

// ── Rate limiter (30 req/min per session, in-memory leaky bucket) ──

class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  constructor(private maxTokens: number, private refillPerMs: number) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }
  tryConsume(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.maxTokens, this.tokens + (now - this.lastRefill) * this.refillPerMs);
    this.lastRefill = now;
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    return false;
  }
}

// ── Input / Output types ──

export interface WebSearchInput {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
  max_results?: number;
  site?: string;
  freshness?: string;
}

// ── Domain denylist helpers ──

function parseDenylist(csv: string): string[] {
  return csv.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function domainMatchesAny(domain: string, denylist: string[]): boolean {
  const d = domain.toLowerCase();
  return denylist.some((denied) => d === denied || d.endsWith("." + denied));
}

// ── Backend failures ──

/** A backend that failed in a way this file names itself (no key for it, the search tool's own error code): its message is this file's own. */
class BackendFailure extends Error {}

/** The error codes the native search tool answers with (`web_search_tool_result_error`). Any other is said as "search error". */
const SEARCH_TOOL_ERROR_CODES = new Set(["too_many_requests", "invalid_input", "max_uses_exceeded", "query_too_long", "unavailable"]);

/**
 * A backend's failure, in this file's own words: by the error's class, its HTTP status or its code, never by its message. A
 * backend's message is its body, its error JSON or its status text, and the failure of a search counts as having read nothing
 * (`WebToolOutcome`). The message goes to the log.
 */
function backendFailure(err: unknown): string {
  if (err instanceof BackendFailure) return err.message;
  const e = err as { status?: unknown; response?: { status?: unknown }; code?: unknown } | null;
  const status = typeof e?.status === "number" ? e.status : e?.response?.status;
  if (typeof status === "number" && Number.isInteger(status)) return `HTTP ${status}`;
  const code = typeof e?.code === "string" ? e.code : "";
  // The Anthropic SDK's connection errors carry neither a status nor a code, only their class.
  const sdkClass = err instanceof Error ? err.constructor.name : "";
  if (code === "ECONNABORTED" || code === "ETIMEDOUT" || sdkClass === "APIConnectionTimeoutError") return "timed out";
  if (["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"].includes(code) || sdkClass === "APIConnectionError") {
    return "could not be reached";
  }
  return "failed";
}

// ── Anthropic native search (sub-LLM wrapper) ──

async function executeAnthropicSearch(
  input: WebSearchInput,
  ctx: WebToolContext,
  fail: (text: string) => string,
  outcome?: WebToolOutcome,
): Promise<string> {
  const query = (input.query ?? "").trim();
  if (query.length < 2) return fail("Error: query must be at least 2 characters.");

  const globalDenylist = parseDenylist(WEB_SEARCH_DOMAIN_DENYLIST);
  const rawAllowed = input.allowed_domains ?? (input.site ? [input.site] : undefined);
  const allowedDomains = rawAllowed?.filter((d) => !domainMatchesAny(d, globalDenylist));

  if (rawAllowed && allowedDomains && allowedDomains.length !== rawAllowed.length) {
    return fail("Error: allowed_domains contains a domain blocked by WEB_SEARCH_DOMAIN_DENYLIST");
  }

  const blockedDomains = allowedDomains?.length
    ? undefined
    : [...(input.blocked_domains ?? []), ...globalDenylist].filter(Boolean);

  if (allowedDomains?.length && blockedDomains?.length) {
    return fail("Error: allowed_domains and blocked_domains cannot both be non-empty.");
  }

  const model = WEB_SEARCH_MODEL || ctx.model;

  const stream = ctx.anthropic.beta.messages.stream({
    model,
    max_tokens: 2048,
    system: "You are an assistant for performing a web search tool use",
    messages: [{ role: "user", content: `Perform a web search for the query: ${query}` }],
    tools: [{
      type: "web_search_20250305" as any,
      name: "web_search",
      max_uses: WEB_SEARCH_MAX_USES,
      ...(allowedDomains?.length ? { allowed_domains: allowedDomains } : {}),
      ...(blockedDomains?.length ? { blocked_domains: blockedDomains } : {}),
    } as any],
    ...(WEB_SEARCH_FORCE_TOOL
      ? { tool_choice: { type: "tool" as const, name: "web_search" } }
      : {}),
  });

  for await (const _event of stream) {
    // Drain the stream; SDK accumulates content blocks internally.
  }

  const finalMsg = await stream.finalMessage();

    const rawUsage = finalMsg.usage as unknown as Record<string, number>;
    ctx.sessionCost.addUsage({
      input_tokens: finalMsg.usage.input_tokens,
      output_tokens: finalMsg.usage.output_tokens,
      cache_read: rawUsage.cache_read_input_tokens ?? 0,
      cache_create: rawUsage.cache_creation_input_tokens ?? 0,
    });

  // The search tool failed and found nothing: a failure of this backend, like one that threw (the next backend is tried), said
  // by its error code alone. What the model wrote around it is not passed on: a failed search counts as having read nothing.
  const blocks = (finalMsg.content ?? []) as any[];
  const results = blocks.filter((b) => b?.type === "web_search_tool_result");
  const errors = results.filter((b) => !Array.isArray(b.content)).map((b) => b.content?.error_code);
  if (errors.length && !results.some((b) => Array.isArray(b.content) && b.content.length > 0)) {
    const code = errors.find((c) => SEARCH_TOOL_ERROR_CODES.has(c));
    throw new BackendFailure(code ? `search error ${code}` : "search error");
  }

  if (outcome) outcome.sources = searchSources(nativeSearchHits(blocks));
  return formatWebSearchResult(query, blocks);
}

/** The pages the native search tool answered with: every `web_search_tool_result` block's results, in order. */
export function nativeSearchHits(blocks: any[]): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const block of blocks ?? []) {
    if (block?.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue;
    for (const r of block.content) {
      if (r && typeof r.url === "string") hits.push({ title: typeof r.title === "string" ? r.title : "", url: r.url });
    }
  }
  return hits;
}

/** A search's hits as sources: each one whose address can be a source, once. */
export function searchSources(hits: readonly SearchHit[]): CiteSource[] {
  const out: CiteSource[] = [];
  for (const hit of hits) {
    const source = webSource(hit.url, hit.title);
    if (source && !out.some((s) => s.url === source.url)) out.push(source);
  }
  return out;
}

// ── Format result ──

export function formatWebSearchResult(query: string, blocks: any[]): string {
  let output = `Web search results for query: "${query}"\n\n`;
  let hasLinks = false;

  for (const block of blocks ?? []) {
    if (block == null) continue;

    if (block.type === "server_tool_use") continue;

    if (block.type === "web_search_tool_result") {
      if (Array.isArray(block.content)) {
        const hits = block.content.map((r: any) => ({ title: r.title, url: r.url }));
        if (hits.length > 0) {
          output += `Links: ${JSON.stringify(hits)}\n\n`;
          hasLinks = true;
        } else {
          output += "No links found.\n\n";
        }
      } else {
        const errorCode = block.content?.error_code ?? "unknown";
        output += `Web search error: ${errorCode}\n\n`;
        logger.warn({ errorCode, query }, "web_search_tool_result_error");
      }
      continue;
    }

    if (block.type === "text" && block.text) {
      output += block.text + "\n\n";
      continue;
    }
  }

  if (!hasLinks && !output.includes("No links found.")) {
    output += "No links found.\n\n";
  }

  output += "\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.";

  if (output.length > MAX_RESULT_SIZE_CHARS) {
    output = output.slice(0, MAX_RESULT_SIZE_CHARS) + "\n[Results truncated due to length...]";
  }

  return output.trim();
}

// ── Third-party provider: Tavily ──

class TavilyProvider implements WebSearchProvider {
  readonly name = "tavily";
  async search(query: string, opts: {
    maxResults?: number;
    allowedDomains?: string[];
    blockedDomains?: string[];
    freshness?: string;
  }): Promise<SearchHit[]> {
    if (!TAVILY_API_KEY) throw new BackendFailure("TAVILY_API_KEY not configured");
    const { default: axios } = await import("axios");

    const freshnessMap: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
    const body: Record<string, unknown> = {
      api_key: TAVILY_API_KEY,
      query,
      max_results: opts.maxResults ?? 5,
      ...(opts.allowedDomains?.length ? { include_domains: opts.allowedDomains } : {}),
      ...(opts.blockedDomains?.length ? { exclude_domains: opts.blockedDomains } : {}),
      ...(opts.freshness && freshnessMap[opts.freshness] ? { days: freshnessMap[opts.freshness] } : {}),
    };

    const resp = await axios.post("https://api.tavily.com/search", body, { timeout: 15_000 });
    return (resp.data.results ?? []).map((r: any) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.content ?? "",
    }));
  }
}

// ── Third-party provider: Brave ──

class BraveProvider implements WebSearchProvider {
  readonly name = "brave";
  async search(query: string, opts: {
    maxResults?: number;
    allowedDomains?: string[];
    blockedDomains?: string[];
    freshness?: string;
  }): Promise<SearchHit[]> {
    if (!BRAVE_API_KEY) throw new BackendFailure("BRAVE_API_KEY not configured");
    const { default: axios } = await import("axios");

    let q = query;
    if (opts.allowedDomains?.length) {
      q += " " + opts.allowedDomains.map((d) => `site:${d}`).join(" OR ");
    }

    const freshnessMap: Record<string, string> = { day: "pd", week: "pw", month: "pm", year: "py" };
    const params: Record<string, unknown> = {
      q,
      count: opts.maxResults ?? 5,
      ...(opts.freshness && freshnessMap[opts.freshness] ? { freshness: freshnessMap[opts.freshness] } : {}),
    };

    const resp = await axios.get("https://api.search.brave.com/res/v1/web/search", {
      params,
      headers: { "X-Subscription-Token": BRAVE_API_KEY, Accept: "application/json" },
      timeout: 15_000,
    });

    let results: SearchHit[] = (resp.data.web?.results ?? []).map((r: any) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.description ?? "",
    }));

    if (opts.blockedDomains?.length) {
      results = results.filter((h) => {
        try {
          const host = new URL(h.url).hostname.toLowerCase();
          return !domainMatchesAny(host, opts.blockedDomains!);
        } catch { return false; }
      });
    }

    return results;
  }
}

// ── Third-party provider: Serper ──

class SerperProvider implements WebSearchProvider {
  readonly name = "serper";
  async search(query: string, opts: {
    maxResults?: number;
    allowedDomains?: string[];
    blockedDomains?: string[];
    freshness?: string;
  }): Promise<SearchHit[]> {
    if (!SERPER_API_KEY) throw new BackendFailure("SERPER_API_KEY not configured");
    const { default: axios } = await import("axios");

    let q = query;
    if (opts.allowedDomains?.length) {
      q += " " + opts.allowedDomains.map((d) => `site:${d}`).join(" OR ");
    }

    const freshnessMap: Record<string, string> = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" };
    const body: Record<string, unknown> = {
      q,
      num: opts.maxResults ?? 5,
      ...(opts.freshness && freshnessMap[opts.freshness] ? { tbs: freshnessMap[opts.freshness] } : {}),
    };

    const resp = await axios.post("https://google.serper.dev/search", body, {
      headers: { "X-API-KEY": SERPER_API_KEY, "Content-Type": "application/json" },
      timeout: 15_000,
    });

    let results: SearchHit[] = (resp.data.organic ?? []).map((r: any) => ({
      title: r.title ?? "",
      url: r.link ?? "",
      snippet: r.snippet ?? "",
    }));

    if (opts.blockedDomains?.length) {
      results = results.filter((h) => {
        try {
          const host = new URL(h.url).hostname.toLowerCase();
          return !domainMatchesAny(host, opts.blockedDomains!);
        } catch { return false; }
      });
    }

    return results;
  }
}

// ── Keyless provider: DuckDuckGo HTML ──

/** The page DuckDuckGo serves to clients without JavaScript: results as plain links, no key needed. */
export const DUCKDUCKGO_HTML_URL = "https://html.duckduckgo.com/html/";
/** The most of a results page parsed: the page is about 35 KB. */
const DUCKDUCKGO_MAX_BYTES = 1024 * 1024;

/** The character `n` names, or nothing when it names none. */
function codePoint(n: number): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

/** `s` with its tags taken out and the entities an HTML results page writes in titles and snippets read. */
function htmlText(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d: string) => codePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    // What an entity spelled out may form a tag again: angle brackets are not kept in a title or a snippet.
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The hits of a DuckDuckGo HTML results page, in order: each `result__a` link's target (the `uddg` parameter of its redirect link,
 * or the link itself), its title and the snippet that follows it. Ads are left out: their link stays on duckduckgo.com (`y.js`).
 */
export function parseDuckDuckGoHtml(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const parts = html.split(/<a\b(?=[^>]*\bclass="result__a")/);
  for (const part of parts.slice(1)) {
    const href = part.match(/\bhref="([^"]*)"/)?.[1];
    const title = part.match(/^[^>]*>([\s\S]*?)<\/a>/)?.[1];
    if (!href || title === undefined) continue;
    let target: URL;
    try {
      const link = new URL(href.replace(/&amp;/g, "&"), "https://duckduckgo.com/");
      const uddg = link.searchParams.get("uddg");
      target = new URL(uddg ?? link.toString());
    } catch {
      continue;
    }
    const host = target.hostname.toLowerCase().replace(/\.+$/, "");
    if ((target.protocol !== "https:" && target.protocol !== "http:") || host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) continue;
    const snippet = part.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)?.[1];
    if (hits.some((h) => h.url === target.toString())) continue;
    hits.push({ title: htmlText(title), url: target.toString(), ...(snippet ? { snippet: htmlText(snippet) } : {}) });
  }
  return hits;
}

/**
 * DuckDuckGo's HTML results page: a search with no key, for a deployment whose native search cannot run (a gateway that refuses
 * the search tool) and that has no third-party key. Named in `WEB_SEARCH_FALLBACK` it answers only when the provider before it
 * failed, so the native search takes over again by itself once it works.
 */
class DuckDuckGoProvider implements WebSearchProvider {
  readonly name = "duckduckgo";
  async search(query: string, opts: {
    maxResults?: number;
    allowedDomains?: string[];
    blockedDomains?: string[];
    freshness?: string;
  }): Promise<SearchHit[]> {
    const { default: axios } = await import("axios");
    let q = query;
    if (opts.allowedDomains?.length) {
      q += " " + opts.allowedDomains.map((d) => `site:${d}`).join(" OR ");
    }
    const freshnessMap: Record<string, string> = { day: "d", week: "w", month: "m", year: "y" };
    const params: Record<string, string> = {
      q,
      ...(opts.freshness && freshnessMap[opts.freshness] ? { df: freshnessMap[opts.freshness] } : {}),
    };
    const resp = await axios.get(DUCKDUCKGO_HTML_URL, {
      params,
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      responseType: "text",
      maxContentLength: DUCKDUCKGO_MAX_BYTES,
      timeout: 15_000,
    });
    // A page with no results that is not a results page at all (DuckDuckGo's check for automated traffic answers 202) is a failure
    // of this backend, so the next one is tried, not "nothing found".
    const body = typeof resp.data === "string" ? resp.data : "";
    let results = parseDuckDuckGoHtml(body);
    if (!results.length && (resp.status !== 200 || !/\bresults\b/.test(body))) {
      throw new BackendFailure(`no results page (HTTP ${resp.status})`);
    }
    if (opts.blockedDomains?.length) {
      results = results.filter((h) => {
        try {
          return !domainMatchesAny(new URL(h.url).hostname, opts.blockedDomains!);
        } catch { return false; }
      });
    }
    return results.slice(0, opts.maxResults ?? 8);
  }
}

// ── Format third-party results to same output string ──

function formatThirdPartyResults(query: string, hits: SearchHit[]): string {
  let output = `Web search results for query: "${query}"\n\n`;

  if (hits.length === 0) {
    output += "No links found.\n\n";
  } else {
    const links = hits.map((h) => ({ title: h.title, url: h.url }));
    output += `Links: ${JSON.stringify(links)}\n\n`;

    for (const hit of hits) {
      if (hit.snippet) {
        output += `[${hit.title}](${hit.url}): ${hit.snippet}\n\n`;
      }
    }
  }

  output += "\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.";

  if (output.length > MAX_RESULT_SIZE_CHARS) {
    output = output.slice(0, MAX_RESULT_SIZE_CHARS) + "\n[Results truncated due to length...]";
  }

  return output.trim();
}

// ── WebSearchService ──

export class WebSearchService {
  private providers: WebSearchProvider[] = [];
  private rateLimiter = new RateLimiter(30, 30 / 60_000);
  private initialized = false;

  constructor(private ctx: WebToolContext) {}

  private initProviders(): void {
    if (this.initialized) return;
    this.initialized = true;

    const order = [WEB_SEARCH_PROVIDER, ...WEB_SEARCH_FALLBACK.split(",").map((s) => s.trim())]
      .filter((p) => p && p !== "disabled" && p !== "anthropic");

    for (const name of order) {
      switch (name) {
        case "tavily":  this.providers.push(new TavilyProvider()); break;
        case "brave":   this.providers.push(new BraveProvider()); break;
        case "serper":  this.providers.push(new SerperProvider()); break;
        case "duckduckgo": this.providers.push(new DuckDuckGoProvider()); break;
      }
    }
  }

  /**
   * Every failure here is said in this service's own words (a backend's only as `backendFailure` names it, never its message),
   * so each one is marked in `outcome`. A search that answered is not, whatever it found.
   */
  async execute(input: Record<string, unknown>, outcome?: WebToolOutcome): Promise<string> {
    const searchInput = input as unknown as WebSearchInput;
    const fail = (text: string): string => {
      if (outcome) outcome.isError = true;
      return text;
    };

    if (!searchInput.query || searchInput.query.trim().length < 2) {
      return fail("Error: query must be at least 2 characters.");
    }

    if (searchInput.allowed_domains?.length && searchInput.blocked_domains?.length) {
      return fail("Error: allowed_domains and blocked_domains cannot both be non-empty.");
    }

    if (searchInput.site && !searchInput.allowed_domains?.length) {
      searchInput.allowed_domains = [searchInput.site];
    }

    if (searchInput.max_results != null) {
      searchInput.max_results = Math.max(1, Math.min(10, searchInput.max_results));
    }

    if (!this.rateLimiter.tryConsume()) {
      return fail("Error: web search rate limit exceeded (30 req/min). Please wait before searching again.");
    }

    // The last backend's failure, so a search that fails everywhere says how (`backendFailure`).
    let lastError = "";

    // Anthropic native path (Claude engine only)
    if (WEB_SEARCH_PROVIDER === "anthropic") {
      try {
        return await executeAnthropicSearch(searchInput, this.ctx, fail, outcome);
      } catch (err: unknown) {
        lastError = `anthropic: ${backendFailure(err)}`;
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, "anthropic_search_failed, trying fallbacks");
      }
    }

    // Third-party provider chain
    this.initProviders();
    const globalDenylist = parseDenylist(WEB_SEARCH_DOMAIN_DENYLIST);

    for (const provider of this.providers) {
      try {
        let hits = await provider.search(searchInput.query, {
          maxResults: searchInput.max_results,
          allowedDomains: searchInput.allowed_domains,
          blockedDomains: [...(searchInput.blocked_domains ?? []), ...globalDenylist].filter(Boolean),
          freshness: searchInput.freshness,
        });

        if (globalDenylist.length) {
          hits = hits.filter((h) => {
            try {
              return !domainMatchesAny(new URL(h.url).hostname, globalDenylist);
            } catch { return true; }
          });
        }

        if (outcome) outcome.sources = searchSources(hits);
        return formatThirdPartyResults(searchInput.query, hits);
      } catch (err: unknown) {
        lastError = `${provider.name}: ${backendFailure(err)}`;
        logger.info({ provider: provider.name, err: err instanceof Error ? err.message : String(err) }, "search_provider_failed");
      }
    }

    if (WEB_SEARCH_PROVIDER === "disabled") {
      return fail("Error: web search disabled");
    }

    if (lastError) return fail(`Error: web search failed (${lastError})`);
    return fail("Error: no web search provider available");
  }
}
