// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Where an outbound notification may be sent.
 *
 * A subscription URL is supplied by a user and fetched by the server, so it is
 * an SSRF vector: https only, and the resolved address must not be private,
 * loopback or link-local. A host named in `NOTIFY_WEBHOOK_ALLOWED_HOSTS` is the
 * operator's explicit exception (an in-cluster receiver), and is the only case
 * where plain http is accepted.
 *
 * The address that passed the check is the address connected to: the caller
 * pins it, so a name that resolves differently the second time cannot move the
 * request somewhere the check did not see.
 */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) BLOCKED.addSubnet(net, prefix, "ipv6");

/** IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is judged by the IPv4 address inside it. */
function unmapped(address: string): { address: string; family: "ipv4" | "ipv6" } {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (m) return { address: m[1], family: "ipv4" };
  return { address, family: isIP(address) === 4 ? "ipv4" : "ipv6" };
}

export function isPrivateAddress(address: string): boolean {
  const u = unmapped(address);
  return BLOCKED.check(u.address, u.family);
}

export function parseAllowedHosts(raw: string): Set<string> {
  return new Set(raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));
}

export type GuardResult =
  | { ok: true; url: URL; address: string; family: 4 | 6 }
  | { ok: false; reason: string };

export type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>;

const defaultResolver: Resolver = (host) => lookup(host, { all: true });

export async function guardWebhookUrl(
  raw: string,
  allowedHosts: Set<string>,
  resolve: Resolver = defaultResolver,
): Promise<GuardResult> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.username || url.password) return { ok: false, reason: "credentials_in_url" };
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const allowed = allowedHosts.has(host);
  if (url.protocol !== "https:" && !(allowed && url.protocol === "http:")) {
    return { ok: false, reason: "https_required" };
  }
  let addresses: Array<{ address: string; family: number }>;
  if (isIP(host)) {
    addresses = [{ address: host, family: isIP(host) }];
  } else {
    try {
      addresses = await resolve(host);
    } catch {
      return { ok: false, reason: "unresolvable_host" };
    }
  }
  if (!addresses.length) return { ok: false, reason: "unresolvable_host" };
  if (!allowed && addresses.some((a) => isPrivateAddress(a.address))) {
    return { ok: false, reason: "private_address" };
  }
  const pick = addresses[0];
  return { ok: true, url, address: pick.address, family: pick.family === 6 ? 6 : 4 };
}
