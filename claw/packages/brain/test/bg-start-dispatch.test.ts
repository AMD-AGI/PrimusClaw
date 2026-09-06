// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * B38 -- the send window is finished, not stranded, on the path a start
 * actually takes.
 *
 * `dispatched` is written durably before the request is handed to the
 * transport, which is what closes the spawn-then-crash window. That write can
 * itself be crash-interrupted: the row lands, the pod dies, and the request
 * never goes out. Deciding from the row alone answers that request unknown
 * forever and refuses to dispatch it, for work that in fact never ran.
 *
 * Driven through `HandsClient.callTool` with a transport that can be made to
 * die mid-handoff and a key-value store that survives it, because a hand-built
 * row proves nothing about whether the state machine is on the call path.
 */
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  HandsClient, bindShellRecordsCapabilityForTest, resetStartIdentityForTest,
} from "../src/clients/hands.js";
import { bindBgHandleRowsForTest } from "../src/sandbox/bg-row-store.js";
import { readRow, type BgRowState } from "../src/sandbox/bg-handle-rows.js";
import { bgRowStore } from "../src/sandbox/bg-row-store.js";
import { matchesKvFilter } from "./fixtures/kv-filter.js";

const OWNER = "sess-1";
const RUN = "ktsk_1";
const URL = "http://sandbox:9100/mcp";
const ADDRESS = { ownerScope: OWNER, runIdentity: RUN, shellId: "trainer" };

/** A revision-aware bucket stand-in that outlives the "pod" using it. */
function durableBucket() {
  const map = new Map<string, { value: Uint8Array; revision: number }>();
  const conflict = () => Object.assign(new Error("wrong last sequence"), { code: "10071" });
  return {
    async get(key: string) { return map.get(key) ?? null; },
    async create(key: string, value: Uint8Array) {
      if (map.has(key)) throw conflict();
      map.set(key, { value, revision: 1 });
    },
    async update(key: string, value: Uint8Array, expected: number) {
      const current = map.get(key);
      if (current?.revision !== expected) throw conflict();
      map.set(key, { value, revision: expected + 1 });
    },
    async delete(key: string) { map.delete(key); },
    async keys(filter: string) {
      const hits = [...map.keys()].filter((k) => matchesKvFilter(k, filter));
      return (async function* () { yield* hits; })();
    },
  };
}

let bucket: ReturnType<typeof durableBucket>;
let restoreRows: (() => void) | null = null;
let restoreCapability: (() => void) | null = null;
/** What the sandbox's record subtree says, as the probe route would report it. */
let recordAnswer: { marker: boolean; subtreeReadable: boolean; present: boolean };
const probed: string[] = [];

beforeEach(() => {
  bucket = durableBucket();
  restoreRows = bindBgHandleRowsForTest(bucket as never);
  restoreCapability = bindShellRecordsCapabilityForTest(async () => true);
  recordAnswer = { marker: true, subtreeReadable: true, present: false };
  probed.length = 0;
  resetStartIdentityForTest();
});

afterEach(() => {
  restoreRows?.();
  restoreCapability?.();
  restoreRows = null;
  restoreCapability = null;
});

/**
 * One Brain pod's client. `dieOnHandoff` is the crash this exists for: the row
 * has been written and the transport call throws before anything is sent.
 */
function pod(options: { dieOnHandoff?: boolean; slowHandoff?: boolean } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const hands = new HandsClient(URL, "tok", OWNER, RUN);
  (hands as unknown as { connected: boolean }).connected = true;
  (hands as unknown as { client: unknown }).client = {
    callTool: async ({ arguments: args }: { arguments: Record<string, unknown> }) => {
      if (options.dieOnHandoff) throw new Error("pod died before the request went out");
      // Holds every concurrent call inside the handoff together, so none has
      // confirmed by the time the others allocate.
      if (options.slowHandoff) await new Promise((r) => setTimeout(r, 20));
      sent.push(args);
      return { content: [{ type: "text", text: `Started background shell ${args.shell_id}.` }] };
    },
  };
  (hands as unknown as { probeShellRecord: unknown }).probeShellRecord = async (id: string) => {
    probed.push(id);
    if (recordAnswer.present) return { kind: "record_present" };
    if (recordAnswer.marker && recordAnswer.subtreeReadable) return { kind: "determinately_absent" };
    return { kind: "indeterminate" };
  };
  return { hands, sent };
}

const START = { command: "train.sh", run_in_background: true, shell_id: "trainer" };
const rowState = async (): Promise<BgRowState | undefined> =>
  (await readRow(bgRowStore()!, ADDRESS))?.state;

test("a first start writes issued then dispatched before anything is sent", async () => {
  const seen: Array<BgRowState | undefined> = [];
  const { hands, sent } = pod();
  (hands as unknown as { client: { callTool: unknown } }).client = {
    callTool: async ({ arguments: args }: { arguments: Record<string, unknown> }) => {
      // Read from inside the handoff: this is the only moment that can show
      // the row was durable *before* the request left, which is the whole
      // ordering the crash window depends on.
      seen.push(await rowState());
      sent.push(args);
      return { content: [{ type: "text", text: `Started background shell ${args.shell_id}.` }] };
    },
  };

  await hands.callTool("bash", START);

  assert.deepEqual(seen, ["dispatched"]);
  assert.equal(await rowState(), "spawn_confirmed", "and confirmed before the model is told");
  assert.equal(sent.length, 1);
});

test("a crash between the dispatched write and the handoff is retransmitted, not stranded", async () => {
  // The pod that dies leaves a `dispatched` row for a request that never went
  // out. Answering unknown here refuses this work forever.
  await assert.rejects(() => pod({ dieOnHandoff: true }).hands.callTool("bash", START));
  assert.equal(await rowState(), "dispatched");

  const resumed = pod();
  const text = await resumed.hands.callTool("bash", START);

  assert.equal(resumed.sent.length, 1, "the identical start is re-sent");
  assert.deepEqual(probed, ["trainer"], "on the positive finding that no claim landed");
  assert.match(text, /Started background shell trainer/);
  assert.equal(await rowState(), "spawn_confirmed");
});

test("a send that did land is resolved, never run a second time", async () => {
  await assert.rejects(() => pod({ dieOnHandoff: true }).hands.callTool("bash", START));
  // The request reached Hands after all, so its claim is on the record.
  recordAnswer = { marker: true, subtreeReadable: true, present: true };

  const resumed = pod();
  const text = await resumed.hands.callTool("bash", START);

  assert.equal(resumed.sent.length, 0, "nothing goes out");
  assert.match(text, /already started by this request/);
  assert.match(text, /nothing was run a second time/);
});

test("an unreadable subtree sends nothing and says so", async () => {
  await assert.rejects(() => pod({ dieOnHandoff: true }).hands.callTool("bash", START));
  recordAnswer = { marker: true, subtreeReadable: false, present: false };

  const resumed = pod();
  const text = await resumed.hands.callTool("bash", START);

  assert.equal(resumed.sent.length, 0);
  assert.match(text, /cannot be determined/);
  assert.match(text, /not started again/);
});

test("a confirmed start is never re-sent, even with the record gone", async () => {
  const first = pod();
  await first.hands.callTool("bash", START);
  assert.equal(await rowState(), "spawn_confirmed");

  // The sandbox lost the record. The row attests a shell, so this is record
  // loss and not a claim that never landed.
  recordAnswer = { marker: true, subtreeReadable: true, present: false };
  const replay = pod();
  const text = await replay.hands.callTool("bash", START);

  assert.equal(replay.sent.length, 0);
  assert.match(text, /lost/);
});

test("a start under a replaced sandbox is answered from the row, not dispatched", async () => {
  const first = pod();
  await first.hands.callTool("bash", START);

  // A different sandbox: the generation this dispatch was issued against is
  // gone, so the command that ran cannot be asked about and must not be re-run.
  const rebuilt = new HandsClient("http://sandbox-2:9100/mcp", "tok", OWNER, RUN);
  (rebuilt as unknown as { connected: boolean }).connected = true;
  let sent = 0;
  (rebuilt as unknown as { client: unknown }).client = {
    callTool: async () => { sent += 1; return { content: [] }; },
  };

  const text = await rebuilt.callTool("bash", START);
  assert.equal(sent, 0);
  assert.match(text, /lost/);
});

const NO_ID_START = { command: "train.sh", run_in_background: true };

test("a start naming no id recovers its own id on the replay, not a fresh one", async () => {
  // The common start names nothing. An id minted fresh per call means the
  // replay looks for a row keyed by an id nothing wrote, finds none, and
  // dispatches the command a second time -- the duplicate execution the row
  // exists to prevent, on the path most starts take. The id is derived from
  // what a resumed run reproduces exactly, so the replay finds its own row.
  const first = pod({ dieOnHandoff: true });
  await assert.rejects(() => first.hands.callTool("bash", NO_ID_START));

  const rows = await bgRowStore()!.keys("bgshell.*.*.*");
  assert.equal(rows.length, 1, "a row was keyed before anything was sent");
  const row = JSON.parse((await bgRowStore()!.read(rows[0]))!.value) as { state: string; shellId: string };
  assert.equal(row.state, "dispatched");

  // The resumed run, as a crash before the turn's checkpoint really leaves it:
  // the model is re-queried and free to hand back a different tool-use
  // identifier, so nothing about the provider's id may enter the derivation.
  recordAnswer = { marker: true, subtreeReadable: true, present: false };
  resetStartIdentityForTest();
  const resumed = pod();
  await resumed.hands.callTool("bash", NO_ID_START);

  assert.equal(resumed.sent.length, 1, "retransmitted, because no claim had landed");
  assert.equal(resumed.sent[0].shell_id, row.shellId,
    "and under the id the crashed dispatch already wrote a row for");
  assert.deepEqual(await bgRowStore()!.keys("bgshell.*.*.*"), rows,
    "one row, not a second one keyed by a freshly minted id");
});

test("a no-id start whose send did land is resolved, never run twice", async () => {
  const first = pod({ dieOnHandoff: true });
  await assert.rejects(() => first.hands.callTool("bash", NO_ID_START));
  recordAnswer = { marker: true, subtreeReadable: true, present: true };
  resetStartIdentityForTest();

  const resumed = pod();
  const text = await resumed.hands.callTool("bash", NO_ID_START);

  assert.equal(resumed.sent.length, 0);
  assert.match(text, /nothing was run a second time/);
});

test("two different commands in one run get different ids", async () => {
  const { hands, sent } = pod();
  await hands.callTool("bash", { command: "train.sh", run_in_background: true });
  await hands.callTool("bash", { command: "monitor.sh", run_in_background: true });

  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].shell_id, sent[1].shell_id);
});

test("two deliberate starts of the identical command are two shells", async () => {
  // The guarantee is per intent, not per command text: a second start of the
  // same command is a second intent and must produce a second process. A row
  // already confirmed is a start that finished, so the next call takes the next
  // sequence rather than adopting it.
  const { hands, sent } = pod();
  const first = await hands.callTool("bash", NO_ID_START);
  const second = await hands.callTool("bash", NO_ID_START);

  assert.equal(sent.length, 2, "both go out");
  assert.notEqual(sent[0].shell_id, sent[1].shell_id, "and each gets its own shell");
  assert.match(first, /Started background shell/);
  assert.match(second, /Started background shell/);

  const rows = await bgRowStore()!.keys("bgshell.*.*.*");
  assert.equal(rows.length, 2, "two intents, two rows");
});

test("concurrent identical starts never collapse, with no confirmation ordering", async () => {
  // Both scan before either has written a row, so neither can see the other's
  // and a scan-then-write would hand them one id. The exclusive create is what
  // settles it: two calls cannot both win one sequence.
  const { hands, sent } = pod({ slowHandoff: true });
  const [a, b, c] = await Promise.all([
    hands.callTool("bash", NO_ID_START),
    hands.callTool("bash", NO_ID_START),
    hands.callTool("bash", NO_ID_START),
  ]);

  assert.equal(sent.length, 3, "three intents, three starts");
  const ids = sent.map((s) => s.shell_id);
  assert.equal(new Set(ids).size, 3, `collapsed to ${JSON.stringify(ids)}`);
  for (const text of [a, b, c]) assert.match(text, /Started background shell/);
  assert.equal((await bgRowStore()!.keys("bgshell.*.*.*")).length, 3);
});

test("confirmation arriving out of order across several starts keeps them apart", async () => {
  // The rows are confirmed in an order nothing controls, and a later start must
  // still take a sequence of its own rather than adopting whichever row happens
  // to be unconfirmed at the moment it looks.
  const { hands, sent } = pod();
  await hands.callTool("bash", NO_ID_START);
  await hands.callTool("bash", NO_ID_START);

  // The second start's row is confirmed first; the first is still `dispatched`.
  const keys = await bgRowStore()!.keys("bgshell.*.*.*");
  const first = JSON.parse((await bgRowStore()!.read(keys[0]))!.value) as { shellId: string };
  await bgRowStore()!.write(
    keys[0],
    JSON.stringify({
      ownerScope: OWNER, runIdentity: RUN, shellId: first.shellId,
      generation: URL, state: "dispatched",
      commandDigest: JSON.parse((await bgRowStore()!.read(keys[0]))!.value).commandDigest,
      sequence: 1,
    }),
    (await bgRowStore()!.read(keys[0]))!.revision,
  );

  await hands.callTool("bash", NO_ID_START);
  assert.equal(sent.length, 3);
  assert.equal(new Set(sent.map((s) => s.shell_id)).size, 3,
    "a start of this process never adopts a row this process claimed");
});

test("a replay adopts the unresolved start rather than allocating a new one", async () => {
  // What separates the two: an unconfirmed row is a call that was sent and
  // never came back, which is exactly what a replay is repeating.
  const first = pod({ dieOnHandoff: true });
  await assert.rejects(() => first.hands.callTool("bash", NO_ID_START));
  const [key] = await bgRowStore()!.keys("bgshell.*.*.*");
  const stranded = JSON.parse((await bgRowStore()!.read(key))!.value) as
    { shellId: string; sequence: number; commandDigest: string };
  assert.equal(stranded.sequence, 1);
  assert.ok(stranded.commandDigest, "the row carries what a replay recognises it by");

  recordAnswer = { marker: true, subtreeReadable: true, present: false };
  // A different process resuming the run: it made no claim of its own, so the
  // unresolved row is its predecessor's unfinished call.
  resetStartIdentityForTest();
  const resumed = pod();
  await resumed.hands.callTool("bash", NO_ID_START);

  assert.equal(resumed.sent[0].shell_id, stranded.shellId, "the same start, finished");
  assert.equal((await bgRowStore()!.keys("bgshell.*.*.*")).length, 1, "and no second intent");
});

test("a script-mode replay that is safely deduplicated is not a step failure", async () => {
  // The step's work is done and its shell exists. Reported as an error, an
  // `on_fail` policy fires on a replay that behaved exactly as intended, and
  // the script stops or retries work that already succeeded.
  await assert.rejects(() => pod({ dieOnHandoff: true }).hands.callToolFull("bash", START));
  assert.equal(await rowState(), "dispatched");

  recordAnswer = { marker: true, subtreeReadable: true, present: true };
  resetStartIdentityForTest();
  const resumed = pod();
  const result = await resumed.hands.callToolFull("bash", START);

  assert.equal(resumed.sent.length, 0, "nothing goes out");
  assert.equal(result.isError, false, "a start that was already made is a success");
  assert.match(result.text, /nothing was run a second time/);
  assert.deepEqual(
    (result.structured as { shell_id: string; resolution: string }),
    { shell_id: "trainer", resolution: "deduplicated" },
    "and the step can read which it was without matching prose",
  );
});

test("a script-mode replay that cannot be resolved is a step failure", async () => {
  // The other half: nothing says whether the command ran, so carrying on as
  // though it had is exactly what `on_fail` is for.
  await assert.rejects(() => pod({ dieOnHandoff: true }).hands.callToolFull("bash", START));
  recordAnswer = { marker: true, subtreeReadable: false, present: false };

  const result = await pod().hands.callToolFull("bash", START);
  assert.equal(result.isError, true);
  assert.match(result.text, /cannot be determined/);
});

test("a script-mode start that is a genuine first call goes out and is confirmed", async () => {
  const { hands, sent } = pod();
  const result = await hands.callToolFull("bash", START);
  assert.equal(sent.length, 1);
  assert.equal(result.isError, false);
  assert.equal(await rowState(), "spawn_confirmed");
});

test("a record-less sandbox never receives a replayed start, however its registry looks", async () => {
  // Both shapes the old registry takes, driven through the client rather than
  // the resolver: the shell reaped out of its map, and the whole map gone with
  // a restart. Neither can arbitrate a duplicate name, so neither may be sent a
  // start it might already be running.
  const filesNoRecords = bindShellRecordsCapabilityForTest(async () => false);
  try {
    for (const [why, answer] of [
      ["the shell was reaped out of the map", { marker: false, subtreeReadable: false, present: false }],
      ["Hands restarted and lost the map", { marker: false, subtreeReadable: false, present: false }],
    ] as const) {
      bucket = durableBucket();
      restoreRows?.();
      restoreRows = bindBgHandleRowsForTest(bucket as never);
      recordAnswer = answer;

      await assert.rejects(() => pod({ dieOnHandoff: true }).hands.callTool("bash", START), why);
      assert.equal(await rowState(), "dispatched", why);

      const resumed = pod();
      const text = await resumed.hands.callTool("bash", START);
      assert.equal(resumed.sent.length, 0, why);
      assert.match(text, /cannot be determined/, why);
    }
  } finally {
    filesNoRecords();
  }
});
