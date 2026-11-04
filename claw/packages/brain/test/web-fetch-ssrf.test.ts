// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * web_fetch runs inside the Brain, next to the API, NATS, Postgres and the
 * cluster's metadata endpoint, so what it may connect to is the whole guard.
 * The cases are the ones a fetch from inside a cluster reaches for: a
 * ClusterIP, the link-local metadata address, an in-cluster service name, and a
 * public-looking name that resolves inward at connect time.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import type dns from "node:dns";

import { WebFetchService, fetchWithRedirects, guardedLookup, isBlockedAddress } from "../src/tools/web/fetch.js";

test("address ranges: inward addresses are blocked, public ones are not", () => {
  const cases: Array<[string, boolean]> = [
    ["10.96.0.1", true],            // a typical ClusterIP
    ["192.168.170.254", true],      // a ClusterIP drawn from 192.168/16
    ["172.16.1.239", true],         // pod IP shape
    ["169.254.169.254", true],      // cloud metadata
    ["127.0.0.1", true],
    ["0.0.0.0", true],
    ["100.64.0.1", true],
    ["::1", true],
    ["::", true],
    ["::ffff:169.254.169.254", true],
    ["::ffff:a9fe:a9fe", true],      // the same, hex-mapped
    ["64:ff9b::a9fe:a9fe", true],    // NAT64 of the metadata address
    ["::169.254.169.254", true],     // IPv4-compatible (::/96) form of the metadata address
    ["::a9fe:a9fe", true],           // the same, as the URL parser normalises it
    ["::a00:1", true],               // IPv4-compatible 10.0.0.1
    ["::ffff:10.96.0.1", true],
    ["::ffff:0:a9fe:a9fe", true],    // IPv4-translated (::ffff:0:0:0/96)
    ["64:ff9b::7f00:1", true],       // NAT64 of loopback
    ["::ffff:808:808", false],       // mapped public 8.8.8.8 is judged as 8.8.8.8
    ["64:ff9b::808:808", false],     // NAT64 of public 8.8.8.8
    ["fe80::1", true],
    ["fd00::1", true],
    ["not-an-ip", true],
    ["93.184.215.14", false],
    ["8.8.8.8", false],
    ["2606:4700:4700::1111", false],
  ];
  for (const [ip, blocked] of cases) {
    assert.equal(isBlockedAddress(ip), blocked, `${ip} blocked=${blocked}`);
  }
});

type Answer = dns.LookupAddress[];
function stubResolver(answer: Answer) {
  const asked: string[] = [];
  const resolve = (name: string, _o: dns.LookupAllOptions, cb: (e: NodeJS.ErrnoException | null, a: Answer) => void) => {
    asked.push(name);
    cb(null, answer);
  };
  return { resolve, asked };
}

function lookupOnce(lookup: net.LookupFunction, host: string): Promise<{ err: Error | null; address: unknown }> {
  return new Promise((resolve) => {
    lookup(host, { family: 0 } as dns.LookupOneOptions, (err, address) => resolve({ err, address }));
  });
}

test("the connect-time lookup refuses a name that resolves inward, and resolves it as absolute", async () => {
  const inward = stubResolver([{ address: "93.184.215.14", family: 4 }, { address: "192.168.170.254", family: 4 }]);
  const r = await lookupOnce(guardedLookup(inward.resolve), "api.example.com");
  assert.match(String(r.err?.message), /^SSRF: api\.example\.com resolves to blocked address 192\.168\.170\.254$/);
  assert.deepEqual(inward.asked, ["api.example.com."], "search domains must not apply: the name is looked up with a trailing dot");

  const outward = stubResolver([{ address: "93.184.215.14", family: 4 }]);
  const ok = await lookupOnce(guardedLookup(outward.resolve), "example.com");
  assert.equal(ok.err, null);
  assert.equal(ok.address, "93.184.215.14");
});

test("a name whose AAAA answer carries an inward IPv4 address is refused", async () => {
  for (const address of ["::a9fe:a9fe", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe", "::a00:1"]) {
    const r = await lookupOnce(guardedLookup(stubResolver([{ address, family: 6 }]).resolve), "v6.example.com");
    assert.match(String(r.err?.message), /^SSRF: /, `${address} -> ${r.err?.message} / ${String(r.address)}`);
  }
});

// A plain TCP listener on loopback: whatever the guard lets through shows up as a connection.
let connections = 0;
const server = net.createServer((s) => { connections++; s.destroy(); });
const port: number = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
});
after(() => server.close());

test("a public-looking name that resolves to loopback at connect time never connects", async () => {
  connections = 0;
  const rebinding = stubResolver([{ address: "127.0.0.1", family: 4 }]);
  await assert.rejects(
    fetchWithRedirects(new URL(`https://rebind.example.com:${port}/`), 1024, undefined, rebinding.resolve),
    /SSRF/,
  );
  assert.equal(rebinding.asked.length, 1, "the connection's own lookup is the one that was checked");
  assert.equal(connections, 0, "the socket was dialled to a blocked address");
});

test("web_fetch refuses inward targets with an SSRF error and without connecting", async () => {
  connections = 0;
  const svc = new WebFetchService({} as never);
  const targets = [
    `https://127.0.0.1:${port}/`,
    "https://169.254.169.254/latest/meta-data/",
    "https://192.168.170.254/v1/health",
    "https://10.96.0.1/",
    "https://kubernetes.default.svc.cluster.local/",
    "https://api.some-namespace.svc/",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://anything.localhost/",
  ];
  for (const url of targets) {
    const out = await svc.execute({ url });
    assert.match(out, /^Error: SSRF: /, `${url} -> ${out}`);
  }
  assert.equal(connections, 0, "a refused target still reached the listener");
});
