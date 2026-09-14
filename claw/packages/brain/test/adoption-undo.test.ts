// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Undoing an adoption that could not be recorded.
 *
 * When a DAG adopts a warm sandbox, `acceptExistingSandbox` clears the idle
 * markers and starts a keepalive ticker before the handle is registered. If
 * that registration fails the turn must fail -- an unrecorded sandbox is one
 * Backend's teardown cannot find, and a cancel then reports the DAG holds
 * nothing and stops nothing. But failing alone leaves the adoption half-done:
 * the runner has not been handed the identity yet, so nothing downstream
 * unwinds either half, `reapPendingHands` skips the READY entry, and the
 * sandbox stays active, owned by a session whose turn just failed and claimed
 * by no DAG.
 *
 * Two things about this undo have already been wrong, which is why it is
 * tested rather than reasoned about:
 *
 *   - It addressed `identity.sessionId`. For agent-sandbox that is the
 *     ROUTER's session id, while keepalive registrations and the
 *     `hands.<session>` key are both keyed by Claw's -- so both halves went to
 *     a session that does not exist, and the undo reported success.
 *   - It wrapped `markHandsIdle` in a try/catch. That function REPORTS failure
 *     instead of throwing (`superseded` on a revision conflict, `failed`
 *     otherwise), and a conflict is the ordinary case here because the entry is
 *     live and its TTL is being refreshed underneath. So the catch established
 *     nothing, and an undo that silently did not happen left the local
 *     registration gone while KV still said active -- the next tick finds the
 *     workload again from KV and pings a sandbox no turn owns.
 *
 * Coverage:
 *   A1 the undo addresses the Claw session, not the Router's
 *   A2 it stops the ticker before restoring the idle marker
 *   A3 only an incomplete park is reported as incomplete (real log output)
 *   A4 the sandbox is not stopped -- this path did not create it
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const { bindSandboxReuseEffects, registerReusedDagHandle } =
  await import("../src/sandbox/ensure-hands.js");
const { bindDagHandleKvForTest } = await import("../src/sandbox/handles.js");

let restore: Array<() => void> = [];
afterEach(() => { restore.forEach((f) => f()); restore = []; });

const CLAW_SESSION = "claw-sess-1";
const ROUTER_SESSION = "router-sess-9";

/** Records what the undo did, and fails the registration that triggers it. */
function stubUndo(parkOutcome: "parked" | "superseded" | "failed") {
  const seen: string[] = [];
  const unregistered: string[] = [];
  const parked: string[] = [];
  const stopped: string[] = [];
  restore.push(bindSandboxReuseEffects({
    unregisterSandbox: ((sessionId: string) => {
      seen.push("unregister"); unregistered.push(sessionId);
    }) as never,
    markHandsIdle: (async (_kv: unknown, sessionId: string) => {
      seen.push("park"); parked.push(sessionId);
      return { outcome: parkOutcome };
    }) as never,
    destroyHands: (async (sessionId: string) => { stopped.push(sessionId); }) as never,
  }));
  // Every write refused, so the registration inside the adoption fails.
  restore.push(bindDagHandleKvForTest({
    async get() { return null; },
    async create() { throw new Error("nats: no responders"); },
    async update() { throw new Error("nats: no responders"); },
    async put() { throw new Error("nats: no responders"); },
    async delete() {},
    async keys() { return (async function* () {})(); },
  } as never));
  return { seen, unregistered, parked, stopped };
}

/** Drive the adoption path with a reuse that succeeds and a handle declared. */
async function adopt(parkOutcome: "parked" | "superseded" | "failed") {
  const probe = stubUndo(parkOutcome);
  const err = await registerReusedDagHandle(
    {} as never,
    { session_id: CLAW_SESSION, task_id: "t-1", dag_root_task_id: "dag-1" } as never,
    { kind: "create", handle: "main" },
    {
      handsUrl: "http://hands", created: false, token: "tok",
      identity: {
        provider: "agent-sandbox", sessionId: ROUTER_SESSION,
        sandboxName: "sb-1", namespace: "ns",
      },
    } as never,
  ).then(() => null, (e: unknown) => e as Error);
  return { ...probe, err };
}

test("A1 the undo addresses the Claw session, not the Router's", async () => {
  const { unregistered, parked, err } = await adopt("parked");

  assert.ok(err, "a registration that cannot be written still fails the turn");
  assert.deepEqual(
    unregistered, [CLAW_SESSION],
    "keepalive registrations are keyed by the Claw session; the Router's id unwinds nothing",
  );
  assert.deepEqual(
    parked, [CLAW_SESSION],
    "and `hands.<session>` is keyed the same way",
  );
});

test("A2 it stops the ticker before restoring the idle marker", async () => {
  const { seen } = await adopt("parked");

  assert.deepEqual(
    seen, ["unregister", "park"],
    "reversed, the entry is briefly active with nobody pinging it",
  );
});

test("A3 only an incomplete park is reported as incomplete", async () => {
  // Asserted on the log the process really writes, in a subprocess, because
  // the previous version of this test matched the source for the condition
  // text -- which passes with the log line deleted, or the condition body
  // emptied, and so proved nothing about the behaviour it is named for.
  //
  // The distinction matters in both directions. `markHandsIdle` REPORTS
  // failure rather than throwing, and a revision conflict is the ordinary case
  // here because the entry is live and its TTL is being refreshed underneath.
  // Treat `superseded` as success and the local registration is gone while KV
  // still says active, so the next tick finds the workload again and pings a
  // sandbox no turn owns. Treat `gone` as failure and every adoption of an
  // already-reaped entry pages somebody over nothing.
  const { stdout } = await run(process.execPath, [
    fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url)),
    fileURLToPath(new URL("./fixtures/adoption-undo-outcomes.ts", import.meta.url)),
  ], { timeout: 60_000 });

  const incomplete = stdout.split("\n")
    .filter((l) => l.includes("reused_handle_undo_incomplete"));

  assert.equal(
    incomplete.length, 2,
    `exactly the two outcomes that did not park should report. stdout:\n${stdout}`,
  );
  assert.ok(
    incomplete.some((l) => /"outcome":"superseded"/.test(l)),
    "a revision conflict left the undo unfinished and has to say so",
  );
  assert.ok(
    incomplete.some((l) => /"outcome":"failed"/.test(l)),
    "and so does an outright failure",
  );
  assert.equal(
    incomplete.some((l) => /"outcome":"(parked|gone)"/.test(l)), false,
    "while a park that landed, or an entry already gone, is a complete undo",
  );
  assert.ok(
    incomplete.every((l) => l.includes(CLAW_SESSION)),
    "reported against the Claw session, which is the one the undo addressed",
  );
});

test("A4 the sandbox is not stopped -- this path did not create it", async () => {
  const { stopped } = await adopt("parked");

  assert.deepEqual(
    stopped, [],
    "another session's warm pod is not this turn's to destroy on the way out",
  );
});
