// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A failing task may only destroy the pending workload it minted itself.
 *
 * `hands.<sid>` is keyed per SESSION and its PENDING form names no task, so
 * `status === "pending"` says "some run of this session left a workload
 * mid-creation" and nothing more. The abort-time reap used to act on exactly
 * that much, which is fine for the common case -- a run whose own ensureHands
 * died -- and destructive for the one beside it: under BRAIN_LAZY_SANDBOX an
 * ordinary chat turn opens no sandbox unless a tool asks for one, so an LLM
 * error ends it with `ensureHands` never called, and the blind reap then
 * stopped whichever workload an EARLIER message of the same session was still
 * provisioning. The predecessor's run went on to read its own sandbox as
 * preempted.
 *
 * The threshold that separates them is the runner's `sandboxAskedAt`, stamped
 * immediately before each `ensureHands` call, against the `createdAt` that
 * `onProvisioned` writes from inside that same call. These tests assert on the
 * destruction itself -- which workload was stopped, and whether the record of
 * it survived -- rather than on a return value the reap does not have.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec, type KV } from "nats";
import { handsSessionKey } from "@claw/protocol";

import { reapPendingHands } from "../src/sandbox/reaper.js";
import { bindHandsKv } from "../src/sandbox/registry.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import { retentionKey } from "../src/sandbox/retain-container.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";

const sc = StringCodec();

const PREDECESSOR_TASK = "task-predecessor";
const OWN_TASK = "task-own";
const SESSION = "sess-reap-ownership";
const KEY = handsSessionKey(SESSION);

/** Minted by an earlier message of this session, still queueing. */
const PREDECESSOR = "wl-predecessor";
/** Minted by the run under test, inside its own ensureHands. */
const OWN = "wl-this-run";

let restoreProviders: (() => void) | null = null;
afterEach(() => { restoreProviders?.(); restoreProviders = null; });

function pendingEntry(workloadId: string, createdAtMs: number, taskId = PREDECESSOR_TASK) {
  return {
    status: "pending",
    taskId,
    provider: "safe-workload",
    workloadId,
    platformKey: "pk",
    namespace: "ns",
    token: `tok-${workloadId}`,
    // The default gate shape: pickLockKey() under RUN_GATE_KEY=workspace is
    // `ws.<workspaceId>`, one lock shared by every run in the workspace. A
    // fixture using a session-granular scope would be testing a configuration
    // this deployment does not run.
    runScope: "ws.workspace-1",
    createdAt: new Date(createdAtMs).toISOString(),
  };
}

/** The bucket, plus what the reap actually removed from it. */
function bindKv(
  seed: Record<string, unknown>,
  /** Keys whose read throws, the shape a dropped lease-read request presents. */
  throwOn: Set<string> = new Set(),
) {
  const values = new Map<string, string>(
    Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]),
  );
  const deleted: string[] = [];
  const kv = {
    async get(key: string) {
      if (throwOn.has(key)) throw new Error("kv unavailable");
      const raw = values.get(key);
      return raw === undefined
        ? null
        : { key, value: sc.encode(raw), revision: 7, operation: "PUT" };
    },
    async put() { return 1; },
    async update() { return 8; },
    async delete(key: string) { deleted.push(key); values.delete(key); },
  } as unknown as KV;
  bindHandsKv(kv);
  return { values, deleted };
}

/** Every workload a stop was actually issued against. */
function recordStops(): string[] {
  const stopped: string[] = [];
  const provider = {
    kind: "safe-workload",
    async stop(inst: { id: string }) { stopped.push(inst.id); },
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
  } as unknown as SandboxProvider;
  restoreProviders = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  return stopped;
}

test("a run that never asked for a sandbox destroys no predecessor's workload", async () => {
  // The reproduced defect: ensureHands called zero times, so sandboxAskedAt is
  // null, and the entry in the bucket belongs to the message before this one.
  const { values, deleted } = bindKv({ [KEY]: pendingEntry(PREDECESSOR, Date.now() - 600_000) });
  const stopped = recordStops();

  await reapPendingHands(SESSION, { taskId: OWN_TASK });

  assert.deepEqual(stopped, [],
    `a task that provisioned nothing stopped ${JSON.stringify(stopped)} -- the workload `
    + "the previous message is still waiting on");
  assert.deepEqual(deleted, [],
    "and deleted the entry that was the only record of its workloadId + platformKey");
  assert.ok(values.has(KEY), "the predecessor's binding must survive this run's failure");
});

test("nor does one whose provision was refused before it wrote an entry", async () => {
  // The other half of the same shape: this run DID call ensureHands, but the
  // create was refused before `onProvisioned` ran, so the only entry it can
  // find is still the predecessor's -- older than its own ask.
  const askedAt = Date.now();
  const { values, deleted } = bindKv({ [KEY]: pendingEntry(PREDECESSOR, askedAt - 60_000) });
  const stopped = recordStops();

  await reapPendingHands(SESSION, { taskId: OWN_TASK });

  assert.deepEqual(stopped, [],
    `stopped ${JSON.stringify(stopped)}: an entry stamped before this run asked was `
    + "written by something else");
  assert.deepEqual(deleted, []);
  assert.ok(values.has(KEY));
});

test("but a run that left its own pending entry behind still reaps it", async () => {
  // The coverage the blind reap provided, and the common case: this must keep
  // working, or every failed provision leaks its workload for 24h.
  const askedAt = Date.now() - 5_000;
  const { values, deleted } = bindKv({ [KEY]: pendingEntry(OWN, askedAt + 1_000, OWN_TASK) });
  const stopped = recordStops();

  await reapPendingHands(SESSION, { taskId: OWN_TASK });

  assert.deepEqual(stopped, [OWN], "this run's own orphan workload must still be stopped");
  assert.deepEqual(deleted, [KEY], "and its entry removed, so nothing re-adopts it");
  assert.equal(values.has(KEY), false);
});

test("a READY entry is still left alone for the next message to reuse", async () => {
  const askedAt = Date.now() - 5_000;
  const ready = { ...pendingEntry(OWN, askedAt + 1_000, OWN_TASK), status: "ready", handsUrl: "http://h:9100/mcp" };
  const { values, deleted } = bindKv({ [KEY]: ready });
  const stopped = recordStops();

  await reapPendingHands(SESSION, { taskId: OWN_TASK });

  assert.deepEqual(stopped, [], "a healthy sandbox is kept across an agent-loop failure");
  assert.deepEqual(deleted, []);
  assert.ok(values.has(KEY));
});

test("and a retained container is never what a session's reap stops", async () => {
  // A retention projection is a byte copy of the binding it was made from, so
  // it carries the same status and the same token and passes every filter a
  // status test applies. It is keyed by a sandbox generation rather than by a
  // session, which is why the session walk should not reach it at all -- the
  // guard is here because the cost of being wrong is the live work the
  // retention exists to protect.
  const generation = "http://retained:9100/mcp";
  const retained = {
    ...pendingEntry("wl-retained", Date.now() - 600_000),
    handsUrl: generation,
    protected: true,
    reason: "protected",
    detail: "live_work_present",
  };
  // Addressed as though the generation key were this "session"'s own binding:
  // the shortest path from a walk to a wrong session id.
  const key = retentionKey(generation);
  const sessionId = key.slice("hands.".length);
  const { values, deleted } = bindKv({ [key]: retained });
  const stopped = recordStops();

  await reapPendingHands(sessionId, { taskId: OWN_TASK });

  assert.deepEqual(stopped, [],
    "the retained container was stopped with its work still running inside it");
  assert.deepEqual(deleted, []);
  assert.ok(values.has(key));
});

test("an entry with no task, stamped before this run asked, is left alone", async () => {
  // The rolling-upgrade shape: 94b63ef on this branch wrote `runScope` and not
  // yet `taskId`, so the task-id comparison cannot judge this entry at all.
  // What decides is that it was stamped before this run asked for anything --
  // it was written by something else, and stopping it is the mis-kill this
  // branch exists to prevent.
  //
  // Not decided by the run lease, deliberately. Under the default
  // RUN_GATE_KEY=workspace the scope is `ws.<workspaceId>`, held by any run in
  // the workspace, so a lease read would answer about a stranger's traffic --
  // handles.ts and keepalive.ts both refuse that same inference in as many
  // words.
  const askedAt = Date.now();
  const { values, deleted } = bindKv({
    [KEY]: { ...pendingEntry(PREDECESSOR, askedAt - 60_000), taskId: undefined },
    // A workspace-mate is busy. It says nothing either way, and must not.
    ["lock.ws.workspace-1"]: { holderId: "an-unrelated-session" },
  });
  const stopped = recordStops();

  await reapPendingHands(SESSION, { taskId: OWN_TASK, ownedSinceMs: askedAt });

  assert.deepEqual(stopped, [],
    `stopped ${JSON.stringify(stopped)} -- an entry older than this run's own ask was written `
    + "by something else");
  assert.deepEqual(deleted, []);
  assert.ok(values.has(KEY));
});

test("a run that asked for nothing at all reaps nothing", async () => {
  // A lazy chat turn answered from context calls ensureHands zero times, so it
  // has minted nothing and nothing in the bucket can be its own. This is the
  // reproduced defect the branch was opened for: with a blind reap it destroyed
  // the workload a previous message was still provisioning.
  const { values, deleted } = bindKv({
    [KEY]: { ...pendingEntry(PREDECESSOR, Date.now() - 600_000), taskId: undefined },
  });
  const stopped = recordStops();

  await reapPendingHands(SESSION, { taskId: OWN_TASK, ownedSinceMs: null });

  assert.deepEqual(stopped, []);
  assert.deepEqual(deleted, []);
  assert.ok(values.has(KEY));
});

test("but an unnamed entry this run itself minted is still reaped", async () => {
  // The coverage a blind reap provided and the common case: a provision this
  // run started and abandoned must still be torn down, or every failed create
  // leaks its workload.
  const askedAt = Date.now() - 5_000;
  const { values, deleted } = bindKv({
    [KEY]: { ...pendingEntry(OWN, askedAt + 1_000), taskId: undefined },
  });
  const stopped = recordStops();

  await reapPendingHands(SESSION, { taskId: OWN_TASK, ownedSinceMs: askedAt });

  assert.deepEqual(stopped, [OWN], "stamped after this run's own ask");
  assert.deepEqual(deleted, [KEY]);
  assert.equal(values.has(KEY), false);
});
