// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A2A_CLIENT_ENABLED is off unless an operator turns it on, and off means off: the tool is not
 * offered, and a call that arrives anyway (a resumed transcript that already holds one) is refused
 * before a peer is looked up. This file does not import the env module the other a2a tests do.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { A2A_CLIENT_ENABLED } from "../src/config.js";
import { initA2ARegistry } from "../src/clients/a2a.js";
import { ToolRouter } from "../src/tools/router.js";

test("the switch is off by default", () => {
  assert.equal(A2A_CLIENT_ENABLED, false);
});

test("the tool is not offered while it is off, to the model or to a sub-agent", () => {
  const router = new ToolRouter(null);
  assert.ok(!router.getToolSchemas().some((t) => t.name === "a2a_call"));
});

test("a call that arrives anyway is refused, recorded as a failure, and reaches no peer", async () => {
  let reached = 0;
  const server = http.createServer((_q, res) => { reached++; res.end("{}"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as AddressInfo).port;
    initA2ARegistry(JSON.stringify([{ name: "p", url: `http://127.0.0.1:${port}`, allow_local: true }]));
    const outcome = { isError: false };
    const out = await new ToolRouter(null).route("a2a_call", { agent: "p", message: "hi" }, undefined, outcome);
    assert.match(out, /a2a_call is disabled in this deployment/);
    assert.equal(outcome.isError, true);
    assert.equal(reached, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    initA2ARegistry("");
  }
});
