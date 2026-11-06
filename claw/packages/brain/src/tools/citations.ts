// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `ExecuteRequest.cite`: the sources a run's lookups returned, and the ones a citing call may name.
 *
 * A source is kept only from what a lookup's own code produced, never from text: a `web_search` result's hits, a page `web_fetch`
 * read whole, and the `_meta["claw/sources"]` of a result from a server the request names in `source_servers` that is one the API
 * adds itself (`isPlatformMcpServer`). A plugin's server, a page's body and the model's own words are never read for addresses.
 *
 * A call of a citing tool (the router's `say`) gives its `sources` as addresses; each is looked up among the kept ones by a
 * normalized form (`citeKey`), and the kept entry is what is sent on, the tool's own address and not the model's copy of it. What is
 * not found is dropped and counted. The numbers stay the model's (the i-th address is `[i+1]`): the text may already be on the
 * user's screen (`stream_tool_text`), so nothing is renumbered.
 *
 * One object per run, on the top-level router only: what a run keeps is the run's, as `read_taint` is.
 */
import pino from "pino";
import {
  CITE_DROPPED_META, CITE_MAX_PER_CALL, CITE_SOURCES_META, CITE_TITLE_MAX, citeableUrl, isCiteSourceKind, isPlatformMcpServer,
  type CiteDropped, type CiteSource, type CitedSource,
} from "@claw/protocol";

const logger = pino({ name: "citations" });

/** The most sources a run keeps. A router turn makes a few lookups of at most a few dozen results each. */
export const RUN_SOURCES_MAX = 200;

/** Brain's own lookups whose sources are kept: they fill `RouteOutcome.sources` themselves. */
const BRAIN_SOURCE_TOOLS = new Set(["web_search", "web_fetch"]);

/**
 * The form two addresses are compared in: scheme and host lower case (the URL parser does both), no fragment, no default port, no
 * trailing slash on the path. The query is kept as it is. Null for anything that cannot be a source (`citeableUrl`).
 */
export function citeKey(raw: unknown): string | null {
  const url = citeableUrl(raw);
  if (!url) return null;
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}${url.search}`;
}

/** At most `CITE_TITLE_MAX` code points of `s`, whitespace runs as one space. */
function clipTitle(s: string): string {
  return Array.from(s.replace(/\s+/g, " ").trim()).slice(0, CITE_TITLE_MAX).join("");
}

/** A source as a producer gave it, checked: null when it is not one. The address kept is the producer's, without its fragment. */
export function citeSource(raw: unknown): CiteSource | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { url?: unknown; title?: unknown; kind?: unknown };
  const url = citeableUrl(r.url);
  if (!url || !isCiteSourceKind(r.kind)) return null;
  url.hash = "";
  return { url: url.toString(), title: typeof r.title === "string" ? clipTitle(r.title) : "", kind: r.kind };
}

/** A web page as a source: its title, or its host and path when it has none. */
export function webSource(url: string, title?: string): CiteSource | null {
  const parsed = citeableUrl(url);
  if (!parsed) return null;
  const named = typeof title === "string" && title.trim() ? title : `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  return citeSource({ url, title: named, kind: "web" });
}

export class RunCitations {
  private readonly kept = new Map<string, CiteSource>();

  constructor(private readonly citing: ReadonlySet<string>, private readonly sourceServers: ReadonlySet<string>) {}

  /** Whether a call of `name` cites: its `sources` argument is looked up, and the result sent in the request's `_meta`. */
  cites(name: string): boolean {
    return this.citing.has(name);
  }

  /** Whether what a call of `name` returned as sources is believed: Brain's web tools, and the tools of a trusted server. */
  producedBy(name: string): boolean {
    if (BRAIN_SOURCE_TOOLS.has(name)) return true;
    if (!name.startsWith("mcp__")) return false;
    const server = name.split("__")[1] ?? "";
    return this.sourceServers.has(server);
  }

  /** Keep the sources a call of `name` returned, when `name` is one whose sources are believed. Malformed entries are skipped. */
  keep(name: string, sources: unknown): void {
    if (!Array.isArray(sources) || !sources.length || !this.producedBy(name)) return;
    for (const raw of sources) {
      const source = citeSource(raw);
      const key = source && citeKey(source.url);
      if (!source || !key || this.kept.has(key)) continue;
      if (this.kept.size >= RUN_SOURCES_MAX) {
        logger.warn({ tool: name, max: RUN_SOURCES_MAX }, "cite.run_sources_full");
        return;
      }
      this.kept.set(key, source);
    }
  }

  /** How many sources the run keeps (for the logs and the tests). */
  get size(): number {
    return this.kept.size;
  }

  /**
   * The `_meta` of a call of `name` that cites: the kept entry for each address of `input.sources` found, numbered by its place,
   * and what was dropped. Undefined when `name` does not cite or the call names no sources.
   */
  metaFor(name: string, input: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!this.cites(name) || input.sources === undefined) return undefined;
    const asked = Array.isArray(input.sources) ? input.sources : [input.sources];
    const cited: CitedSource[] = [];
    const dropped: CiteDropped = { not_in_turn: 0, invalid: 0, over_cap: 0 };
    const missedHosts: string[] = [];
    asked.forEach((raw, i) => {
      if (i >= CITE_MAX_PER_CALL) { dropped.over_cap += 1; return; }
      const key = citeKey(raw);
      if (!key) { dropped.invalid += 1; return; }
      const source = this.kept.get(key);
      if (!source) {
        dropped.not_in_turn += 1;
        missedHosts.push(new URL(key).host);
        return;
      }
      cited.push({ n: i + 1, ...source });
    });
    // Hosts only: an address the model wrote may carry anything in its path or query.
    logger.info({ tool: name, cited: cited.length, dropped, missedHosts, kept: this.kept.size }, "cite.sources_resolved");
    return { [CITE_SOURCES_META]: cited, [CITE_DROPPED_META]: dropped };
  }
}

/**
 * `ExecuteRequest.cite`, read once per run: null when absent or naming no citing tool. A source server counts only when the run's
 * entry of that name is one the API adds itself (`servers`, the run's MCP servers as they will be connected).
 */
export function parseCite(raw: unknown, servers: Record<string, unknown>): RunCitations | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { tools?: unknown; source_servers?: unknown };
  const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((n): n is string => typeof n === "string" && n.trim() !== "").map((n) => n.trim()) : []);
  const tools = names(r.tools);
  if (!tools.length) return null;
  const trusted = names(r.source_servers).filter((name) => {
    const spec = Object.hasOwn(servers, name) ? servers[name] : undefined;
    const ok = isPlatformMcpServer(name, spec && typeof spec === "object" ? spec as Record<string, unknown> : undefined);
    if (!ok) logger.warn({ server: name }, "cite.source_server_not_trusted");
    return ok;
  });
  return new RunCitations(new Set(tools), new Set(trusted));
}
