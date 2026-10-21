// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A wait whose request is cut must not consume the output it was carrying.
 *
 * `wait` reads a background shell's new output through the ordinary poll, which
 * advances the read offset. When the request carrying the wait has already been
 * cut -- a proxy's response-header timeout, Brain's own deadline -- that answer
 * is written to nobody, and the bytes it read were gone: the next wait or
 * bash_output began after them. The fixture is a transport that aborts every
 * request at a fixed limit, shorter than the wait it carries, in front of the
 * real /mcp route.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";

process.env.WORKSPACE_PATH = tmpdir();
process.env.BG_SHELL_ENABLED = "true";
process.env.AUTH_CLAW_TOKEN = "test-internal-token";
// Long enough that the transport below cuts the wait before it ends on its own.
process.env.WAIT_MAX_SEC = "3";
if (!process.argv.includes("--self-check")) process.argv.push("--self-check");

const { app } = await import("../src/index.js");
const { spawnBackground, shutdownAllShells } = await import("../src/tools/shell/bg-manager.js");
const { isolatingSandbox } = await import("./support/sandbox-isolation.js");
isolatingSandbox();

const TOKEN = "test-internal-token";
const OWNER = "owner-cut";
const RUN = "run-cut";
/** The fake proxy's limit: every request it carries is aborted at this age. */
const TRANSPORT_LIMIT_MS = 1_000;

await app.listen({ host: "127.0.0.1", port: 0 });
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

test.after(async () => {
  await shutdownAllShells(200);
  await app.close();
});

let nextId = 1;
async function callTool(
  name: string,
  args: Record<string, unknown>,
  limitMs?: number,
): Promise<{ text: string; isError: boolean }> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "x-hands-token": TOKEN,
      "x-claw-owner": OWNER,
      "x-claw-run": RUN,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
    signal: limitMs === undefined ? undefined : AbortSignal.timeout(limitMs),
  });
  const body = await res.json() as { result?: { content: { text: string }[]; isError?: boolean }; error?: unknown };
  assert.ok(body.result, `tools/call ${name} failed: ${JSON.stringify(body)}`);
  return { text: body.result.content.map((c) => c.text).join("\n"), isError: !!body.result.isError };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("output read during a cut wait is still delivered to the next call", async () => {
  spawnBackground(OWNER, RUN, "echo first-chunk-7f3a; sleep 30", "cut-shell");
  await sleep(300); // the echo has landed in the shell's buffer

  await assert.rejects(
    callTool("wait", { shell_id: "cut-shell", timeout_sec: 3 }, TRANSPORT_LIMIT_MS),
    (e: Error) => e.name === "TimeoutError" || e.name === "AbortError",
    "the transport cuts the wait before it ends",
  );
  // Past the moment the wait would have ended on its own, so it has had every
  // chance to read the output into the reply nobody received.
  await sleep(3_000);

  const next = await callTool("bash_output", { shell_id: "cut-shell" });
  assert.equal(next.isError, false, next.text);
  assert.match(next.text, /first-chunk-7f3a/,
    "the bytes the cut wait would have carried are what the next call sees");
});

test("a wait inside the transport's limit answers normally with the output", async () => {
  spawnBackground(OWNER, RUN, "echo second-chunk-9b1c; sleep 30", "ok-shell");
  await sleep(300);

  // A wait asked for more than the ceiling is clamped to it, comes back in time
  // with the shell still running, and carries what the shell printed.
  const r = await callTool("wait", { shell_id: "ok-shell", timeout_sec: 60 }, 5_000);
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /still running/);
  assert.match(r.text, /second-chunk-9b1c/);
});
