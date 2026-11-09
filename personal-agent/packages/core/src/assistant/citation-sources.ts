// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A cited source's link and title, as its card shows them. The link is one of the turn's own lookups, never an address
 * the model wrote; the title is what someone else wrote, so it is shown as one plain line only.
 *
 * The address is read as Python's `urllib.parse.urlsplit` reads it (`splitUrl`), not with the WHATWG `URL`: `URL`
 * normalises what `urlsplit` only splits (`https://EX%41mple.com` has the host `example.com` there and `ex%41mple.com`
 * here, `https:host` gains the `//` it lacks, a full-width `／` becomes a `/` and a dot segment is resolved), so it would
 * accept and show other addresses than the Python worker.
 */
import { redactText } from "../security/redact.js";
import { cpHead, cpLength, pyLstrip, pyStrip, squashSpaces } from "../text/py-text.js";

export const CITATION_NAME_MAX = 80;
export const SOURCE_URL_MAX = 2048;
/** What of a title is read at all (Claw sends at most 80 code points): bounded work, whatever comes. */
export const SOURCE_TITLE_INPUT_MAX = 1000;

/** A character that could close an attribute or open a tag; a canonical address has none. */
const URL_MARKUP = new Set("<>\"'`{}|\\^[]");
/**
 * Every character that is not part of a title a person reads, by its Unicode category: controls, format characters,
 * surrogates, private use, unassigned, and the line and paragraph separators.
 */
const INVISIBLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]$/u;
/** The characters Python's `str.isspace()` is true for (as `py-text.ts`), for `\s` and `\S` in a pattern. */
const SPACE = String.raw`\t\n\v\f\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;
const SPACE_ONE = new RegExp(`^[${SPACE}]$`, "u");
/** Python's `\w` on a `str`: letters, every numeric character, `_`. */
const WORD = String.raw`\p{L}\p{N}_`;
/**
 * Python's IGNORECASE also takes `İ` (U+0130) and `ı` (U+0131) as an `i` (their simple case mappings); the `u` flag's
 * case folding does not, so they are written out wherever an `i` or an `a-z` stands.
 */
const I = String.raw`[i\u0130\u0131]`;
const AZ = String.raw`a-z\u0130\u0131`;

// Each pattern here runs in linear time on any input: no class can run past its own start.
const TAG = /<[^<>]*>/gu;
/** An HTML character reference, which a renderer turns back into markup. */
const ENTITY = new RegExp(`&#?[${AZ}0-9]+;`, "giu");
/** What makes a line a heading, a list item or a quote, at its start. */
const BLOCK = new RegExp(`^(?:#+|[-+*>]+|\\p{Nd}+[.)])(?:[${SPACE}]+|$)`, "u");
/** An inline link; its destination may hold one level of parentheses. */
const LINK = /\[([^[\]]*)\]\([^()]*(?:\([^()]*\)[^()]*)*\)/gu;
/**
 * An address of any kind written into a title: with a scheme or protocol-relative, `www.`, a scheme that needs no `//`
 * (`mailto:`, `tel:`, `javascript:`, ...), an e-mail address. (`\b` before a word character is "no word character
 * before it".)
 */
const ADDRESS = new RegExp(
  [
    `(?<![${WORD}])[${AZ}][${AZ}0-9+.-]{0,31}:\\/\\/[^${SPACE}]*`,
    `\\/\\/[^${SPACE}]+`,
    `(?<![${WORD}])www\\.[^${SPACE}]+`,
    `(?<![${WORD}])(?:ma${I}lto|tel|sms|javascr${I}pt|vbscr${I}pt|data|f${I}le):[^${SPACE}]*`,
    `[^${SPACE}@<>()\\[\\]]{1,64}@[${WORD}-]+(?:\\.[${WORD}-]+)+`,
  ].join("|"),
  "giu",
);
/** With every bracket gone no link can be made, so a title keeps its parentheses: `perf(api): ...`. */
const MARKUP = /[[\]<>*_~|`\\]/gu;
/** A run of 32 or more token characters (a key, a signature, a hash): never part of a title worth showing. */
const TOKEN_RUN = /[A-Za-z0-9+=_%-]{32,}/gu;

/**
 * A query or fragment parameter that carries a credential (a pre-signed address's signature, an OAuth code or token, an
 * API key): its address is never shown. A name matches by one of its words (`X-Amz-Signature`, `sig`, `api_key`) or,
 * written as one, by a word inside it (`accessToken`, `AWSAccessKeyId`).
 */
const SECRET_PARAM_PARTS = new Set(["sig", "key", "code", "sid", "pass", "pwd", "auth", "jwt", "session", "bearer"]);
const SECRET_PARAM_WORDS = [
  "signature",
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "apikey",
  "accesskey",
  "privatekey",
  "authorization",
  "sessionid",
];

function invisible(ch: string): boolean {
  return INVISIBLE.test(ch);
}

/** The parts of an address `urlsplit` gives, for the five `sourceUrl` reads. */
interface SplitUrl {
  readonly scheme: string;
  readonly netloc: string;
  readonly query: string;
  readonly fragment: string;
}

const ALL_ASCII = /^[^\u0080-\u{10ffff}]*$/u;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*$/;

/** `str.partition(sep)`. */
function partition(text: string, sep: string): readonly [string, boolean, string] {
  const at = text.indexOf(sep);
  return at < 0 ? [text, false, ""] : [text.slice(0, at), true, text.slice(at + sep.length)];
}

/** `str.rpartition(sep)`. */
function rpartition(text: string, sep: string): readonly [string, boolean, string] {
  const at = text.lastIndexOf(sep);
  return at < 0 ? ["", false, text] : [text.slice(0, at), true, text.slice(at + sep.length)];
}

/** `urlsplit`'s check that NFKC normalisation (as IDNA applies it) adds no delimiter to a non-ASCII netloc. */
function netlocNormalisesSafely(netloc: string): boolean {
  if (ALL_ASCII.test(netloc)) return true;
  const n = netloc.replaceAll("@", "").replaceAll(":", "").replaceAll("#", "").replaceAll("?", "");
  const normalised = n.normalize("NFKC");
  return n === normalised || !["/", "?", "#", "@", ":"].some((c) => normalised.includes(c));
}

/**
 * `urllib.parse.urlsplit(url)` (Python 3.12-3.14) for an address `sourceUrl` has already read: it holds no white space,
 * control character, `[` or `]`, so the leading C0 and space characters `urlsplit` strips, the tab and newlines it drops
 * and its IPv6 checks never apply. Undefined where `urlsplit` raises ValueError.
 */
function splitUrl(raw: string): SplitUrl | undefined {
  let url = raw;
  let scheme = "";
  const colon = url.indexOf(":");
  if (colon > 0 && SCHEME.test(url.slice(0, colon))) {
    scheme = url.slice(0, colon).toLowerCase();
    url = url.slice(colon + 1);
  }
  let netloc = "";
  if (url.startsWith("//")) {
    const ends = ["/", "?", "#"].map((c) => url.indexOf(c, 2)).filter((at) => at >= 0);
    const end = Math.min(url.length, ...ends);
    netloc = url.slice(2, end);
    url = url.slice(end);
  }
  const [beforeFragment, , fragment] = partition(url, "#");
  const [, , query] = partition(beforeFragment, "?");
  return netlocNormalisesSafely(netloc) ? { scheme, netloc, query, fragment } : undefined;
}

/** `SplitResult.hostname`: lower-cased up to a `%` (an IPv6 zone keeps its case); undefined for none. */
function hostnameOfSplit(parts: SplitUrl): string | undefined {
  const [hostname] = partition(rpartition(parts.netloc, "@")[2], ":");
  if (!hostname) return undefined;
  const [host, percent, zone] = partition(hostname, "%");
  return host.toLowerCase() + (percent ? `%${zone}` : "");
}

/** `urlsplit(url).hostname` of an address `sourceUrl` accepted. */
export function hostnameOf(url: string): string | undefined {
  const parts = splitUrl(url);
  return parts && hostnameOfSplit(parts);
}

/** Whether the netloc names a user or a password (`SplitResult.username or SplitResult.password`, an empty one is none). */
function hasCredentials(netloc: string): boolean {
  const [userinfo, haveInfo] = rpartition(netloc, "@");
  if (!haveInfo) return false;
  const [username, , password] = partition(userinfo, ":");
  return username !== "" || password !== "";
}

const HEX_PAIR = /^[0-9A-Fa-f]{2}/;
/** A run of ASCII characters (everything up to U+007F). */
const ASCII_RUN = /[^\u0080-\u{10ffff}]+/gu;
const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

/** `urllib.parse.unquote` of one ASCII run: `%XX` as bytes, decoded as UTF-8 with U+FFFD for what does not decode. */
function unquoteAscii(run: string): string {
  const [first = "", ...rest] = run.split("%");
  const bytes: number[] = Array.from(first, (c) => c.charCodeAt(0));
  for (const item of rest) {
    const pair = HEX_PAIR.exec(item);
    const tail = pair ? item.slice(2) : `%${item}`;
    if (pair) bytes.push(Number.parseInt(pair[0], 16));
    bytes.push(...Array.from(tail, (c) => c.charCodeAt(0)));
  }
  return UTF8.decode(Uint8Array.from(bytes));
}

/** `urllib.parse.unquote_plus`: `+` is a space, `%XX` is decoded in each ASCII run, anything else kept. */
export function unquotePlus(text: string): string {
  const spaced = text.replaceAll("+", " ");
  return spaced.includes("%") ? spaced.replace(ASCII_RUN, unquoteAscii) : spaced;
}

/** Whether a query or fragment parameter's name (`;` separates parameters too, for many servers) names a credential. */
function carriesSecret(query: string, fragment: string): boolean {
  for (const chunk of [query, fragment]) {
    for (const param of chunk.split(/[&;]/)) {
      const low = unquotePlus(partition(param, "=")[0]).toLowerCase();
      const compact = low.replace(/[^a-z0-9]/gu, "");
      if (SECRET_PARAM_WORDS.some((w) => compact.includes(w))) return true;
      if (low.split(/[^a-z0-9]+/u).some((part) => SECRET_PARAM_PARTS.has(part))) return true;
    }
  }
  return false;
}

/** Whether every character of `raw` may stand in a shown address: no white space, hidden or markup character. */
function plainAddress(raw: string): boolean {
  for (const ch of raw) {
    if (SPACE_ONE.test(ch) || invisible(ch) || URL_MARKUP.has(ch)) return false;
  }
  return true;
}

/**
 * `raw` when it can be a source's link: an absolute http(s) address with a host, no credentials (neither in it as a
 * user nor as a query or fragment parameter), no whitespace, control, format or markup character (`<>"'` and the like),
 * nothing a credential mask would touch, at most SOURCE_URL_MAX characters. Undefined otherwise.
 */
export function sourceUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw || cpLength(raw) > SOURCE_URL_MAX || !plainAddress(raw)) return undefined;
  const parts = splitUrl(raw);
  if (!parts || (parts.scheme !== "http" && parts.scheme !== "https") || !hostnameOfSplit(parts)) return undefined;
  if (hasCredentials(parts.netloc) || redactText(raw).masked) return undefined;
  return carriesSecret(parts.query, parts.fragment) ? undefined : raw;
}

/** The title read at all, each hidden character a space, masked while a credential still has its own shape. */
function visibleTitle(raw: unknown): string {
  const head = cpHead(typeof raw === "string" ? raw : "", SOURCE_TITLE_INPUT_MAX);
  let out = "";
  for (const ch of head) out += invisible(ch) ? " " : ch;
  return redactText(out).text;
}

/**
 * A source's title as a citation shows it: one plain line, without markup, tags, character references, a leading
 * heading, list or quote marker, addresses, token-like runs or hidden characters, at most CITATION_NAME_MAX characters,
 * masked before and after; the host when nothing is left.
 */
export function sourceName(raw: unknown, host: string): string {
  // (masked first, while a credential still has its own shape: the markup below takes its `_` and its prefix with it)
  let plain = visibleTitle(raw);
  // (an `&` left after the references is shown as the full-width ＆, which nothing decodes: `&#60img` is markup too)
  plain = plain.replace(TAG, " ").replace(ENTITY, " ").replace(LINK, " $1 ").replaceAll("&", "\uff06");
  plain = squashSpaces(plain.replace(ADDRESS, " ").replace(TOKEN_RUN, " ").replace(MARKUP, " "));
  for (let block = BLOCK.exec(plain); block; block = BLOCK.exec(plain)) {
    plain = pyLstrip(plain.slice(block[0].length));
  }
  return redactText(pyStrip(cpHead(plain, CITATION_NAME_MAX))).text || host;
}
