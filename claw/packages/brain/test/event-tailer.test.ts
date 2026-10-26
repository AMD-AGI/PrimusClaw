// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Event forwarding (hosting design 5.7), against real segment files read by a
 * real `sh`, the way EnvD would run the tailer's commands.
 *
 * The four behaviours the design depends on each have their own case: a
 * half-written last line, the roll-over to the next segment, the cursor
 * surviving a restart of the Brain, and de-duplication. The writer in these
 * tests appends the way the application does (whole lines ending in a newline,
 * a crash leaving bytes without one) and knows nothing of any particular app.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppRunner } from "../src/apps/app-runner.js";
import {
  EVENTS_PER_ROUND, EVENTS_READ_BYTES, EVENT_MAX_BYTES, checkEnvelope, createEventTailer, scanLines, tailOnce,
  type AppEventMessage, type EventTailerDeps,
} from "../src/apps/event-tailer.js";
import type { AppEventsCursor, AppRunRecord } from "../src/apps/app-run-store.js";
import type { AppRunContext } from "../src/apps/app-runner.js";
import { eventForwardingSeams } from "../src/apps/app-runner-wiring.js";
import { World, MANIFEST, RUN_ID } from "./support/app-runner-world.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const seg = (n: number): string => `${String(n).padStart(10, "0")}.jsonl`;
const ev = (id: number | string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ specversion: "1.0", id: String(id), source: "app/run", type: "x.y", data: { n: id }, ...extra });

/** A sandbox directory, a run row that holds the cursor, and a stream that records what was published. */
function rig(opts: { failPublishAt?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "c2-09-"));
  dirs.push(root);
  const stateDir = `${root}/state`;
  const eventsDir = `${stateDir}/events`;
  mkdirSync(eventsDir, { recursive: true });
  const world = new World(MANIFEST, { state_dir: stateDir });
  const published: AppEventMessage[] = [];
  let publishCalls = 0;
  const deps: EventTailerDeps = {
    exec: (_inst, command) => new Promise((resolve) => {
      execFile("sh", ["-c", command], { env: { PATH: process.env.PATH ?? "" }, timeout: 20_000, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
        resolve({ exitCode: code, stdout, stderr });
      });
    }),
    store: world.store,
    publish: async (_sid, message) => {
      publishCalls += 1;
      if (opts.failPublishAt === publishCalls) throw new Error("nats down");
      published.push(message);
    },
  };
  const ctx = (): AppRunContext => ({ record: world.rec as AppRunRecord, instance: { id: "wl-1" } as never });
  const ids = (): string[] => published.map((m) => String((m.event as { id: string }).id));
  const file = (n: number): string => `${eventsDir}/${seg(n)}`;
  return { world, deps, ctx, published, ids, file, eventsDir, calls: () => publishCalls };
}
type Rig = ReturnType<typeof rig>;

const tail = (r: Rig) => createEventTailer(r.deps).tailEvents!(r.ctx());
const drain = (r: Rig) => createEventTailer(r.deps).drainEvents!(r.ctx());

test("forwards each complete event once, in order, as appEvent for the run", async () => {
  const r = rig();
  writeFileSync(r.file(1), `${ev(1)}\n${ev(2)}\n${ev(3)}\n`);
  await tail(r);
  assert.deepEqual(r.ids(), ["1", "2", "3"]);
  assert.equal(r.published[0]!.type, "appEvent");
  assert.equal(r.published[0]!.app_task_id, RUN_ID);
  assert.deepEqual(r.published[0]!.event, JSON.parse(ev(1)));
  await tail(r);
  assert.deepEqual(r.ids(), ["1", "2", "3"], "a second round with nothing new publishes nothing");
});

// ---------------------------------------------------------------------------
// half-written last line
// ---------------------------------------------------------------------------

test("a half-written last line is not an event, and is read whole once it is finished", async () => {
  const r = rig();
  const second = ev(2);
  writeFileSync(r.file(1), `${ev(1)}\n${second.slice(0, 20)}`);
  await tail(r);
  assert.deepEqual(r.ids(), ["1"], "the unfinished line is held back");
  const held = r.world.rec.events_cursor;
  assert.equal(held.offset, Buffer.byteLength(`${ev(1)}\n`), "the cursor stops before the unfinished bytes");

  await tail(r);
  assert.deepEqual(r.ids(), ["1"], "still unfinished, still held back, not published twice");

  appendFileSync(r.file(1), `${second.slice(20)}\n`);
  await tail(r);
  assert.deepEqual(r.ids(), ["1", "2"], "finished, it is one intact event");
});

test("multi-byte content: the cursor counts bytes, not characters", async () => {
  const r = rig();
  const wide = ev(1, { data: { text: "é漢字🙂".repeat(50) } });
  writeFileSync(r.file(1), `${wide}\n${ev(2)}\n`);
  await tail(r);
  assert.deepEqual(r.ids(), ["1", "2"]);
  assert.equal(r.world.rec.events_cursor.offset, Buffer.byteLength(`${wide}\n${ev(2)}\n`));
});

// ---------------------------------------------------------------------------
// segment roll-over
// ---------------------------------------------------------------------------

test("rolls over to the next segment only once the old one is finished, and loses nothing at the seam", async () => {
  const r = rig();
  writeFileSync(r.file(1), `${ev(1)}\n${ev(2)}\n`);
  await tail(r);
  assert.equal(r.world.rec.events_cursor.segment, seg(1), "no newer segment: stay on the current one");

  // The writer appends to segment 1 and rolls over in the same breath.
  appendFileSync(r.file(1), `${ev(3)}\n`);
  writeFileSync(r.file(2), `${ev(4)}\n${ev(5)}\n`);
  await tail(r);
  assert.deepEqual(r.ids(), ["1", "2", "3"], "the tail of the old segment is read before leaving it");
  assert.equal(r.world.rec.events_cursor.segment, seg(2));
  assert.equal(r.world.rec.events_cursor.offset, 0);

  await tail(r);
  assert.deepEqual(r.ids(), ["1", "2", "3", "4", "5"]);
  assert.equal(r.world.rec.events_cursor.segment, seg(2));
});

test("skips over a segment that is gone to the next one that exists", async () => {
  const r = rig();
  writeFileSync(r.file(1), `${ev(1)}\n`);
  await tail(r);
  rmSync(r.file(1));
  writeFileSync(r.file(3), `${ev(2)}\n`);
  await tail(r);
  assert.deepEqual(r.ids(), ["1", "2"]);
  assert.equal(r.world.rec.events_cursor.segment, seg(3));
});

test("an unfinished tail in a segment the writer has left is dropped, not waited on for ever", async () => {
  const r = rig();
  writeFileSync(r.file(1), `${ev(1)}\n${ev(2).slice(0, 15)}`);
  writeFileSync(r.file(2), `${ev(3)}\n`);
  await tail(r);
  await tail(r);
  assert.deepEqual(r.ids(), ["1", "3"]);
});

// ---------------------------------------------------------------------------
// cursor and resume
// ---------------------------------------------------------------------------

test("the cursor is on the row, so a new tailer (another Brain, or a restart) carries on without repeating", async () => {
  const r = rig();
  writeFileSync(r.file(1), `${ev(1)}\n${ev(2)}\n`);
  await tail(r);
  assert.deepEqual(r.world.rec.events_cursor, { segment: seg(1), offset: Buffer.byteLength(`${ev(1)}\n${ev(2)}\n`), last_id: "2" });

  appendFileSync(r.file(1), `${ev(1)}\n`); // a repeat of an old line, as after a restart that lost nothing but the memory
  appendFileSync(r.file(1), `${ev(3)}\n`);
  // A new tailer has no memory: all it has is the row the first one wrote.
  await createEventTailer(r.deps).tailEvents!(r.ctx());
  assert.deepEqual(r.ids(), ["1", "2", "3"], "only the new event is published after the resume");
});

test("a failed publish keeps what was published, and the next round resumes at the one that failed", async () => {
  const r = rig({ failPublishAt: 3 });
  writeFileSync(r.file(1), `${ev(1)}\n${ev(2)}\n${ev(3)}\n${ev(4)}\n`);
  await assert.rejects(tail(r), /nats down/);
  assert.deepEqual(r.ids(), ["1", "2"]);
  assert.equal(r.world.rec.events_cursor.last_id, "2", "the cursor moved over the two that went out");
  await tail(r);
  assert.deepEqual(r.ids(), ["1", "2", "3", "4"]);
});

test("a cursor write that fails after the publish means a repeat on the next round, never a loss", async () => {
  const r = rig();
  writeFileSync(r.file(1), `${ev(1)}\n`);
  r.world.failStore = (patch) => (patch.events_cursor ? new Error("api down") : null);
  await assert.rejects(tail(r), /api down/);
  assert.deepEqual(r.ids(), ["1"]);
  assert.deepEqual(r.world.rec.events_cursor, {}, "the row still says nothing was read");
  r.world.failStore = null;
  await tail(r);
  assert.deepEqual(r.ids(), ["1", "1"], "at least once: the consumer drops the repeat by (app_task_id, id)");
});

// ---------------------------------------------------------------------------
// de-duplication and the envelope
// ---------------------------------------------------------------------------

test("an id at or below the last forwarded one is skipped, whether repeated or out of order", async () => {
  const r = rig();
  writeFileSync(r.file(1), `${ev(1)}\n${ev(2)}\n${ev(2)}\n${ev(1)}\n${ev(10)}\n${ev(9)}\n${ev(11)}\n`);
  await tail(r);
  assert.deepEqual(r.ids(), ["1", "2", "10", "11"]);
});

test("ids compare as numbers, not as text: 9 then 10 is increasing", async () => {
  const r = rig();
  writeFileSync(r.file(1), `${ev(9)}\n${ev(10)}\n${ev("100")}\n`);
  await tail(r);
  assert.deepEqual(r.ids(), ["9", "10", "100"]);
});

test("last_id survives a roll-over, so a repeat from the old segment is still dropped", async () => {
  const r = rig();
  writeFileSync(r.file(1), `${ev(1)}\n`);
  writeFileSync(r.file(2), `${ev(1)}\n${ev(2)}\n`);
  await tail(r);
  await tail(r);
  assert.deepEqual(r.ids(), ["1", "2"]);
});

test("lines that are not CloudEvents are skipped and the cursor still moves past them", async () => {
  const r = rig();
  const bad = [
    "not json",
    "[1,2]",
    JSON.stringify({ specversion: "1.0", id: "2", type: "t" }),
    JSON.stringify({ specversion: "0.3", id: "3", source: "s", type: "t" }),
    JSON.stringify({ specversion: "1.0", id: "abc", source: "s", type: "t" }),
    JSON.stringify({ specversion: "1.0", id: 7, source: "s", type: "t" }),
    "",
    ev(4, { data: { pad: "x".repeat(EVENT_MAX_BYTES) } }),
  ];
  writeFileSync(r.file(1), `${ev(1)}\n${bad.join("\n")}\n${ev(5)}\n`);
  await tail(r);
  assert.deepEqual(r.ids(), ["1", "5"]);
  assert.equal(r.world.rec.events_cursor.offset, Buffer.byteLength(`${ev(1)}\n${bad.join("\n")}\n${ev(5)}\n`));
});

test("checkEnvelope names what is missing", () => {
  const ok = { specversion: "1.0", id: "1", source: "s", type: "t" };
  assert.deepEqual(checkEnvelope(ok), { ok: true, id: 1n });
  for (const key of ["specversion", "id", "source", "type"]) {
    const { [key]: _gone, ...rest } = ok as Record<string, string>;
    assert.deepEqual(checkEnvelope(rest), { ok: false, reason: `missing_${key}` });
  }
});

// ---------------------------------------------------------------------------
// bounds, drain, absence
// ---------------------------------------------------------------------------

test("a round reads at most 500 events; the rest come on the next rounds", async () => {
  const r = rig();
  const total = EVENTS_PER_ROUND + 120;
  writeFileSync(r.file(1), Array.from({ length: total }, (_, i) => ev(i + 1)).join("\n") + "\n");
  await tail(r);
  assert.equal(r.published.length, EVENTS_PER_ROUND);
  await tail(r);
  assert.equal(r.published.length, total);
  assert.deepEqual(r.ids().slice(-1), [String(total)]);
});

test("a round reads at most 1 MiB, and a line cut by the window is read whole next round", async () => {
  const r = rig();
  const pad = "p".repeat(10_000);
  const lines = Array.from({ length: 130 }, (_, i) => ev(i + 1, { data: { pad } }));
  const text = lines.join("\n") + "\n";
  assert.ok(Buffer.byteLength(text) > EVENTS_READ_BYTES);
  writeFileSync(r.file(1), text);
  await tail(r);
  assert.ok(r.published.length > 0 && r.published.length < 130, `first round took ${r.published.length}`);
  await tail(r);
  assert.deepEqual(r.ids(), lines.map((_, i) => String(i + 1)));
});

test("drain reads everything that is left, across segments and rounds", async () => {
  const r = rig();
  writeFileSync(r.file(1), Array.from({ length: 700 }, (_, i) => ev(i + 1)).join("\n") + "\n");
  writeFileSync(r.file(2), `${ev(701)}\n${ev(702)}\n`);
  await drain(r);
  assert.equal(r.published.length, 702);
  assert.equal(r.world.rec.events_cursor.last_id, "702");
});

test("no events directory, an empty one, or no events declared: nothing is published and nothing throws", async () => {
  const r = rig();
  await tail(r);
  rmSync(r.eventsDir, { recursive: true });
  await tail(r);
  const none: AppRunContext = { record: { ...r.world.rec, manifest: { ...MANIFEST, events: undefined } } as AppRunRecord, instance: { id: "x" } as never };
  await createEventTailer(r.deps).tailEvents!(none);
  assert.equal(r.published.length, 0);
});

test("scanLines splits on newlines and reports where each line ends", () => {
  const s = scanLines(Buffer.from("a\nbb\nccc"), 10);
  assert.deepEqual(s.lines.map((l) => [l.text.toString(), l.end]), [["a", 2], ["bb", 5]]);
  assert.equal(s.rest, 3);
});

// ---------------------------------------------------------------------------
// in the runner
// ---------------------------------------------------------------------------

test("what the application wrote is scrubbed of the run's secret values before it is forwarded", async () => {
  const r = rig();
  writeFileSync(r.file(1), `${ev(1, { data: { note: "token is SECRET-VALUE-123 ok" } })}\n`);
  const ctx = { ...r.ctx(), scrub: (t: string) => t.split("SECRET-VALUE-123").join("[redacted]") };
  await createEventTailer(r.deps).tailEvents!(ctx);
  assert.doesNotMatch(JSON.stringify(r.published), /SECRET-VALUE-123/);
  assert.match(JSON.stringify(r.published[0]), /token is \[redacted\] ok/);
});

test("state changes of the run go out as appStatus, to the run's session", async () => {
  const world = new World(MANIFEST);
  const out: Array<{ sessionId: string; msg: Record<string, unknown> }> = [];
  const publish = async (sessionId: string, msg: Record<string, unknown>) => { out.push({ sessionId, msg }); };
  const seams = eventForwardingSeams(world.store, world.sandbox, publish);
  const runner = new AppRunner(RUN_ID, "pk", { store: world.store, sandbox: world.sandbox, seams, now: world.now, sleep: world.sleep, tickMs: 5000 });
  for (let i = 0; i < 12 && world.rec.state !== "running"; i++) await runner.reconcile();
  assert.equal(world.rec.state, "running");
  const states = out.filter((o) => o.msg.type === "appStatus").map((o) => o.msg.state);
  assert.ok(states.includes("starting") && states.includes("running"), `appStatus states: ${states.join(",")}`);
  assert.ok(out.every((o) => o.sessionId === "sess-1"));
  const status = out.find((o) => o.msg.type === "appStatus")!.msg;
  assert.deepEqual(Object.keys(status).sort(), ["app_task_id", "last_exit", "restarts", "state", "type"]);
});

test("tailOnce answers where the cursor ended and whether it moved", async () => {
  const r = rig();
  writeFileSync(r.file(1), `${ev(1)}\n`);
  const first = await tailOnce(r.deps, r.ctx(), {} as AppEventsCursor);
  assert.equal(first.progressed, true);
  const again = await tailOnce(r.deps, r.ctx(), first.cursor);
  assert.equal(again.progressed, false);
  assert.equal(r.calls(), 1);
});
