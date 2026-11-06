// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Where the router's answer came from (`CLAW_ASSISTANT_CITATIONS`): the sources a `say` cites, from the turn's own lookups only.
 *
 * The model writes [1], [2] in its text and names each number's address in `say`'s `sources`. Those addresses are never taken as
 * sources here. Brain keeps what the turn's lookups returned (`ExecuteRequest.cite`: a search's pages, a page fetched whole, the
 * objects this API's GitHub server listed; a page fetched only at an address one of those returned or the user wrote) and sends
 * `say` the entries that matched, in the MCP request's `_meta`, which the model
 * cannot write; an address no lookup returned is dropped there and counted. What arrives is checked again here before it is
 * stored with the message and sent to the channel (`AssistantSayPayload.sources`):
 *
 *  - each entry's number is 1..`CITE_MAX_PER_CALL`, once, and appears in the text as `[n]` on its own, in a text that can make no
 *    link at all (`citedNumbers`);
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
import { TOOL_NAME_PREFIX, TURN_STATE_HEADER, WORK_EVENT_PREFIX } from "./prompts.js";

/** The longest title a cited source is shown with, in code points. */
export const SAY_SOURCE_TITLE_MAX = 80;
/** What a message's sources may take, as JSON: with the longest text, the payload stays well under a channel's 16 KiB. */
export const SAY_SOURCES_MAX_BYTES = 8000;

export function assistantCitationsOn(): boolean {
  return CLAW_ASSISTANT_ENABLED && CLAW_ASSISTANT_CITATIONS;
}

/** The most addresses of the user's message a turn may confirm as sources by reading them (`userAddresses`). */
export const USER_ADDRESSES_MAX = 20;
/**
 * Where an address written into a message ends, as GitHub's autolinks read one: at whitespace or `<`, `>`; and at the full-width
 * punctuation Chinese text puts right after one (`看 https://x/a，再看`), which an address never holds unencoded.
 */
const ADDRESS_END = /[\s<>，。；：！？、（）【】《》「」『』“”‘’]/u;
/** Where an http or https address starts in a piece of a message. */
const ADDRESS_START = /https?:\/\//gi;
/** Characters GitHub's autolinks leave out of an address when it ends with them (sentence punctuation; quotes, which none holds). */
const TRAILING = new Set([".", ",", ":", ";", "!", "?", "*", "_", "~", "'", '"']);
/** At most this many places that start an address are read in a message: what one says is bounded work. */
const ADDRESS_STARTS_MAX = 64;

/**
 * An address as GitHub's autolinks take it from where it starts to the end of its piece of text: without the punctuation that
 * ends a sentence, and without a `)` at its end that closes nothing inside it (`(https://x/a)`, `[docs](https://x/a)`). Never cut
 * anywhere else: `https://x/path_(ticket-12)` stays whole, and an address with a character no address holds is no source at all.
 */
function writtenAddress(rest: string): string {
  let end = rest.length;
  let open = 0;
  let close = 0;
  for (let i = 0; i < end; i += 1) {
    if (rest[i] === "(") open += 1;
    else if (rest[i] === ")") close += 1;
  }
  while (end > 0) {
    const c = rest[end - 1];
    if (TRAILING.has(c)) end -= 1;
    else if (c === ")" && close > open) { end -= 1; close -= 1; }
    else break;
  }
  return rest.slice(0, end);
}

/**
 * The addresses the user wrote in the message a turn answers (`prompt`, as the turn was sent it), each one that can be a source
 * (`citeableUrl`), at most `USER_ADDRESSES_MAX`: a page `web_fetch` reads is a source only at one of these or at one a search or
 * GitHub lookup of the turn returned (`ExecuteRequest.cite.user_urls`). Each is the whole address as the user's own client links it
 * (`writtenAddress`), never a part of one. A worker's report (`[work_event]`) is not the user's words, and neither is the state
 * Claw adds after them (`TURN_STATE_HEADER`).
 */
export function userAddresses(prompt: string): string[] {
  if (prompt.startsWith(WORK_EVENT_PREFIX)) return [];
  const out: string[] = [];
  let starts = 0;
  for (const piece of prompt.split(TURN_STATE_HEADER, 1)[0].split(ADDRESS_END)) {
    // Every address that starts in the piece runs to its end: `[https://x/a](https://x/a)` holds one that is no source (its
    // brackets) and one that is.
    for (const m of piece.matchAll(ADDRESS_START)) {
      if ((starts += 1) > ADDRESS_STARTS_MAX) return out;
      const address = writtenAddress(piece.slice(m.index));
      if (citeableUrl(address) && !out.includes(address)) out.push(address);
      if (out.length >= USER_ADDRESSES_MAX) return out;
    }
  }
  return out;
}

/**
 * A router turn's `ExecuteRequest.cite`, or null with citations off: its `say` cites, from Brain's web tools and, when the turn
 * has the user's GitHub, this API's GitHub server; a page read is a source only at an address one of those returned or the
 * user wrote in `prompt` (`userAddresses`).
 */
export function routerCite(
  githubServers: Record<string, unknown>, prompt: string, on: boolean = assistantCitationsOn(),
): { tools: string[]; source_servers: string[]; user_urls?: string[] } | null {
  if (!on) return null;
  const userUrls = userAddresses(prompt);
  return {
    tools: [`${TOOL_NAME_PREFIX}say`],
    source_servers: Object.hasOwn(githubServers, GITHUB_MCP_SERVER) ? [GITHUB_MCP_SERVER] : [],
    ...(userUrls.length ? { user_urls: userUrls } : {}),
  };
}

/**
 * What became of the sources a `say` was sent: the counter's `outcome` label. `unreferenced`: the text writes no `[n]` for it;
 * `suppressed_link_text`: it does, but the text can make a link (`makesLink`), so it cites nothing.
 */
export const SAY_SOURCE_OUTCOMES = [
  "cited", "dropped_not_in_turn", "dropped_invalid", "dropped_over_cap", "unreferenced", "suppressed_link_text",
] as const;
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
/** A backslash escape, as markdown resolves it (`\.` is a `.` once shown). */
const ESCAPED = /\\([!-/:-@[-`{-~])/g;
/**
 * What makes a link where it stands, as CommonMark with GitHub's autolinks reads a text: an inline link or image (a `]` right before
 * `(`: `[1] (2 days ago)` is text), an autolink or an HTML tag (`<` before a letter, `/`, `!` or `?`: `p99 < 10ms` is text), an
 * address (`://`, `www.`, `mailto:`), an e-mail address (a local part right before `@` and a dotted domain after it: a mention
 * `@alice.smith` is text). A link reference definition makes one too (`definesLink`).
 */
const LINK_MAKING = /\]\(|<[a-z/!?]|:\/\/|www\.|(?:mailto|xmpp):|[a-z0-9._+-]@[a-z0-9_-]+\.[a-z0-9_-]/i;
/** What may stand before a link reference definition's `[` on its line: indentation, a quote's `>`, a list item's marker. */
const LINE_LEAD = new Set([" ", "\t", ">", "*", "+", "-", ".", ")", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);

/**
 * Whether the text defines a link reference (`[1]: https://…`, `[^2]: …`), which makes every `[1]` of it a link: a `[` that opens
 * its line (only `LINE_LEAD` before it) closed by `]:`, its label holding no bracket and maybe running across lines. `Status [1]:
 * merged` defines nothing.
 */
function definesLink(text: string): boolean {
  let lead = true;
  let open = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "[") open = lead;
    else if (c === "]") {
      if (open && text[i + 1] === ":") return true;
      open = false;
    }
    lead = c === "\n" || (lead && LINE_LEAD.has(c));
  }
  return false;
}

/** Whether the text can make a link (`LINK_MAKING`, `definesLink`), read as it is shown: with its backslash escapes resolved. */
export function makesLink(text: string): boolean {
  const shown = text.replace(ESCAPED, "$1");
  return LINK_MAKING.test(shown) || definesLink(shown);
}

/**
 * The numbers the text writes as `[n]` on their own, outside every bracket. An escaped bracket is no bracket; an unclosed `[`
 * leaves what follows it unwritten.
 */
function writtenNumbers(text: string): Set<number> {
  const out = new Set<number>();
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

/**
 * The numbers the text cites: the ones it writes as `[n]` on their own (`writtenNumbers`), and none at all in a text that can make a
 * link (`makesLink`). The router is told to put addresses in `sources` and never in the text, so no `[n]` can be, or be inside, a
 * link to an address of the model's.
 */
export function citedNumbers(text: string): Set<number> {
  return makesLink(text) ? new Set() : writtenNumbers(text);
}

const count = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? Math.min(v, 1000) : 0);

/**
 * The sources a `say` carries, from the request `_meta` Brain sent (`ExecuteRequest.cite`) and the text, checked as the header
 * says, with what became of each. Never the model's own `sources` argument: without `_meta` (citations off, an older Brain) none.
 */
export function saySources(meta: unknown, text: string): SaySources {
  const counts: Record<SaySourceOutcome, number> = {
    cited: 0, dropped_not_in_turn: 0, dropped_invalid: 0, dropped_over_cap: 0, unreferenced: 0, suppressed_link_text: 0,
  };
  const sources: CitedSource[] = [];
  if (!meta || typeof meta !== "object") return { sources, counts };
  const m = meta as Record<string, unknown>;
  const dropped = m[CITE_DROPPED_META] && typeof m[CITE_DROPPED_META] === "object" ? m[CITE_DROPPED_META] as Record<string, unknown> : {};
  counts.dropped_not_in_turn += count(dropped.not_in_turn);
  counts.dropped_invalid += count(dropped.invalid);
  counts.dropped_over_cap += count(dropped.over_cap);
  const listed = Array.isArray(m[CITE_SOURCES_META]) ? m[CITE_SOURCES_META] as unknown[] : [];
  const written = writtenNumbers(text);
  const linked = makesLink(text);
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
    if (!written.has(n)) { counts.unreferenced += 1; continue; }
    if (linked) { counts.suppressed_link_text += 1; continue; }
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
