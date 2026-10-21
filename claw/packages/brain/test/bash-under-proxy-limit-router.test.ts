// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * With background shells off the foreground ceiling is the long one, because
 * long work has nowhere else to go. Through the sandbox Router's port proxy it
 * has nowhere to go either way: the proxy cuts any request whose reply has not
 * started within 120s, so a command granted ten hours failed at two minutes as
 * an unreachable sandbox, lost its output, and ran on with nothing able to
 * reach it. There the ceiling is the short one, and Brain sends it to a Hands
 * started with the long one.
 *
 * Its own file because the flags are read at module load.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.BG_SHELL_ENABLED = "false";
process.env.SANDBOX_HANDS_VIA_ROUTER = "true";
process.env.SANDBOX_ROUTER_URL = "http://router.example:8080";
delete process.env.BASH_MAX_TIMEOUT_SEC;
delete process.env.BASH_DEFAULT_TIMEOUT_SEC;

const { bindBgHandleRowsForTest } = await import("../src/sandbox/bg-row-store.js");
const { toolTimeoutCeilingSec } = await import("../src/tools/hands.js");
const { handsBaseEnv } = await import("../src/sandbox/bootstrap.js");
const { oldHandsBehindProxy, PROXY_HEADER_LIMIT_SEC, TRANSPORT_SEC } =
  await import("./fixtures/old-hands-behind-proxy.js");
type Seen = import("./fixtures/old-hands-behind-proxy.js").Seen;

/** A Hands started with background shells off: the ten-hour ceiling. */
const OLD_HANDS = { maxSec: 36_000, defaultSec: 120 };

test("through the Router the foreground ceiling is under its proxy limit, and travels to new sandboxes", () => {
  assert.equal(toolTimeoutCeilingSec("bash"), 100);
  const env = handsBaseEnv("sess-1", "9100");
  assert.match(env, /\bBASH_MAX_TIMEOUT_SEC=100\b/);
  assert.match(env, /\bBASH_DEFAULT_TIMEOUT_SEC=100\b/);
});

for (const [label, args] of [
  ["a command asked for 3000s", { command: "make -j8", timeout: 3000 }],
  ["a command naming no timeout", { command: "make -j8" }],
] as const) {
  test(`${label} comes back as its own timeout, not as an unreachable sandbox`, async () => {
    const restore = bindBgHandleRowsForTest(null);
    try {
      const seen: Seen[] = [];
      const out = await oldHandsBehindProxy(seen, OLD_HANDS).callToolFull("bash", { ...args });
      assert.match(out.text, /^timeout after 100s/);
      assert.match(out.text, /epoch 7 loss 0\.31/);
      const sent = seen[0]!.args.timeout as number;
      assert.equal(sent, 100);
      assert.ok(sent + TRANSPORT_SEC < PROXY_HEADER_LIMIT_SEC);
    } finally {
      restore();
    }
  });
}
