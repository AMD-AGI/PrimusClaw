// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A foreground `bash` must be answered before the request carrying it is cut.
 *
 * One foreground command is one HTTP request whose reply is written only when
 * the command ends, and the sandbox Router's port proxy gives up on response
 * headers at 120s with a 502 "sandbox service unreachable on port 9100". With
 * background shells on, the foreground ceiling and default were both 120s, so
 * a command allowed its full time met the proxy before its own timeout: the
 * agent lost the output and was told its sandbox was gone.
 *
 * The Hands behind the fake proxy is one started before the ceiling came down
 * (120s ceiling, 120s default), so Brain's own number has to be the one sent.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.BG_SHELL_ENABLED = "true";
delete process.env.BASH_MAX_TIMEOUT_SEC;
delete process.env.BASH_DEFAULT_TIMEOUT_SEC;

const { bindBgHandleRowsForTest } = await import("../src/sandbox/bg-row-store.js");
const { toolTimeoutCeilingSec } = await import("../src/tools/hands.js");
const { oldHandsBehindProxy, PROXY_HEADER_LIMIT_SEC, TRANSPORT_SEC } =
  await import("./fixtures/old-hands-behind-proxy.js");
type Seen = import("./fixtures/old-hands-behind-proxy.js").Seen;

const OLD_HANDS = { maxSec: 120, defaultSec: 120 };

test("the foreground ceiling with background shells on is under the proxy limit", () => {
  assert.equal(toolTimeoutCeilingSec("bash"), 100);
});

for (const [label, args, reduced] of [
  ["a command asked for 300s", { command: "python train.py", timeout: 300 }, true],
  ["a command asked for 120s", { command: "python train.py", timeout: 120 }, true],
  ["a command naming no timeout", { command: "python train.py" }, false],
] as const) {
  test(`${label} comes back as its own timeout with its output, not as an unreachable sandbox`, async () => {
    const restore = bindBgHandleRowsForTest(null);
    try {
      const seen: Seen[] = [];
      const out = await oldHandsBehindProxy(seen, OLD_HANDS).callToolFull("bash", { ...args });
      assert.match(out.text, /^timeout after 100s/);
      assert.match(out.text, /epoch 7 loss 0\.31/, "the output so far reaches the agent");
      assert.equal(out.isError, true);
      assert.equal(seen.length, 1);
      const sent = seen[0]!.args.timeout as number;
      assert.equal(sent, 100);
      assert.ok(sent + TRANSPORT_SEC < PROXY_HEADER_LIMIT_SEC);
      assert.ok(seen[0]!.deadlineMs >= sent * 1000, "Brain's own deadline is never the shorter one");
      // Hands only saw the number Brain sent, so saying it was reduced is Brain's job.
      if (reduced) {
        assert.match(out.text, new RegExp(`requested ${args.timeout}s was reduced to the 100s per-call limit`));
        assert.equal((out.structured as { clamped?: unknown }).clamped, true);
      } else {
        assert.doesNotMatch(out.text, /was reduced/);
      }
    } finally {
      restore();
    }
  });
}

test("a timeout inside the ceiling is sent as asked", async () => {
  const restore = bindBgHandleRowsForTest(null);
  try {
    const seen: Seen[] = [];
    const out = await oldHandsBehindProxy(seen, OLD_HANDS).callToolFull("bash", { command: "make", timeout: 30 });
    assert.equal(seen[0]!.args.timeout, 30);
    assert.doesNotMatch(out.text, /was reduced/);
  } finally {
    restore();
  }
});

test("a timeout Hands would refuse is passed through for Hands to refuse", async () => {
  const restore = bindBgHandleRowsForTest(null);
  try {
    const seen: Seen[] = [];
    await oldHandsBehindProxy(seen, OLD_HANDS).callToolFull("bash", { command: "ls", timeout: -5 }).catch(() => {});
    assert.equal(seen[0]!.args.timeout, -5);
  } finally {
    restore();
  }
});
