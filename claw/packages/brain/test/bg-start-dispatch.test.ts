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

import { HandsClient, bindShellRecordsCapabilityForTest } from "../src/clients/hands.js";
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
function pod(options: { dieOnHandoff?: boolean } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const hands = new HandsClient(URL, "tok", OWNER, RUN);
  (hands as unknown as { connected: boolean }).connected = true;
  (hands as unknown as { client: unknown }).client = {
    callTool: async ({ arguments: args }: { arguments: Record<string, unknown> }) => {
      if (options.dieOnHandoff) throw new Error("pod died before the request went out");
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
const STEP = { stepIdentity: "toolu_abc123" };

test("a start naming no id recovers its own id on the replay, not a fresh one", async () => {
  // The common start names nothing. An id minted fresh per call means the
  // replay looks for a row keyed by an id nothing wrote, finds none, and
  // dispatches the command a second time -- the duplicate execution the row
  // exists to prevent, on the path most starts take. The id is derived from
  // what a resumed run reproduces exactly, so the replay finds its own row.
  const first = pod({ dieOnHandoff: true });
  await assert.rejects(() => first.hands.callTool("bash", NO_ID_START, undefined, STEP));

  const rows = await bgRowStore()!.keys("bgshell.*.*.*");
  assert.equal(rows.length, 1, "a row was keyed before anything was sent");
  const row = JSON.parse((await bgRowStore()!.read(rows[0]))!.value) as { state: string; shellId: string };
  assert.equal(row.state, "dispatched");

  // The resumed run: same tool-use identifier, same arguments, no id of its own.
  recordAnswer = { marker: true, subtreeReadable: true, present: false };
  const resumed = pod();
  await resumed.hands.callTool("bash", NO_ID_START, undefined, STEP);

  assert.equal(resumed.sent.length, 1, "retransmitted, because no claim had landed");
  assert.equal(resumed.sent[0].shell_id, row.shellId,
    "and under the id the crashed dispatch already wrote a row for");
  assert.deepEqual(await bgRowStore()!.keys("bgshell.*.*.*"), rows,
    "one row, not a second one keyed by a freshly minted id");
});

test("a no-id start whose send did land is resolved, never run twice", async () => {
  const first = pod({ dieOnHandoff: true });
  await assert.rejects(() => first.hands.callTool("bash", NO_ID_START, undefined, STEP));
  recordAnswer = { marker: true, subtreeReadable: true, present: true };

  const resumed = pod();
  const text = await resumed.hands.callTool("bash", NO_ID_START, undefined, STEP);

  assert.equal(resumed.sent.length, 0);
  assert.match(text, /nothing was run a second time/);
});

test("two different call sites in one run get different ids", async () => {
  // Deriving from the replay-stable identity must not collapse two genuinely
  // different starts into one, which would refuse the second as a duplicate.
  const { hands, sent } = pod();
  await hands.callTool("bash", NO_ID_START, undefined, { stepIdentity: "toolu_one" });
  await hands.callTool("bash", NO_ID_START, undefined, { stepIdentity: "toolu_two" });

  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].shell_id, sent[1].shell_id);
});

test("a script-mode replay that is safely deduplicated is not a step failure", async () => {
  // The step's work is done and its shell exists. Reported as an error, an
  // `on_fail` policy fires on a replay that behaved exactly as intended, and
  // the script stops or retries work that already succeeded.
  await assert.rejects(() => pod({ dieOnHandoff: true }).hands.callToolFull("bash", START));
  assert.equal(await rowState(), "dispatched");

  recordAnswer = { marker: true, subtreeReadable: true, present: true };
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
