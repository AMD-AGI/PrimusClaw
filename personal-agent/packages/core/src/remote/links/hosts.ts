// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The host an address in a remote agent's text points at (ported from the Python worker's `answer_links.host_of`). */
import { pyStrip } from "../../text/py-text.js";

/** What a host name shown in a code span may hold. */
const HOST = /^[a-z0-9.\-\u{80}-\u{ffff}]{1,253}$/u;
const SCHEMELESS = /^(?:www\.)?[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,10}\.[A-Za-z]{2,24}(?:[:/?#]|$)/u;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*$/u;

/** `text.lstrip()` of the C0 controls and space urlsplit takes off the front (`_WHATWG_C0_CONTROL_OR_SPACE`). */
function lstripC0(text: string): string {
  let start = 0;
  while (start < text.length && text.charCodeAt(start) <= 0x20) start += 1;
  return text.slice(start);
}

/** urllib's `_checknetloc`: a non-ASCII netloc that NFKC normalization turns into one with `/?#@:` is refused. */
function refusedNetloc(netloc: string): boolean {
  if (/^[\x00-\x7f]*$/u.test(netloc)) return false;
  const bare = netloc.replace(/[@:#?]/gu, "");
  const folded = bare.normalize("NFKC");
  return folded !== bare && /[/?#@:]/u.test(folded);
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
  const host = netloc.slice(netloc.lastIndexOf("@") + 1);
  let name: string;
  const open = host.indexOf("[");
  if (open >= 0) {
    // (a bracketed host is an IPv6 address: it has a colon, which no host shown may hold, so what Python validates is moot here)
    const inner = host.slice(open + 1);
    const close = inner.indexOf("]");
    name = close < 0 ? inner : inner.slice(0, close);
  } else {
    const at = host.indexOf(":");
    name = at < 0 ? host : host.slice(0, at);
  }
  return name ? name.toLowerCase() : null;
}

/** The host name an address points at, "" when it names none (a relative path, `javascript:`, a fragment, a host that is not one). */
export function hostOf(address: string): string {
  let dest = pyStrip(pyStrip(address), "<>");
  let host: string;
  if (dest.toLowerCase().startsWith("mailto:")) {
    const at = dest.indexOf("@");
    host = at < 0 ? "" : (dest.slice(at + 1).split("?", 1)[0] ?? "");
  } else {
    if (dest.startsWith("//")) dest = `http:${dest}`;
    else if (!dest.includes("://") && SCHEMELESS.test(Array.from(dest).slice(0, 300).join(""))) dest = `http://${dest}`;
    host = hostnameOf(dest) ?? "";
  }
  host = host.toLowerCase();
  return HOST.test(host) ? host : "";
}
