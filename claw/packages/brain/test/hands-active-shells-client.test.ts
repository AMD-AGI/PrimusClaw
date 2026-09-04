// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the keepalive sweep is allowed to conclude from a shell count.
 *
 * The sweep treats a zero as a confirmed absence of work and stops pinging;
 * anything thrown is `unknown` and keeps the sandbox. So every way the answer
 * can fail to arrive has to throw, including the ways that arrive with a 200:
 * an older Hands behind a proxy, a truncated body, a JSON error object. A `?? 0`
 * over any of those reports a sandbox as free on the strength of an answer
 * nobody gave, and the pod is reclaimed under a live shell.
 *
 * Driven against a real loopback server rather than a stub, because the client
 * imports undici's `fetch` directly -- swapping the global would test a code
 * path this function does not take.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { countActiveShells } from "../src/clients/hands.js";

const TOKEN = "test-token";

/** A Hands that replies however the test says. Returns its MCP-shaped url. */
async function handsReplying(
  reply: (req: { owner?: unknown }) => { status?: number; body?: string },
): Promise<{ url: string; server: Server; owners: unknown[] }> {
  const owners: unknown[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      let parsed: { owner?: unknown } = {};
      try { parsed = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* keep {} */ }
      owners.push(parsed.owner);
      const { status = 200, body = "" } = reply(parsed);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/mcp`, server, owners };
}

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

async function hands(reply: Parameters<typeof handsReplying>[0]) {
  const h = await handsReplying(reply);
  servers.push(h.server);
  return h;
}

test("a well-formed count is the answer, and the owner asked about travels with it", async () => {
  const h = await hands(() => ({ body: JSON.stringify({ running: 3 }) }));
  assert.equal(await countActiveShells(h.url, TOKEN, "sess-1"), 3);
  assert.deepEqual(h.owners, ["sess-1"], "the count must be about the session asked for");
});

test("a confirmed zero is reported as a zero, since that is what frees a sandbox", async () => {
  const h = await hands(() => ({ body: JSON.stringify({ running: 0 }) }));
  assert.equal(await countActiveShells(h.url, TOKEN, "sess-1"), 0);
});

test("a refusal is a failed probe, not an empty sandbox", async () => {
  const h = await hands(() => ({ status: 503, body: "{}" }));
  await assert.rejects(
    () => countActiveShells(h.url, TOKEN, "sess-1"),
    /hands_active_shells_failed: status=503/,
  );
});

test("a 200 that does not carry a count is a Hands that did not answer", async () => {
  // Each of these would have become a confident zero under `?? 0`, and each is
  // a plausible shape: no route, an error object, a truncated or empty body.
  const notAnAnswer = [
    "{}",
    JSON.stringify({ error: "unknown_route" }),
    JSON.stringify({ running: null }),
    JSON.stringify({ running: "2" }),
    "",
    "{\"running\":",
  ];
  for (const body of notAnAnswer) {
    const h = await hands(() => ({ body }));
    await assert.rejects(
      () => countActiveShells(h.url, TOKEN, "sess-1"),
      /hands_active_shells_failed: malformed body/,
      `body ${JSON.stringify(body)} must not be read as a confirmed absence of work`,
    );
  }
});

test("a count that is not a count is refused rather than clamped", async () => {
  // Clamping a negative to zero would turn nonsense into the one answer that
  // gets a sandbox reclaimed.
  for (const running of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const h = await hands(() => ({ body: `{"running": ${String(running)}}` }));
    await assert.rejects(
      () => countActiveShells(h.url, TOKEN, "sess-1"),
      /hands_active_shells_failed: malformed body/,
      `running=${String(running)} must not be read as a count`,
    );
  }
});

test("an empty owner is refused before anything is asked", async () => {
  // It names no bucket, so no count about it could be true -- and Hands would
  // refuse it anyway. Failing here keeps the three layers agreeing and spends
  // no request to learn it.
  const h = await hands(() => ({ body: JSON.stringify({ running: 0 }) }));
  await assert.rejects(
    () => countActiveShells(h.url, TOKEN, ""),
    /hands_active_shells_failed: empty owner/,
  );
  assert.deepEqual(h.owners, [], "no request should have been sent");
});
