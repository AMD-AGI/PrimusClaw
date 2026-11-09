// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which link destinations may become an `<a href>`: an absolute http or https URL without white space or control
 * characters. The split follows Python's `urllib.parse.urlsplit` (3.14) and its `.hostname` / `.port`, including the
 * errors it raises (a bracketed host that is not IPv6, a bad port, a netloc that NFKC turns into a delimiter), so the
 * same strings pass as in the Python worker.
 */
import { cpLength } from "@primusclaw/personal-agent";
import { MAX_URL_CHARS } from "./constants.js";
import { strip } from "./escape.js";

class UrlError extends Error {}

const SCHEME_CHARS = /^[A-Za-z0-9+\-.]*$/;
const ASCII = /^\p{ASCII}*$/u;
const ASCII_LETTER = /^[A-Za-z]/;
const IPV_FUTURE = /^v[a-fA-F0-9]+\.[\s\S]+$/;
const HEXTET = /^[0-9a-fA-F]*$/;
const OCTET = /^[0-9]+$/;

interface Split {
  readonly scheme: string;
  readonly netloc: string;
}

/** Python's `(head, sep, tail) = text.partition(sep)`. */
function partition(text: string, sep: string): [string, boolean, string] {
  const at = text.indexOf(sep);
  return at < 0 ? [text, false, ""] : [text.slice(0, at), true, text.slice(at + sep.length)];
}

/** The part after the last `sep` (all of `text` when there is none): Python's `text.rpartition(sep)[2]`. */
function afterLast(text: string, sep: string): string {
  return text.slice(text.lastIndexOf(sep) + 1);
}

/** Python's `text.split(sep, maxsplit)`. */
function splitMax(text: string, sep: string, maxsplit: number): string[] {
  const parts = text.split(sep);
  return parts.length <= maxsplit + 1 ? parts : [...parts.slice(0, maxsplit), parts.slice(maxsplit).join(sep)];
}

function isIpv4(text: string): boolean {
  if (!text || text.includes("/")) return false;
  const octets = text.split(".");
  return (
    octets.length === 4 &&
    octets.every((o) => OCTET.test(o) && o.length <= 3 && (o === "0" || !o.startsWith("0")) && Number(o) <= 255)
  );
}

/** Whether the hextets, with at most one empty run for "::", make the eight of an address (`_ip_int_from_string`). */
function hextetsFit(parts: readonly string[]): boolean {
  const inner = parts.slice(1, -1).flatMap((p, i) => (p ? [] : [i + 1]));
  if (inner.length > 1) return false;
  const skip = inner[0];
  let hi = parts.length;
  let lo = 0;
  if (skip !== undefined) {
    hi = skip - (parts[0] ? 0 : 1);
    lo = parts.length - skip - 1 - (parts.at(-1) ? 0 : 1);
    if ((!parts[0] && hi) || (!parts.at(-1) && lo) || 8 - (hi + lo) < 1) return false;
  } else if (parts.length !== 8 || !parts[0] || !parts.at(-1)) {
    return false;
  }
  return [...parts.slice(0, hi), ...parts.slice(parts.length - lo)].every(
    (h) => h !== "" && HEXTET.test(h) && h.length <= 4,
  );
}

/** Python's `ipaddress.IPv6Address(text)` succeeds. */
function isIpv6(text: string): boolean {
  if (text.includes("/")) return false;
  const [address, scoped, scope] = partition(text, "%");
  if (scoped && (!scope || scope.includes("%"))) return false;
  if (!address || cpLength(address) > 45) return false;
  const parts = splitMax(address, ":", 9);
  if (parts.length < 3) return false;
  const last = parts.at(-1) ?? "";
  if (last.includes(".")) {
    if (!isIpv4(last)) return false;
    parts.splice(-1, 1, "0", "0");
  }
  return parts.length <= 9 && hextetsFit(parts);
}

/** `_check_bracketed_netloc`: the host in brackets must be IPv6 or IPvFuture, with nothing around it but a port. */
function checkBracketedNetloc(netloc: string): void {
  const hostAndPort = afterLast(netloc, "@");
  const [before, open, bracketed] = partition(hostAndPort, "[");
  let host: string;
  if (open) {
    if (before) throw new UrlError();
    const [inside, , port] = partition(bracketed, "]");
    if (port && !port.startsWith(":")) throw new UrlError();
    host = inside;
  } else {
    host = partition(hostAndPort, ":")[0];
  }
  const ok = host.startsWith("v") ? IPV_FUTURE.test(host) : isIpv6(host);
  if (!ok) throw new UrlError();
}

/** `_checknetloc`: a netloc that NFKC normalisation turns into one with a delimiter in it. */
function checkNetloc(netloc: string): void {
  if (!netloc || ASCII.test(netloc)) return;
  const n = netloc.replace(/[@:#?]/g, "");
  const normalized = n.normalize("NFKC");
  if (n !== normalized && /[/?#@:]/.test(normalized)) throw new UrlError();
}

/** `urlsplit(url)`'s scheme and netloc, for a URL with no characters <= 0x20 (so none to strip or remove). */
function urlsplit(url: string): Split {
  let rest = url;
  let scheme = "";
  const colon = rest.indexOf(":");
  if (colon > 0 && ASCII_LETTER.test(rest) && SCHEME_CHARS.test(rest.slice(0, colon))) {
    scheme = rest.slice(0, colon).toLowerCase();
    rest = rest.slice(colon + 1);
  }
  let netloc = "";
  if (rest.startsWith("//")) {
    const ends = ["/", "?", "#"].map((c) => rest.indexOf(c, 2)).filter((at) => at >= 0);
    netloc = rest.slice(2, ends.length ? Math.min(...ends) : rest.length);
    if (netloc.includes("[") !== netloc.includes("]")) throw new UrlError();
    if (netloc.includes("[")) checkBracketedNetloc(netloc);
  }
  checkNetloc(netloc);
  return { scheme, netloc };
}

/** `.hostname` and `.port` of a split: (host or "", port text or ""). */
function hostinfo(netloc: string): [string, string] {
  const info = afterLast(netloc, "@");
  const [, open, bracketed] = partition(info, "[");
  if (open) {
    const [host, , after] = partition(bracketed, "]");
    return [host, partition(after, ":")[2]];
  }
  const [host, , port] = partition(info, ":");
  return [host, port];
}

/** `.port`: raises for a port that is not ASCII digits or is out of range. */
function checkPort(port: string): void {
  if (port && !(OCTET.test(port) && Number(port) <= 65535)) throw new UrlError();
}

/** Whether `url` holds a character <= 0x20 or in 0x7f-0x9f. */
function hasControlOrSpace(url: string): boolean {
  for (let i = 0; i < url.length; i++) {
    const code = url.charCodeAt(i);
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** `url` when it is an absolute http or https URL without whitespace or control characters; else null. */
export function safeUrl(raw: string): string | null {
  const url = strip(raw);
  if (!url || cpLength(url) > MAX_URL_CHARS || hasControlOrSpace(url)) return null;
  let parts: Split;
  try {
    parts = urlsplit(url);
    checkPort(hostinfo(parts.netloc)[1]);
  } catch (err) {
    if (err instanceof UrlError) return null;
    throw err;
  }
  const scheme = parts.scheme.toLowerCase();
  if ((scheme !== "http" && scheme !== "https") || !parts.netloc || !hostinfo(parts.netloc)[0]) return null;
  return url;
}
