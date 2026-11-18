// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import type { ServiceUrlPolicy } from "../../src/connector/hosts.js";
import { inboundFiles } from "../../src/inbound/attachments.js";
import { FETCH_TIMEOUT_MS, keepsAuthorization, MAX_REDIRECTS } from "../../src/inbound/download.js";
import { TeamsFileFetcher } from "../../src/inbound/fetcher.js";
import { FakeClock } from "../../../../test-support/clock.js";
import { FakeHttpServer } from "../../../../test-support/http-server.js";
import { bytes, dm, fetcher, fileInfo, pasted, RecordingLogger, sent, Tokens } from "./fakes.js";

/** An image the fake server can send as text (it writes text as UTF-8). */
const GIF_TEXT = "GIF89a\u0001\u0000\u0001\u0000";

/** A policy that lets the bot's token go to one origin only (the fake Bot Connector). */
function only(origin: string): ServiceUrlPolicy {
  return {
    check(url: unknown): void {
      if (typeof url !== "string" || !url.startsWith(`${origin}/`)) throw new Error("not the connector");
    },
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("the bots token never follows a redirect to another host", async () => {
  const connector = await FakeHttpServer.start();
  const elsewhere = await FakeHttpServer.start();
  try {
    elsewhere.route("GET", "/img", () => ({ status: 200, text: GIF_TEXT, headers: { "content-type": "image/gif" } }));
    connector.route("GET", "/v3/attachments/a", () => ({ status: 302, headers: { location: `${elsewhere.url}/img` } }));
    const files = new TeamsFileFetcher({
      fetch,
      clock: new FakeClock(),
      tokens: new Tokens(),
      hosts: only(connector.url),
    });
    const { fetched, failed } = await files.fetchAll([pasted(`${connector.url}/v3/attachments/a`)]);
    assert.deepEqual(failed, []);
    assert.deepEqual(
      fetched.map((f) => [f.name, f.mediaType]),
      [["image-1.gif", "image/gif"]],
    );
    assert.equal(connector.requests[0]?.headers["authorization"], "Bearer bot-token");
    assert.equal(elsewhere.requests.length, 1);
    assert.ok(!("authorization" in (elsewhere.requests[0]?.headers ?? {})), "the token did not leave the connector");
  } finally {
    await connector.close();
    await elsewhere.close();
  }
});

test("a redirect on the same host keeps the token, and a later hop off it drops it for good", async () => {
  const connector = await FakeHttpServer.start();
  const elsewhere = await FakeHttpServer.start();
  try {
    connector.route("GET", "/a", () => ({ status: 307, headers: { location: "/b" } }));
    connector.route("GET", "/b", () => ({ status: 301, headers: { location: `${elsewhere.url}/c` } }));
    elsewhere.route("GET", "/c", () => ({ status: 302, headers: { location: `${connector.url}/d` } }));
    connector.route("GET", "/d", () => ({ status: 200, text: GIF_TEXT }));
    const files = new TeamsFileFetcher({
      fetch,
      clock: new FakeClock(),
      tokens: new Tokens(),
      hosts: only(connector.url),
    });
    const { fetched } = await files.fetchAll([pasted(`${connector.url}/a`)]);
    assert.equal(fetched.length, 1);
    const auth = (r: { headers: Readonly<Record<string, string>> }): string => r.headers["authorization"] ?? "";
    assert.deepEqual(
      connector.requests.map((r) => [r.path, auth(r)]),
      [
        ["/a", "Bearer bot-token"],
        ["/b", "Bearer bot-token"],
        ["/d", ""],
      ],
    );
    assert.deepEqual(elsewhere.requests.map(auth), [""]);
  } finally {
    await connector.close();
    await elsewhere.close();
  }
});

test("the authorization rule is httpx's: same origin, or the same host upgraded to https", () => {
  const keeps = (from: string, to: string): boolean => keepsAuthorization(new URL(from), new URL(to));
  assert.equal(keeps("https://a.test/x", "https://a.test/y"), true);
  assert.equal(keeps("https://a.test/x", "https://a.test:443/y"), true);
  assert.equal(keeps("http://a.test/x", "https://a.test/y"), true);
  assert.equal(keeps("http://a.test:8080/x", "https://a.test/y"), false);
  assert.equal(keeps("https://a.test/x", "http://a.test/y"), false);
  assert.equal(keeps("https://a.test/x", "https://a.test:8443/y"), false);
  assert.equal(keeps("https://a.test/x", "https://b.a.test/y"), false);
  assert.equal(keeps("ftp://a.test/x", "ftp://a.test/y"), true);
});

test("a redirect without a location is an answer, and endless redirects fail the download", async () => {
  const logger = new RecordingLogger();
  const { files, seen } = fetcher(
    (url) => (url.pathname === "/bare" ? { status: 302 } : { status: 302, headers: { location: "/loop" } }),
    null,
    { logger },
  );
  const { failed } = await files.fetchAll([sent("a.txt", "https://x.test/bare"), sent("b.txt", "https://x.test/loop")]);
  assert.deepEqual(failed, [
    { name: "a.txt", reason: "Teams answered 302" },
    { name: "b.txt", reason: "the download failed" },
  ]);
  assert.equal(seen.length, 1 + MAX_REDIRECTS + 1);
  assert.deepEqual(logger.lines, [
    { level: "warn", message: "an attachment could not be fetched", fields: { status: 302 } },
    { level: "warn", message: "an attachment could not be fetched", fields: { errorName: "TooManyRedirects" } },
  ]);
});

test("a network error fails the download and logs its kind", async () => {
  const logger = new RecordingLogger();
  const files = new TeamsFileFetcher({
    fetch: () => Promise.reject(new TypeError("fetch failed")),
    clock: new FakeClock(),
    logger,
  });
  assert.deepEqual(await files.fetchAll([sent("a.txt", "https://x.test/a")]), {
    fetched: [],
    failed: [{ name: "a.txt", reason: "the download failed" }],
  });
  assert.deepEqual(logger.lines[0]?.fields, { errorName: "TypeError" });
});

test("an answer that never comes times out", async () => {
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  let aborted = false;
  const files = new TeamsFileFetcher({
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      }),
    clock,
    logger,
  });
  const pending = files.fetchAll([sent("a.txt", "https://x.test/a")]);
  await tick();
  await clock.advance(FETCH_TIMEOUT_MS - 1);
  await clock.advance(1);
  assert.deepEqual((await pending).failed, [{ name: "a.txt", reason: "the download failed" }]);
  assert.ok(aborted, "the request was aborted");
  assert.deepEqual(logger.lines[0]?.fields, { errorName: "TimeoutError" });
  assert.equal(clock.pending, 0, "no timer is left behind");
});

function trickle(clock: FakeClock, gapsMs: readonly number[]): TeamsFileFetcher {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const gap of gapsMs) {
        await clock.sleep(gap);
        controller.enqueue(bytes("x"));
      }
      controller.close();
    },
  });
  return new TeamsFileFetcher({ fetch: () => Promise.resolve(new Response(body)), clock });
}

test("a slow download that keeps arriving is not cut off, a stalled one is", async () => {
  const clock = new FakeClock();
  const slow = trickle(clock, [FETCH_TIMEOUT_MS - 1, FETCH_TIMEOUT_MS - 1, FETCH_TIMEOUT_MS - 1]);
  const going = slow.fetchAll([sent("a.txt", "https://x.test/a")]);
  for (let i = 0; i < 3; i++) {
    await tick();
    await clock.advance(FETCH_TIMEOUT_MS - 1);
  }
  const done = await going;
  assert.deepEqual(done.failed, []);
  assert.deepEqual(done.fetched[0]?.bytes, bytes("xxx"));

  const stalled = trickle(clock, [1, FETCH_TIMEOUT_MS + 1]);
  const stuck = stalled.fetchAll([sent("b.txt", "https://x.test/b")]);
  await tick();
  await clock.advance(1);
  await tick();
  await clock.advance(FETCH_TIMEOUT_MS);
  assert.deepEqual((await stuck).failed, [{ name: "b.txt", reason: "the download failed" }]);
});

// test_log_hygiene.py: the inbound half of the 1:1 file test (the agent's upload half is W4's).
const TEMPAUTH = "v1." + "eyJzaXRlaWQiOiJhYmMiLCJhdWQiOiJ4In0" + ".Zm9vYmFyU2lnbmF0dXJlMTIz";
const USER_PATH = "personal/alice_contoso_com";
const DOWNLOAD_URL =
  `https://contoso-my.sharepoint.com/${USER_PATH}/_layouts/15/download.aspx` +
  `?UniqueId=1b2c3d&Translate=false&tempauth=${TEMPAUTH}&ApiVersion=2.0`;

test("a file sent in a 1to1 chat does not log its download link", async () => {
  const logger = new RecordingLogger();
  let answer: "ok" | "gone" | "broken" = "ok";
  const { files, seen } = fetcher(
    () => {
      if (answer === "broken") throw new TypeError("fetch failed");
      return answer === "ok"
        ? { body: bytes("%PDF-1.7"), headers: { "content-type": "application/pdf" } }
        : { status: 404 };
    },
    null,
    { logger },
  );
  const sentFiles = inboundFiles(dm("summarise this", [fileInfo("q3-salaries.pdf", DOWNLOAD_URL)])).files;
  const { fetched } = await files.fetchAll(sentFiles);
  assert.ok(seen[0]?.url.includes(TEMPAUTH), "the file was downloaded from its link");
  assert.deepEqual(
    fetched.map((f) => [f.name, f.mediaType]),
    [["q3-salaries.pdf", "application/pdf"]],
  );
  answer = "gone";
  await files.fetchAll(sentFiles);
  answer = "broken";
  await files.fetchAll(sentFiles);
  assert.equal(logger.lines.length, 2, "the failures were logged");
  const logged = logger.text();
  for (const marker of [TEMPAUTH, USER_PATH, "contoso-my.sharepoint.com", "q3-salaries"]) {
    assert.ok(!logged.includes(marker), `${marker} is not in the log`);
  }
});
