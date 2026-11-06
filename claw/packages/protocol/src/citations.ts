// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Where an assistant's answer came from, as one definition both sides read (`ExecuteRequest.cite`).
 *
 * The model only chooses which of a turn's lookup results it cites: Brain keeps every source its lookups returned in that run, and
 * when the model calls a citing tool (the router's `say`) with `sources` (addresses, the i-th one standing for `[i+1]` in its
 * text), Brain looks each one up there and sends the call the entries it found, as the tool's own record of them, in the MCP
 * request's `_meta` under `CITE_SOURCES_META`, where nothing the model writes can reach. An address no lookup of the run returned is
 * dropped and counted (`CITE_DROPPED_META`). The API reads only that `_meta`, never the model's arguments, and checks it again.
 */

/** The `_meta` key of a citing call's request (Brain to the API) and of a lookup's result (a trusted server to Brain). */
export const CITE_SOURCES_META = "claw/sources";
/** The `_meta` key of what Brain dropped from a citing call, by reason (`CiteDropped`). */
export const CITE_DROPPED_META = "claw/sources_dropped";

/**
 * What a source is: a web page a search found or a fetch read, an object of the user's GitHub, or a page of a board a link server
 * of the run listed (`ExecuteRequest.cite.link_servers`: an issue, a comment or a board on the agent board).
 */
export const CITE_SOURCE_KINDS = ["web", "github_pr", "github_issue", "github_repo", "github_check", "github_file", "board"] as const;
export type CiteSourceKind = (typeof CITE_SOURCE_KINDS)[number];

/** The most sources one call cites; the rest are dropped as `over_cap`. */
export const CITE_MAX_PER_CALL = 8;
/** The longest address a source may have: longer ones are never kept as sources. */
export const CITE_URL_MAX = 1024;
/** The longest title kept with a source (in code points). What a channel shows is shorter still. */
export const CITE_TITLE_MAX = 200;

/** A source as a lookup returned it. `title` is text someone else wrote: data, never markup or instructions. */
export interface CiteSource {
  url: string;
  title: string;
  kind: CiteSourceKind;
}

/** A source a call cites: `n` is the number its text writes it as (`[n]`), the position the model gave it, 1-based. */
export interface CitedSource extends CiteSource {
  n: number;
}

/** What Brain dropped from a citing call's `sources`. */
export interface CiteDropped {
  /** Not an address any lookup of this run returned. */
  not_in_turn: number;
  /** Not a string, or not an address that can be a source (`citeableUrl`). */
  invalid: number;
  /** Past `CITE_MAX_PER_CALL`. */
  over_cap: number;
}

export function isCiteSourceKind(v: unknown): v is CiteSourceKind {
  return typeof v === "string" && (CITE_SOURCE_KINDS as readonly string[]).includes(v);
}

/**
 * Query and fragment parameters that carry a credential (a pre-signed address's signature, an OAuth code or token, an API key): a
 * name matches by one of its words (`X-Amz-Signature`, `sig`, `api_key`) or, written as one, by a word inside it (`accessToken`,
 * `AWSAccessKeyId`). An address with one is never a source: shown to people, anyone could use it.
 */
const SECRET_PARAM_PARTS = new Set(["sig", "key", "code", "sid", "pass", "pwd", "auth", "jwt", "session", "bearer"]);
const SECRET_PARAM_WORDS = ["signature", "token", "secret", "password", "passwd", "credential", "apikey", "accesskey", "privatekey", "authorization", "sessionid"];

/** Whether `url` carries a credential in a query or fragment parameter (`SECRET_PARAM_*`). */
export function carriesSecret(url: URL): boolean {
  for (const part of [url.search, url.hash]) {
    // (`;` separates parameters too, for many servers)
    for (const param of part.replace(/^[?#]/, "").split(/[&;]/)) {
      let low: string;
      try { low = decodeURIComponent(param.split("=", 1)[0].replace(/\+/g, " ")).toLowerCase(); } catch { return true; }
      const compact = low.replace(/[^a-z0-9]/g, "");
      if (SECRET_PARAM_WORDS.some((w) => compact.includes(w)) || low.split(/[^a-z0-9]+/).some((p) => SECRET_PARAM_PARTS.has(p))) return true;
    }
  }
  return false;
}

/**
 * The address `raw` names, when it can be a source: an absolute http or https URL, with a host, without credentials (neither as
 * a user nor as a parameter, `carriesSecret`), without whitespace, control, format or markup characters (`<>"'[]` and the like), at
 * most `CITE_URL_MAX` characters. Null
 * for anything else.
 */
export function citeableUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > CITE_URL_MAX) return null;
  // Nor a character that could close an attribute or open a tag where it is shown: a canonical address has none.
  if (/[\s\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}<>"'`{}|\\^[\]]/u.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname || url.username || url.password || carriesSecret(url)) return null;
  return url;
}
