// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The credential as it arrives through the sandbox Router's port proxy.
 *
 * That proxy strips `Authorization`, so a Brain in another cluster presents
 * its credential in X-Hands-Token instead. Both headers must keep proving the
 * same thing: a scoped credential in the new header opens the scoped routes,
 * the internal token in it opens /mcp, the old header alone still works, and a
 * wrong value in the new header is refused even when the old one is right --
 * one header must never rescue the other.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mintScopeCredential } from "@claw/utils";

process.env.WORKSPACE_PATH = tmpdir();
process.env.BG_SHELL_ENABLED = "true";
process.env.AUTH_CLAW_TOKEN = "test-internal-token";
if (!process.argv.includes("--self-check")) process.argv.push("--self-check");

const { app } = await import("../src/index.js");
const { shutdownAllShells } = await import("../src/tools/shell/bg-manager.js");
const { isolatingSandbox } = await import("./support/sandbox-isolation.js");
isolatingSandbox();

const TOKEN = "test-internal-token";
const scoped = mintScopeCredential({ owner: "sess-hdr", run: null }, TOKEN);

function active(headers: Record<string, string>) {
  return app.inject({ method: "POST", url: "/internal/shells/active", headers, payload: {} });
}

const MCP_INIT = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};

function mcp(headers: Record<string, string>) {
  return app.inject({
    method: "POST",
    url: "/mcp",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers },
    payload: MCP_INIT,
  });
}

test.after(async () => {
  await shutdownAllShells(200);
  await app.close();
});

test("a scoped credential in X-Hands-Token alone is accepted", async () => {
  const res = await active({ "x-hands-token": scoped });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { running: 0 });
});

test("Authorization alone is still accepted", async () => {
  const res = await active({ authorization: `Bearer ${scoped}` });
  assert.equal(res.statusCode, 200);
});

test("a wrong X-Hands-Token is refused even beside a right Authorization", async () => {
  const res = await active({ "x-hands-token": "wrong", authorization: `Bearer ${scoped}` });
  assert.equal(res.statusCode, 401);
});

test("no credential at all is refused", async () => {
  const res = await active({});
  assert.equal(res.statusCode, 401);
});

test("/mcp takes the internal token from X-Hands-Token", async () => {
  const ok = await mcp({ "x-hands-token": TOKEN });
  assert.notEqual(ok.statusCode, 401, ok.body);
  assert.equal(ok.statusCode, 200, ok.body);
  const bad = await mcp({ "x-hands-token": "wrong" });
  assert.equal(bad.statusCode, 401);
  const none = await mcp({});
  assert.equal(none.statusCode, 401);
});
