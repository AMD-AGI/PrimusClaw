// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A foreground command has to answer inside the request that carries it, and
 * must not outlive that request when it is cut.
 *
 * One foreground `bash` is one HTTP request to /mcp, and its reply -- headers
 * included -- is written only when the command ends. A proxy in front of Hands
 * may give up on a request that has sent nothing for 120s: the sandbox Router's
 * port proxy answers 502 "sandbox service unreachable on port 9100" at exactly
 * that age. With background shells on the ceiling used to be 120s, so a command
 * allowed its full ceiling met the proxy before its own timeout, and the agent
 * was told its sandbox was unreachable instead of getting the output so far.
 *
 * When the request is cut the command used to keep running until its own
 * timeout, with no shell id anywhere: nothing could read it, wait on it or kill
 * it, and the agent -- told the call failed -- would usually start it again
 * beside it. The fixture is a client that aborts the request at a fixed limit,
 * shorter than the command it carries, in front of the real /mcp route.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const WORKSPACE = mkdtempSync(join(tmpdir(), "fg-cut-"));
// The command may run under the sandbox's unprivileged child identity.
chmodSync(WORKSPACE, 0o777);
process.env.WORKSPACE_PATH = WORKSPACE;
process.env.BG_SHELL_ENABLED = "true";
process.env.AUTH_CLAW_TOKEN = "test-internal-token";
// The code's own defaults are what the first test is about.
delete process.env.BASH_MAX_TIMEOUT_SEC;
delete process.env.BASH_DEFAULT_TIMEOUT_SEC;
if (!process.argv.includes("--self-check")) process.argv.push("--self-check");

const { app } = await import("../src/index.js");
const { MAX_TIMEOUT_SEC, bash } = await import("../src/tools/shell/bash.js");
const { shutdownAllShells } = await import("../src/tools/shell/bg-manager.js");
const { isolatingSandbox } = await import("./support/sandbox-isolation.js");
isolatingSandbox();

const TOKEN = "test-internal-token";
/** The Router port proxy's response-header timeout. */
const PROXY_HEADER_LIMIT_SEC = 120;
/** Room for the request, the process-group kill grace and the reply. */
const TRANSPORT_SEC = 15;
/** The fake proxy's limit in the HTTP tests: every request is cut at this age. */
const TRANSPORT_LIMIT_MS = 1_000;

await app.listen({ host: "127.0.0.1", port: 0 });
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

test.after(async () => {
  await shutdownAllShells(200);
  await app.close();
});

let nextId = 1;
async function callBash(
  args: Record<string, unknown>,
  limitMs: number,
): Promise<{ text: string; isError: boolean }> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "x-hands-token": TOKEN,
      "x-claw-owner": "owner-fg",
      "x-claw-run": "run-fg",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name: "bash", arguments: args } }),
    signal: AbortSignal.timeout(limitMs),
  });
  const body = await res.json() as { result?: { content: { text: string }[]; isError?: boolean }; error?: unknown };
  assert.ok(body.result, `tools/call bash failed: ${JSON.stringify(body)}`);
  return { text: body.result.content.map((c) => c.text).join("\n"), isError: !!body.result.isError };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return false;
  }
}

test("with background shells on, a foreground command at its ceiling answers before a 120s proxy cuts it", () => {
  assert.equal(MAX_TIMEOUT_SEC, 100);
  assert.ok(MAX_TIMEOUT_SEC + TRANSPORT_SEC < PROXY_HEADER_LIMIT_SEC,
    `ceiling ${MAX_TIMEOUT_SEC}s plus ${TRANSPORT_SEC}s of transport reaches the proxy limit`);
  // The default is what a call naming no timeout gets, and must fit too.
  assert.match(bash.zodSchema.timeout.description!, /default 100s?\b/);
});

test("a foreground command whose request is cut is stopped, not left running unowned", async () => {
  const pidFile = join(WORKSPACE, "cut.pid");
  const marker = join(WORKSPACE, "cut.after");

  await assert.rejects(
    callBash({ command: `echo $$ > ${pidFile}; sleep 4; touch ${marker}`, timeout: 10 }, TRANSPORT_LIMIT_MS),
    (e: Error) => e.name === "TimeoutError" || e.name === "AbortError",
    "the transport cuts the request before the command ends",
  );
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(pid > 0);

  // Past the moment the command would have finished on its own.
  await sleep(5_000);
  assert.equal(existsSync(marker), false,
    "the command went on to its next step after nobody could receive its answer");
  assert.equal(alive(pid), false, `the command's shell (pid ${pid}) is still running`);
});

test("a foreground command inside the transport's limit answers normally", async () => {
  const r = await callBash({ command: "echo inside-limit-5d2e", timeout: 10 }, 5_000);
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /inside-limit-5d2e/);
});
