// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A `wait` must come back before the request carrying it is cut.
 *
 * A wait is answered by one HTTP request whose reply is written only when the
 * wait ends. A proxy in front of Hands may cut a request that has sent nothing
 * for 120s -- the sandbox Router's port proxy answers 502 "sandbox service
 * unreachable on port 9100" -- so a `wait {timeout_sec: 180}` failed at exactly
 * 120s and the agent, told its sandbox was gone, tore down a job that was
 * running fine. The same happened to a wait naming no timeout on a Hands whose
 * default was 300s.
 *
 * The transport here is a fake that does what that proxy does: it holds the
 * request for as long as the Hands it reaches would wait, and cuts it at the
 * limit. The Hands behind it is one started before the ceiling came down, with
 * the half-hour ceiling and five-minute default it was handed then, because a
 * reused sandbox keeps the Hands it was started with -- so Brain's own ceiling
 * has to be the one that applies.
 */
import test from "node:test";
import assert from "node:assert/strict";

delete process.env.WAIT_MAX_SEC;
delete process.env.WAIT_DEFAULT_SEC;

const { HandsClient } = await import("../src/clients/hands.js");
const { bindBgHandleRowsForTest } = await import("../src/sandbox/bg-row-store.js");

const PROXY_HEADER_LIMIT_SEC = 120;
/** What an older sandbox's Hands clamps a wait to, and waits when told nothing. */
const OLD_HANDS_WAIT_MAX_SEC = 1800;
const OLD_HANDS_WAIT_DEFAULT_SEC = 300;
/** Time the call spends outside the wait itself. */
const TRANSPORT_SEC = 2;

interface Seen { args: Record<string, unknown>; deadlineMs: number }

function handsBehindProxy(seen: Seen[]) {
  const hands = new HandsClient("http://sandbox:9100/mcp", "tok", "sess-1", "ktsk_1");
  const raw = hands as unknown as { connected: boolean; recordsCapability: boolean; client: unknown };
  raw.connected = true;
  raw.recordsCapability = true;
  raw.client = {
    callTool: async (req: { arguments: Record<string, unknown> }, _schema: unknown, opts: { timeout: number }) => {
      seen.push({ args: req.arguments, deadlineMs: opts.timeout });
      const asked = req.arguments.timeout_sec;
      const held = Math.min(
        typeof asked === "number" ? asked : OLD_HANDS_WAIT_DEFAULT_SEC,
        OLD_HANDS_WAIT_MAX_SEC,
      ) + TRANSPORT_SEC;
      if (held >= PROXY_HEADER_LIMIT_SEC) {
        throw new Error("Streamable HTTP error: Error POSTing to endpoint: sandbox service unreachable on port 9100");
      }
      return {
        content: [{ type: "text", text: `Shell bg-1 is still running after ${held - TRANSPORT_SEC}s. Call wait again to keep waiting.\n\nNew stdout:\nstep 42` }],
        isError: false,
      };
    },
  };
  return hands;
}

for (const [label, args] of [
  ["a wait asked for 180s", { shell_id: "bg-1", timeout_sec: 180 }],
  ["a wait asked for 120s", { shell_id: "bg-1", timeout_sec: 120 }],
  ["a wait naming no timeout", { shell_id: "bg-1" }],
] as const) {
  test(`${label} comes back as 'still running' with its output, not as an unreachable sandbox`, async () => {
    const restore = bindBgHandleRowsForTest(null);
    try {
      const seen: Seen[] = [];
      const text = await handsBehindProxy(seen).callTool("wait", { ...args });
      assert.match(text, /still running/);
      assert.match(text, /step 42/, "the shell's new output reaches the agent");
      assert.equal(seen.length, 1);
      const sent = seen[0]!.args.timeout_sec as number;
      assert.ok(sent + TRANSPORT_SEC < PROXY_HEADER_LIMIT_SEC, `sent timeout_sec=${sent}`);
      assert.ok(seen[0]!.deadlineMs >= sent * 1000,
        "Brain's own deadline is never the shorter of the two");
    } finally {
      restore();
    }
  });
}

test("a timeout Hands would refuse is passed through for Hands to refuse", async () => {
  const restore = bindBgHandleRowsForTest(null);
  try {
    const seen: Seen[] = [];
    await handsBehindProxy(seen).callTool("wait", { shell_id: "bg-1", timeout_sec: -5 }).catch(() => {});
    assert.equal(seen[0]!.args.timeout_sec, -5);
  } finally {
    restore();
  }
});
