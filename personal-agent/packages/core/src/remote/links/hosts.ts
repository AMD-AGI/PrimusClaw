// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The host an address in a remote agent's text points at (ported from the Python worker's `answer_links.host_of`). */
import { pyLower, pyStrip } from "../../text/py-text.js";

/** What a host name shown in a code span may hold. */
const HOST = /^[a-z0-9.\-\u{80}-\u{ffff}]{1,253}$/u;
const SCHEMELESS = /^(?:www\.)?[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,10}\.[A-Za-z]{2,24}(?:[:/?#]|$)/u;
/** `_check_bracketed_host`'s IPvFuture address (`.` of Python's re: anything but a line feed). */
const IPV_FUTURE = /^v[a-fA-F0-9]+\.[^\n]+$/u;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*$/u;

/** `text.lstrip()` of the C0 controls and space urlsplit takes off the front (`_WHATWG_C0_CONTROL_OR_SPACE`). */
function lstripC0(text: string): string {
  let start = 0;
  while (start < text.length && text.charCodeAt(start) <= 0x20) start += 1;
  return text.slice(start);
}

/** urllib's `_checknetloc`: a non-ASCII netloc that NFKC normalization turns into one with `/?#@:` is refused. */
function refusedNetloc(netloc: string): boolean {
  if (/^[\p{ASCII}]*$/u.test(netloc)) return false;
  const bare = netloc.replace(/[@:#?]/gu, "");
  const folded = bare.normalize("NFKC");
  return folded !== bare && /[/?#@:]/u.test(folded);
}

/** The host name in a netloc's host and port, as urlsplit's `_hostinfo` reads it; undefined where `_check_bracketed_netloc`
 * refuses it (`bracketed`: the netloc holds both brackets). A bracketed host that passes is an IP address or an IPvFuture one:
 * only the IPvFuture one (`v1.x`) can be a name shown here, an IPv6 address holds a colon and an IPv4 one is refused. */
function hostPart(hostinfo: string, bracketed: boolean): string | undefined {
  const open = hostinfo.indexOf("[");
  let name: string;
  if (open >= 0) {
    if (bracketed && open > 0) return undefined; // (no data before the bracket)
    const inner = hostinfo.slice(open + 1);
    const close = inner.indexOf("]");
    name = close < 0 ? inner : inner.slice(0, close);
    if (bracketed && close >= 0 && close + 1 < inner.length && inner.charAt(close + 1) !== ":") return undefined;
  } else {
    const at = hostinfo.indexOf(":");
    name = at < 0 ? hostinfo : hostinfo.slice(0, at);
  }
  if (bracketed && !IPV_FUTURE.test(name)) return undefined;
  return name;
}

/** `urlsplit(url).hostname` of Python's urllib, or null when it names none; undefined where urlsplit refuses (`ValueError`). */
function hostnameOf(raw: string): string | null | undefined {
  let url = lstripC0(raw).replace(/[\t\r\n]/gu, "");
  const colon = url.indexOf(":");
  if (colon > 0 && SCHEME.test(url.slice(0, colon))) url = url.slice(colon + 1);
  if (!url.startsWith("//")) return null;
  const rest = url.slice(2);
  const end = rest.search(/[/?#]/u);
  const netloc = end < 0 ? rest : rest.slice(0, end);
  if (netloc.includes("[") !== netloc.includes("]")) return undefined; // (Invalid IPv6 URL)
  if (refusedNetloc(netloc)) return undefined;
  const name = hostPart(netloc.slice(netloc.lastIndexOf("@") + 1), netloc.includes("["));
  if (name === undefined) return undefined;
  return name ? pyLower(name) : null;
}

/** The host name an address points at, "" when it names none (a relative path, `javascript:`, a fragment, a host that is not one). */
export function hostOf(address: string): string {
  let dest = pyStrip(pyStrip(address), "<>");
  let host: string;
  if (pyLower(dest).startsWith("mailto:")) {
    const at = dest.indexOf("@");
    host = at < 0 ? "" : (dest.slice(at + 1).split("?", 1)[0] ?? "");
  } else {
    if (dest.startsWith("//")) dest = `http:${dest}`;
    else if (!dest.includes("://") && SCHEMELESS.test(Array.from(dest).slice(0, 300).join(""))) dest = `http://${dest}`;
    host = hostnameOf(dest) ?? "";
  }
  host = pyLower(host);
  return HOST.test(host) ? host : "";
}
