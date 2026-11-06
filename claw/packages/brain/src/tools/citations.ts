// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `ExecuteRequest.cite`: the sources a run's lookups returned, and the ones a citing call may name.
 *
 * A source is kept only from what a lookup's own code produced, never from text: a `web_search` result's hits, and the
 * `_meta["claw/sources"]` of a result from a server the request names in `source_servers` that is one the API adds itself
 * (`isPlatformMcpServer`). A page `web_fetch` read whole only confirms a source: it is kept when its address is one of those or one
 * the user wrote in the message the turn answers (`user_urls`), so what a page or a search result's text says cannot lead the model
 * to an address of its choosing and make it a source. A plugin's server, a page's body and the model's own words are never read
 * for addresses, with one exception: a server the request names in `link_servers` (the agent board's Gitea) answers with JSON objects that
 * carry their own page as `html_url`, and that field of a top-level object (or of each element of a top-level array) is kept when it
 * starts with the prefix the request gives for that server (`keepLinks`). An address in a body, a comment or a title is never read.
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
/** The lookup that only confirms a source (a page read at an address another lookup returned or the user wrote), never adds one. */
const CONFIRMING_TOOL = "web_fetch";
/** The most addresses of the user's message a run reads from `cite.user_urls`. */
export const USER_URLS_MAX = 20;

/**
 * The form two addresses are compared in: scheme and host lower case (the URL parser does both), no fragment, no default port, no
 * trailing slash on the path. The query is kept as it is. Null for anything that cannot be a source (`citeableUrl`).
 */
export function citeKey(raw: unknown): string | null {
  const url = citeableUrl(raw);
  if (!url) return null;
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}${url.search}`;
}

/** The longest result `keepLinks` parses: a larger one (or one cut short) keeps nothing. */
export const LINK_RESULT_MAX = 512 * 1024;
/** The most objects of one result `keepLinks` reads. */
const LINK_OBJECTS_MAX = 100;

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

  /** `userKeys`: the `citeKey` of each address the user wrote in the message the turn answers (`cite.user_urls`). */
  /** `linkServers`: per server, the prefix the `html_url` of its result objects must start with to be kept (`keepLinks`). */
  constructor(
    private readonly citing: ReadonlySet<string>, private readonly sourceServers: ReadonlySet<string>,
    private readonly userKeys: ReadonlySet<string> = new Set(), private readonly linkServers: ReadonlyMap<string, string> = new Map(),
  ) {}

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

  /**
   * Keep the sources a call of `name` returned, when `name` is one whose sources are believed. Malformed entries are skipped, and so
   * is a page `web_fetch` read at an address neither kept already nor written by the user (`CONFIRMING_TOOL`).
   */
  keep(name: string, sources: unknown): void {
    if (!Array.isArray(sources) || !sources.length || !this.producedBy(name)) return;
    for (const raw of sources) {
      const source = citeSource(raw);
      const key = source && citeKey(source.url);
      if (!source || !key || this.kept.has(key)) continue;
      if (name === CONFIRMING_TOOL && !this.userKeys.has(key)) {
        // Host only: the address came from what the model read, and its path or query may carry anything.
        logger.info({ tool: name, host: new URL(key).host }, "cite.fetch_not_confirmed");
        continue;
      }
      if (this.kept.size >= RUN_SOURCES_MAX) {
        logger.warn({ tool: name, max: RUN_SOURCES_MAX }, "cite.run_sources_full");
        return;
      }
      this.kept.set(key, source);
    }
  }

  /**
   * Keep the pages a call of a link server returned (`link_servers`): the `html_url` of each top-level object of its JSON result,
   * when it starts with the server's prefix, titled by the object's own `title`, `full_name` or `name`. A result that is not JSON,
   * is cut short or is larger than `LINK_RESULT_MAX` keeps nothing.
   */
  keepLinks(name: string, text: string): void {
    if (!name.startsWith("mcp__") || typeof text !== "string" || !text || text.length > LINK_RESULT_MAX) return;
    const prefix = this.linkServers.get(name.split("__")[1] ?? "");
    if (!prefix) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const objects = (Array.isArray(parsed) ? parsed : [parsed]).slice(0, LINK_OBJECTS_MAX);
    const sources: CiteSource[] = [];
    for (const o of objects) {
      if (!o || typeof o !== "object" || Array.isArray(o)) continue;
      const r = o as { html_url?: unknown; title?: unknown; full_name?: unknown; name?: unknown };
      if (typeof r.html_url !== "string") continue;
      const title = [r.title, r.full_name, r.name].find((t): t is string => typeof t === "string" && t.trim() !== "");
      const source = webSource(r.html_url, title);
      // (the address as parsed: `https://host/board/../x` is not under `https://host/board/`)
      if (source?.url.startsWith(prefix)) sources.push({ ...source, kind: "board" });
    }
    for (const source of sources) {
      const key = citeKey(source.url);
      if (!key || this.kept.has(key)) continue;
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
  const r = raw as { tools?: unknown; source_servers?: unknown; user_urls?: unknown; link_servers?: unknown };
  const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((n): n is string => typeof n === "string" && n.trim() !== "").map((n) => n.trim()) : []);
  const tools = names(r.tools);
  if (!tools.length) return null;
  const trusted = names(r.source_servers).filter((name) => {
    const spec = Object.hasOwn(servers, name) ? servers[name] : undefined;
    const ok = isPlatformMcpServer(name, spec && typeof spec === "object" ? spec as Record<string, unknown> : undefined);
    if (!ok) logger.warn({ server: name }, "cite.source_server_not_trusted");
    return ok;
  });
  const userKeys = names(r.user_urls).slice(0, USER_URLS_MAX).map(citeKey).filter((k): k is string => k !== null);
  return new RunCitations(new Set(tools), new Set(trusted), new Set(userKeys), parseLinkServers(r.link_servers));
}

/**
 * `cite.link_servers`: server name to the prefix its pages' addresses have. A prefix must be an https address that can be a source
 * and end its path with `/`, so `https://host/board/` never matches `https://host/boarding`; anything else is left out.
 */
function parseLinkServers(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [server, prefix] of Object.entries(raw as Record<string, unknown>)) {
    const url = citeableUrl(prefix);
    if (!server.trim() || !url || url.protocol !== "https:" || !url.pathname.endsWith("/") || url.search || url.hash || prefix !== url.toString()) {
      logger.warn({ server }, "cite.link_server_invalid");
      continue;
    }
    out.set(server.trim(), url.toString());
  }
  return out;
}
