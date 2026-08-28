// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * WebSearchService — unified web search dispatching to Anthropic native,
 * Tavily, Brave, or Serper backends.
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
import type { WebToolContext, WebSearchProvider, SearchHit } from "./types.js";

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

// ── Anthropic native search (sub-LLM wrapper) ──

async function executeAnthropicSearch(
  input: WebSearchInput,
  ctx: WebToolContext,
): Promise<string> {
  const query = (input.query ?? "").trim();
  if (query.length < 2) return "Error: query must be at least 2 characters.";

  const globalDenylist = parseDenylist(WEB_SEARCH_DOMAIN_DENYLIST);
  const rawAllowed = input.allowed_domains ?? (input.site ? [input.site] : undefined);
  const allowedDomains = rawAllowed?.filter((d) => !domainMatchesAny(d, globalDenylist));

  if (rawAllowed && allowedDomains && allowedDomains.length !== rawAllowed.length) {
    return "Error: allowed_domains contains a domain blocked by WEB_SEARCH_DOMAIN_DENYLIST";
  }

  const blockedDomains = allowedDomains?.length
    ? undefined
    : [...(input.blocked_domains ?? []), ...globalDenylist].filter(Boolean);

  if (allowedDomains?.length && blockedDomains?.length) {
    return "Error: allowed_domains and blocked_domains cannot both be non-empty.";
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

  return formatWebSearchResult(query, finalMsg.content as any[]);
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
    if (!TAVILY_API_KEY) throw new Error("TAVILY_API_KEY not configured");
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
    if (!BRAVE_API_KEY) throw new Error("BRAVE_API_KEY not configured");
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
    if (!SERPER_API_KEY) throw new Error("SERPER_API_KEY not configured");
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
      }
    }
  }

  async execute(input: Record<string, unknown>): Promise<string> {
    const searchInput = input as unknown as WebSearchInput;

    if (!searchInput.query || searchInput.query.trim().length < 2) {
      return "Error: query must be at least 2 characters.";
    }

    if (searchInput.allowed_domains?.length && searchInput.blocked_domains?.length) {
      return "Error: allowed_domains and blocked_domains cannot both be non-empty.";
    }

    if (searchInput.site && !searchInput.allowed_domains?.length) {
      searchInput.allowed_domains = [searchInput.site];
    }

    if (searchInput.max_results != null) {
      searchInput.max_results = Math.max(1, Math.min(10, searchInput.max_results));
    }

    if (!this.rateLimiter.tryConsume()) {
      return "Error: web search rate limit exceeded (30 req/min). Please wait before searching again.";
    }

    // Anthropic native path (Claude engine only)
    if (WEB_SEARCH_PROVIDER === "anthropic") {
      try {
        return await executeAnthropicSearch(searchInput, this.ctx);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err: msg }, "anthropic_search_failed, trying fallbacks");
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

        return formatThirdPartyResults(searchInput.query, hits);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.info({ provider: provider.name, err: msg }, "search_provider_failed");
      }
    }

    if (WEB_SEARCH_PROVIDER === "disabled") {
      return "Error: web search disabled";
    }

    return "Error: no web search provider available";
  }
}
