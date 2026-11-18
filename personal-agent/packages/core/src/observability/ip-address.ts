// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * IP addresses parsed and written the way Python's `ipaddress.ip_address` and `str()` do (core cannot use `node:net`,
 * and the logged form has to stay the one SIEM rules were written against): strict dotted IPv4 (no leading zeros), IPv6
 * with at most one `::` and an optional dotted IPv4 tail, written lower-case with the first longest run of two or more
 * zero groups compressed, and an IPv4-mapped address as `::ffff:a.b.c.d`. No scope id (`%zone`).
 */

/** An address as Python writes it, and, for an IPv4-mapped IPv6 address, the IPv4 address it maps. */
export interface IpAddress {
  readonly address: string;
  readonly mappedV4: string | null;
}

const HEX = /^[0-9A-Fa-f]*$/;

function parseOctet(text: string): number | null {
  if (!/^[0-9]{1,3}$/.test(text) || (text !== "0" && text.startsWith("0"))) return null;
  const value = Number(text);
  return value > 255 ? null : value;
}

function parseIpv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map(parseOctet);
  return octets.every((o): o is number => o !== null) ? octets : null;
}

function parseHextet(text: string): number | null {
  if (text === "" || text.length > 4 || !HEX.test(text)) return null;
  return parseInt(text, 16);
}

/** Where the `::` is, and how many groups it stands for; null when the parts do not make eight groups. */
function layout(parts: readonly string[]): { hi: number; lo: number } | null {
  let skip: number | null = null;
  for (let i = 1; i < parts.length - 1; i++) {
    if (parts[i] !== "") continue;
    if (skip !== null) return null;
    skip = i;
  }
  const first = parts[0] === "";
  const last = parts[parts.length - 1] === "";
  if (skip === null) return parts.length === 8 && !first && !last ? { hi: 8, lo: 0 } : null;
  let hi = skip;
  let lo = parts.length - skip - 1;
  if (first && --hi !== 0) return null;
  if (last && --lo !== 0) return null;
  return hi + lo < 8 ? { hi, lo } : null;
}

function parseIpv6(text: string): number[] | null {
  const parts = text.split(":");
  if (parts.length < 3) return null;
  const tail = parts[parts.length - 1] ?? "";
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (v4 === null) return null;
    const [a = 0, b = 0, c = 0, d = 0] = v4;
    parts.splice(parts.length - 1, 1, ((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
  }
  if (parts.length > 9) return null;
  const shape = layout(parts);
  if (shape === null) return null;
  const head = parts.slice(0, shape.hi).map(parseHextet);
  const rest = shape.lo === 0 ? [] : parts.slice(-shape.lo).map(parseHextet);
  const groups = [...head, ...new Array<number>(8 - shape.hi - shape.lo).fill(0), ...rest];
  return groups.every((g): g is number => g !== null) ? groups : null;
}

/** Python's `_compress_hextets`: the first longest run of two or more zero groups becomes `::`. */
function writeIpv6(groups: readonly number[]): string {
  let bestStart = -1;
  let bestLen = 0;
  let start = -1;
  groups.forEach((group, i) => {
    if (group !== 0) {
      start = -1;
      return;
    }
    if (start === -1) start = i;
    if (i - start + 1 > bestLen) {
      bestStart = start;
      bestLen = i - start + 1;
    }
  });
  const hextets = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hextets.join(":");
  const before = hextets.slice(0, bestStart).join(":");
  const after = hextets.slice(bestStart + bestLen).join(":");
  return `${before}::${after}`;
}

function mapped(groups: readonly number[]): string | null {
  const zeros = groups.slice(0, 5).every((g) => g === 0);
  if (!zeros || groups[5] !== 0xffff) return null;
  const [hi = 0, lo = 0] = groups.slice(6);
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
}

/** `text` as an IP address the way Python's `ipaddress` reads and writes it, or null when it is not one. */
export function parseIpAddress(text: string): IpAddress | null {
  if (text === "" || text.length > 45) return null;
  if (!text.includes(":")) {
    const v4 = parseIpv4(text);
    return v4 === null ? null : { address: v4.join("."), mappedV4: null };
  }
  const groups = parseIpv6(text);
  if (groups === null) return null;
  const v4 = mapped(groups);
  return { address: v4 === null ? writeIpv6(groups) : `::ffff:${v4}`, mappedV4: v4 };
}
