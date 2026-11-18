// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The few Python semantics the ingress's decisions depend on, so it takes the same branch as the Python Function it
 * replaces for the same request: truthiness, `str()`, `str.strip()`, `int()` on a claim, `urllib.parse.quote` and
 * `urllib.parse.urlsplit`. Each is written for the values a JSON document can hold, which is all it applies them to.
 */
import { parseIpAddress } from "@primusclaw/personal-agent";

/** The characters `str.isspace()` is true for, which is what `str.strip()` takes away. */
// eslint-disable-next-line no-control-regex -- Python's whitespace includes these control characters
const SPACE = /^[\t\n\x0b\x0c\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u;
const isSpace = (ch: string): boolean => SPACE.test(ch);

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** `isinstance(value, dict)` for a parsed JSON value. */
export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}

/** Python truthiness: None, False, 0, "" and empty containers are false. */
export function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return true;
}

/** `dict.get(key)`: own keys only, `undefined` when absent (Python's None). */
export function get(obj: JsonObject, key: string): Json | undefined {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/** An empty dict, for `x or {}`. */
export const EMPTY: JsonObject = Object.freeze({});

/** `a or b`. */
export function or<T, U>(a: T, b: U): T | U {
  return truthy(a) ? a : b;
}

/** The number of characters as Python counts them (code points, not UTF-16 units). */
export function pyLen(value: string): number {
  return Array.from(value).length;
}

/** `str.strip()` with no argument. */
export function strip(value: string): string {
  // A scan from each end, not a /\s+$/ regex, which takes quadratic time on a long run of spaces.
  let start = 0;
  let end = value.length;
  while (start < end && isSpace(value.charAt(start))) start++;
  while (end > start && isSpace(value.charAt(end - 1))) end--;
  return value.slice(start, end);
}

/** `str.rstrip(chars)` with an explicit set of single code units. */
export function rstripChars(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value.charAt(end - 1))) end--;
  return value.slice(0, end);
}

/** `str.lstrip(chars)` with an explicit set of single code units. */
export function lstripChars(value: string, chars: string): string {
  let start = 0;
  while (start < value.length && chars.includes(value.charAt(start))) start++;
  return value.slice(start);
}

/** Python's ValueError, for the places whose callers catch exactly that. */
export class PyValueError extends Error {
  override name = "ValueError";
}

/** Python's TypeError (int() of a list, ...). */
export class PyTypeError extends Error {
  override name = "TypeError";
}

/** `value.encode("utf-8")`: raises like Python on a lone surrogate instead of writing U+FFFD. */
export function utf8(value: string): Buffer {
  if (/\p{Cs}/u.test(value)) {
    throw new PyValueError("'utf-8' codec can't encode a surrogate: surrogates not allowed");
  }
  return Buffer.from(value, "utf8");
}

/** Python's float repr: the shortest digits that round-trip, positional for exponents -4..15, else d.ddde+XX. */
export function floatRepr(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const [mantissa = "", exponentText = "0"] = Math.abs(value).toExponential().split("e");
  const exponent = Number(exponentText);
  const digits = mantissa.split(".").join("");
  const sign = value < 0 ? "-" : "";
  if (exponent >= -4 && exponent < 16) {
    if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
    const whole = digits.padEnd(exponent + 1, "0");
    const frac = digits.slice(exponent + 1);
    return `${sign}${whole.slice(0, exponent + 1)}.${frac || "0"}`;
  }
  const frac = digits.slice(1);
  const exp = `${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  return `${sign}${digits.charAt(0)}${frac ? `.${frac}` : ""}e${exp}`;
}

const hex = (code: number, width: number): string => code.toString(16).padStart(width, "0");

/** One character of a string's `repr()` (the printable ASCII range and the escapes Python uses around it). */
function reprChar(ch: string, quote: string): string {
  const code = ch.codePointAt(0) ?? 0;
  if (ch === quote || ch === "\\") return `\\${ch}`;
  if (ch === "\t") return "\\t";
  if (ch === "\n") return "\\n";
  if (ch === "\r") return "\\r";
  if (code < 0x20 || code === 0x7f) return `\\x${hex(code, 2)}`;
  if (code >= 0xd800 && code <= 0xdfff) return `\\u${hex(code, 4)}`;
  if ((code >= 0x80 && code <= 0xa0) || code === 0xad) return `\\x${hex(code, 2)}`;
  return ch;
}

/** `repr()` of a string, with Python's choice of quotes and escapes for the printable ASCII range. */
export function strRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of value) out += reprChar(ch, quote);
  return out + quote;
}

/** `repr()` of a JSON value as Python prints the dict/list/str/int/float/bool/None it parses to. */
export function repr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number")
    return Number.isInteger(value) && !Object.is(value, -0) ? String(value) : floatRepr(value);
  if (typeof value === "string") return strRepr(value);
  if (Array.isArray(value)) return `[${value.map(repr).join(", ")}]`;
  if (isObject(value)) {
    return `{${Object.entries(value)
      .map(([k, v]) => `${strRepr(k)}: ${repr(v)}`)
      .join(", ")}}`;
  }
  return "<object>";
}

/** `str(value)` of a parsed JSON value. */
export function str(value: unknown): string {
  return typeof value === "string" ? value : repr(value);
}

/**
 * `int(value)` as PyJWT applies it to `exp`, `nbf` and `iat` and the token provider to `expires_in`: a bool is 0 or 1, a
 * float is truncated (an infinite one overflows), a string must be an optionally signed run of decimal digits (single
 * underscores between them allowed, surrounding whitespace ignored). Anything else raises: ValueError for a bad string
 * or an overflow, TypeError for null, a list or a dict.
 */
export function int(value: unknown): number {
  if (value === true) return 1;
  if (value === false) return 0;
  if (typeof value === "number") {
    if (Number.isNaN(value)) throw new PyValueError("cannot convert float NaN to integer");
    if (!Number.isFinite(value)) throw new PyValueError("cannot convert float infinity to integer");
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const text = strip(value);
    if (!/^[+-]?\d+(?:_\d+)*$/.test(text)) {
      throw new PyValueError(`invalid literal for int() with base 10: ${strRepr(value)}`);
    }
    return Number(text.replace(/_/g, ""));
  }
  throw new PyTypeError("int() argument must be a string, a bytes-like object or a real number");
}

const ALWAYS_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-~";

/** `urllib.parse.quote(value, safe=safe)`. */
export function quote(value: string, safe = "/"): string {
  if (!value) return value;
  const allowed = new Set(
    ALWAYS_SAFE +
      Array.from(safe)
        .filter((c) => c.charCodeAt(0) < 128)
        .join(""),
  );
  let out = "";
  for (const byte of utf8(value)) {
    const ch = String.fromCharCode(byte);
    out += byte < 128 && allowed.has(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

// --- urllib.parse.urlsplit --------------------------------------------------------------------------------------

const C0_CONTROL_OR_SPACE = Array.from({ length: 33 }, (_, i) => String.fromCharCode(i)).join("");
const SCHEME_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+-.";

export interface SplitResult {
  scheme: string;
  netloc: string;
  path: string;
  query: string;
  fragment: string;
}

function partition(value: string, sep: string): [string, string, string] {
  const i = value.indexOf(sep);
  return i < 0 ? [value, "", ""] : [value.slice(0, i), sep, value.slice(i + sep.length)];
}

function rpartition(value: string, sep: string): [string, string, string] {
  const i = value.lastIndexOf(sep);
  return i < 0 ? ["", "", value] : [value.slice(0, i), sep, value.slice(i + sep.length)];
}

/** `ipaddress.ip_address(text).version` (a scope id allowed on IPv6); throws PyValueError for anything else. */
function ipVersion(text: string): 4 | 6 {
  const [address, percent, scope] = partition(text, "%");
  const parsed = !percent || (scope !== "" && !scope.includes("%")) ? parseIpAddress(address) : null;
  if (parsed === null || (percent && !address.includes(":"))) {
    throw new PyValueError(`${strRepr(text)} does not appear to be an IPv4 or IPv6 address`);
  }
  return address.includes(":") ? 6 : 4;
}

function checkBracketedHost(hostname: string): void {
  if (hostname.startsWith("v")) {
    if (!/^v[a-fA-F0-9]+\.[^\n]+$/.test(hostname)) throw new PyValueError("IPvFuture address is invalid");
    return;
  }
  if (ipVersion(hostname) === 4) throw new PyValueError("An IPv4 address cannot be in brackets");
}

function checkBracketedNetloc(netloc: string): void {
  const hostnameAndPort = rpartition(netloc, "@")[2];
  const [before, open, bracketed] = partition(hostnameAndPort, "[");
  let hostname: string;
  if (open) {
    if (before) throw new PyValueError("Invalid IPv6 URL");
    const [host, , port] = partition(bracketed, "]");
    if (port && !port.startsWith(":")) throw new PyValueError("Invalid IPv6 URL");
    hostname = host;
  } else {
    hostname = partition(hostnameAndPort, ":")[0];
  }
  checkBracketedHost(hostname);
}

function checkNetloc(netloc: string): void {
  if (!netloc || /^[\x00-\x7f]*$/.test(netloc)) return; // eslint-disable-line no-control-regex -- "is ASCII"
  const n = netloc.replace(/[@:#?]/g, "");
  const normalized = n.normalize("NFKC");
  if (n === normalized) return;
  for (const c of "/?#@:") {
    if (normalized.includes(c)) {
      throw new PyValueError(`netloc '${netloc}' contains invalid characters under NFKC normalization`);
    }
  }
}

function splitNetloc(url: string): [string, string] {
  if (!url.startsWith("//")) return ["", url];
  let delim = url.length;
  for (const c of "/?#") {
    const w = url.indexOf(c, 2);
    if (w >= 0) delim = Math.min(delim, w);
  }
  const netloc = url.slice(2, delim);
  const open = netloc.includes("[");
  const close = netloc.includes("]");
  if (open !== close) throw new PyValueError("Invalid IPv6 URL");
  if (open) checkBracketedNetloc(netloc);
  return [netloc, url.slice(delim)];
}

/** `urllib.parse.urlsplit(url)` (Python 3.14). Raises PyValueError where Python raises ValueError. */
export function urlsplit(input: string): SplitResult {
  let url = lstripChars(input, C0_CONTROL_OR_SPACE).replace(/[\t\r\n]/g, "");
  let scheme = "";
  let query = "";
  let fragment = "";
  const i = url.indexOf(":");
  if (i > 0 && /^[A-Za-z]/.test(url)) {
    const candidate = url.slice(0, i);
    if (Array.from(candidate).every((c) => SCHEME_CHARS.includes(c))) {
      scheme = candidate.toLowerCase();
      url = url.slice(i + 1);
    }
  }
  const [netloc, rest] = splitNetloc(url);
  url = rest;
  if (url.includes("#")) [url, , fragment] = partition(url, "#");
  if (url.includes("?")) [url, , query] = partition(url, "?");
  checkNetloc(netloc);
  return { scheme, netloc, path: url, query, fragment };
}

/** `SplitResult.hostname`: lower-cased (but not an IPv6 zone), null when empty. */
export function hostname(parts: SplitResult): string | null {
  const host = rpartition(parts.netloc, "@")[2];
  const [, open, bracketed] = partition(host, "[");
  const name = open ? partition(bracketed, "]")[0] : partition(host, ":")[0];
  if (!name) return null;
  const [address, percent, zone] = partition(name, "%");
  return address.toLowerCase() + percent + zone;
}
