// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Where the router's answer came from (`CLAW_ASSISTANT_CITATIONS`): the sources a `say` cites, from the turn's own lookups only.
 *
 * The model writes [1], [2] in its text and names each number's address in `say`'s `sources`. Those addresses are never taken as
 * sources here. Brain keeps what the turn's lookups returned (`ExecuteRequest.cite`: a search's pages, a page fetched whole, the
 * objects this API's GitHub server listed) and sends `say` the entries that matched, in the MCP request's `_meta`, which the model
 * cannot write; an address no lookup returned is dropped there and counted. What arrives is checked again here before it is
 * stored with the message and sent to the channel (`AssistantSayPayload.sources`):
 *
 *  - each entry's number is 1..`CITE_MAX_PER_CALL`, once, and appears in the text as `[n]` on its own, not as or inside a link
 *    (`citedNumbers`);
 *  - its address can be a source (`citeableUrl`: http or https, a host, no credentials as a user or a parameter) and has nothing
 *    a redaction would mask;
 *  - its title is a page's or a pull request's own words, which anyone may have written: it is cut to one plain line of
 *    `SAY_SOURCE_TITLE_MAX` code points with every control, format and direction character, HTML tag and character reference,
 *    markup and link character, leading block marker (heading, list, quote), address and token-like run taken out, and redacted
 *    before and after, so a channel shows it as text and never as markup, a link or an instruction. No summary of a page is kept.
 *  - all of them together stay under `SAY_SOURCES_MAX_BYTES`, so a message with its sources fits a channel's request.
 *
 * The text is never changed: it may already be on the user's screen (`stream_tool_text`).
 */
import {
  CITE_DROPPED_META, CITE_MAX_PER_CALL, CITE_SOURCES_META, GITHUB_MCP_SERVER, citeableUrl, isCiteSourceKind, type CitedSource,
} from "@claw/protocol";
import { CLAW_ASSISTANT_CITATIONS, CLAW_ASSISTANT_ENABLED } from "../config.js";
import { redactPublicJson } from "../events/redaction.js";
import { TOOL_NAME_PREFIX } from "./prompts.js";

/** The longest title a cited source is shown with, in code points. */
export const SAY_SOURCE_TITLE_MAX = 80;
/** What a message's sources may take, as JSON: with the longest text, the payload stays well under a channel's 16 KiB. */
export const SAY_SOURCES_MAX_BYTES = 8000;

export function assistantCitationsOn(): boolean {
  return CLAW_ASSISTANT_ENABLED && CLAW_ASSISTANT_CITATIONS;
}

/**
 * A router turn's `ExecuteRequest.cite`, or null with citations off: its `say` cites, from Brain's web tools and, when the turn
 * has the user's GitHub, this API's GitHub server.
 */
export function routerCite(
  githubServers: Record<string, unknown>, on: boolean = assistantCitationsOn(),
): { tools: string[]; source_servers: string[] } | null {
  if (!on) return null;
  return {
    tools: [`${TOOL_NAME_PREFIX}say`],
    source_servers: Object.hasOwn(githubServers, GITHUB_MCP_SERVER) ? [GITHUB_MCP_SERVER] : [],
  };
}

/** What became of the sources a `say` was sent: the counter's `outcome` label. */
export const SAY_SOURCE_OUTCOMES = ["cited", "dropped_not_in_turn", "dropped_invalid", "dropped_over_cap", "unreferenced"] as const;
export type SaySourceOutcome = (typeof SAY_SOURCE_OUTCOMES)[number];

export interface SaySources {
  /** The sources the message carries, by number. */
  sources: CitedSource[];
  counts: Record<SaySourceOutcome, number>;
}

/**
 * Every character that is not part of a title a person reads, by its Unicode category: controls (C0, DEL, C1), format characters
 * (zero-width, direction marks, embeddings, overrides, isolates, the BOM, ...), lone surrogates, private use, unassigned, and the
 * line and paragraph separators.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu;
/** An HTML character reference (`&lt;`, `&#60;`), which a renderer would turn back into markup. */
const ENTITY = /&#?[a-z0-9]+;/gi;
/** What makes a line a block in markdown, at its start: a heading, a list item, a quote. */
const BLOCK = /^(?:#+|[-+*>]+|\d+[.)])(?:\s+|$)/;
/** An HTML tag. */
const TAG = /<[^>]*>/g;
/** A markdown link: its label stays. */
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
/**
 * Characters that make markdown emphasis, code, a table, HTML or a link. With every bracket gone no link can be made, so a title
 * keeps its parentheses (`perf(api): ...`). A `#` is a heading only at the start, and goes there.
 */
const MARKUP = /[\[\]<>*_~|`\\]/g;
/** A run of 32 or more token characters (a key, a signature, a hash) in a title: never part of a title worth showing. */
const TOKEN_RUN = /[A-Za-z0-9+=_%-]{32,}/g;
/** An address written into a title. */
const ADDRESS = /\b[a-z][a-z0-9+.-]*:\/\/\S*|\bwww\.\S+/gi;

const redact = (text: string): string => String(redactPublicJson(text) ?? "");

/** A source's title as it may be shown: one plain line, no markup and no address, at most `SAY_SOURCE_TITLE_MAX` code points. */
export function sourceTitle(raw: unknown, url: URL): string {
  // Redacted first, while a credential still has its own shape (the markup below takes its `_` and its prefix with it), and again
  // last, on what is shown.
  let plain = redact((typeof raw === "string" ? raw : "").replace(INVISIBLE, " "))
    // An `&` left after the references is shown as the full-width ＆, which nothing decodes (`&#60img` without its `;` is markup too).
    .replace(TAG, " ").replace(ENTITY, " ").replace(/&/g, "\uff06").replace(LINK, " $1 ").replace(ADDRESS, " ").replace(TOKEN_RUN, " ").replace(MARKUP, " ")
    .replace(/\s+/g, " ").trim();
  for (let block = plain.match(BLOCK); block; block = plain.match(BLOCK)) plain = plain.slice(block[0].length).trimStart();
  const cut = Array.from(plain).slice(0, SAY_SOURCE_TITLE_MAX).join("").trim();
  return redact(cut) || url.host;
}

/** At a position: `[n]`. */
const CITE_AT = /\[(\d{1,2})\]/y;
/**
 * What lets a text make a link at all: an address, protocol-relative ones included (`//`, `www.`, `mailto:`), an e-mail address
 * (which GFM links by itself), an inline link or image or a reference definition, wherever it stands (a `]` before `(` or `:`,
 * spaces allowed: inside a quote or a list too), an HTML tag or an autolink (`<`). The router is told to put addresses in `sources` and never in the text, so a text with any of them
 * cites nothing: no `[n]` in it can be, or be inside, a link to an address of the model's.
 */
const LINK_MAKING = /\/\/|\bwww\.|mailto:|[\w.+-]@[\w-]+\.[a-z]|\]\s*[(:]|</i;

/**
 * The numbers the text cites as `[n]` on their own, outside every bracket, and none at all in a text that can make a link
 * (`LINK_MAKING`). An escaped bracket is no bracket; an unclosed `[` leaves what follows it uncited.
 */
export function citedNumbers(text: string): Set<number> {
  const out = new Set<number>();
  if (LINK_MAKING.test(text)) return out;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "\\") { i += 1; continue; }
    if (c === "[") {
      CITE_AT.lastIndex = i;
      const m = depth === 0 ? CITE_AT.exec(text) : null;
      if (m) { out.add(Number(m[1])); i += m[0].length - 1; continue; }
      depth += 1;
    } else if (c === "]") {
      depth = Math.max(depth - 1, 0);
    }
  }
  return out;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? Math.min(v, 1000) : 0);

/**
 * The sources a `say` carries, from the request `_meta` Brain sent (`ExecuteRequest.cite`) and the text, checked as the header
 * says, with what became of each. Never the model's own `sources` argument: without `_meta` (citations off, an older Brain) none.
 */
export function saySources(meta: unknown, text: string): SaySources {
  const counts: Record<SaySourceOutcome, number> = {
    cited: 0, dropped_not_in_turn: 0, dropped_invalid: 0, dropped_over_cap: 0, unreferenced: 0,
  };
  const sources: CitedSource[] = [];
  if (!meta || typeof meta !== "object") return { sources, counts };
  const m = meta as Record<string, unknown>;
  const dropped = m[CITE_DROPPED_META] && typeof m[CITE_DROPPED_META] === "object" ? m[CITE_DROPPED_META] as Record<string, unknown> : {};
  counts.dropped_not_in_turn += count(dropped.not_in_turn);
  counts.dropped_invalid += count(dropped.invalid);
  counts.dropped_over_cap += count(dropped.over_cap);
  const listed = Array.isArray(m[CITE_SOURCES_META]) ? m[CITE_SOURCES_META] as unknown[] : [];
  const cited = citedNumbers(text);
  const seen = new Set<number>();
  let bytes = 2;
  for (const raw of listed) {
    if (seen.size >= CITE_MAX_PER_CALL) { counts.dropped_over_cap += 1; continue; }
    const e = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const n = e.n;
    const url = citeableUrl(e.url);
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > CITE_MAX_PER_CALL || seen.has(n)
      || !url || redact(e.url as string) !== e.url || !isCiteSourceKind(e.kind)) {
      counts.dropped_invalid += 1;
      continue;
    }
    seen.add(n);
    if (!cited.has(n)) { counts.unreferenced += 1; continue; }
    const source: CitedSource = { n, url: e.url as string, title: sourceTitle(e.title, url), kind: e.kind };
    const size = Buffer.byteLength(JSON.stringify(source)) + 1;
    if (bytes + size > SAY_SOURCES_MAX_BYTES) { counts.dropped_over_cap += 1; continue; }
    bytes += size;
    sources.push(source);
    counts.cited += 1;
  }
  sources.sort((a, b) => a.n - b.n);
  return { sources, counts };
}
