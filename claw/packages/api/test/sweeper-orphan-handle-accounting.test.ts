// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the orphan-handle sweep reports when it stops early.
 *
 * `reapOrphanHandles` is the one sweep whose action is irreversible -- it
 * decides a DAG is over and destroys the sandbox behind it -- so when the
 * advisory lock's connection drops mid-traversal the loop breaks at the top of
 * an iteration and hands the rest to the next leader. The log line it breaks on
 * is the only record that anything was handed over, and its whole job is to say
 * how much.
 *
 * It said it with `all.length - dropped`, and `dropped` counts teardowns rather
 * than iterations. Almost every handle belongs to a DAG that is still running
 * and is torn down by nobody, so on a normal fleet `dropped` is zero for the
 * length of the scan and the line reports the entire bucket as outstanding
 * however far the traversal actually got. A pass that walked ninety of a hundred
 * handles and lost the lock reported a hundred left to do -- which reads as a
 * sweep that achieved nothing, and hides the ten that genuinely were abandoned
 * behind a number ten times too large.
 *
 * Driven rather than grepped, because the defect is arithmetic in a log field
 * and the field is the only place it is observable. The census is taken through
 * `sweeperPorts.handleMap`, and the database underneath is stubbed so every DAG
 * reads as still running and nothing is torn down -- which is both the ordinary
 * state of the bucket and the state the defect hides in.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { db } from "../src/infra/db.js";
import { reapOrphanHandles, sweeperPorts } from "../src/tasks/sweeper.js";

const originalQuery = db.query;
const originalHandleMap = sweeperPorts.handleMap;
after(() => {
  db.query = originalQuery;
  sweeperPorts.handleMap = originalHandleMap;
});

/** A census of `count` DAGs, one handle each. */
function seedHandles(count: number): void {
  const all = Array.from({ length: count }, (_, i) => [
    `dag-acct-${i}`,
    { main: { workload_id: `w-${i}` } },
  ]);
  sweeperPorts.handleMap = (() => ({
    listAll: async () => all,
  })) as unknown as typeof sweeperPorts.handleMap;
}

/**
 * Answer every DAG status probe with a running root, and record who was asked.
 *
 * A non-terminal status is the ordinary case and the one the defect hides in:
 * it takes the teardown branch out of play entirely, so `dropped` stays 0 for
 * the whole traversal and `all.length - dropped` never moves.
 */
function stubDbRunning(): string[] {
  const asked: string[] = [];
  db.query = (async (text: string, params?: unknown[]) => {
    if (/dag_node_id = '__dag_root__'/.test(text)) {
      asked.push(String((params ?? [])[0]));
      return { rows: [{ status: "running" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  return asked;
}

/**
 * Read back what the sweeper's own logger emitted while `run` ran.
 *
 * The logger is a module-private pino instance writing to fd 1, so there is no
 * object to swap. The sink underneath it can be borrowed: pino hands the
 * serialized line to `fs.write`, so taking that for the duration leaves the real
 * `logger.error` -- real serializers, real JSON -- on the path and reads the
 * exact bytes the process was about to emit. Swallowed rather than forwarded, so
 * the captured lines do not also land in the test output.
 */
async function captureLogLines(run: () => Promise<unknown>, waitFor: string): Promise<string[]> {
  const lines: string[] = [];
  const realWrite = fs.write as unknown as (...args: unknown[]) => unknown;
  const realWriteSync = fs.writeSync as unknown as (...args: unknown[]) => unknown;
  const take = (chunk: unknown) => {
    for (const line of String(chunk).split("\n")) if (line) lines.push(line);
  };
  fs.write = ((fd: number, chunk: unknown, ...rest: unknown[]) => {
    if (fd !== 1) return realWrite(fd, chunk, ...rest);
    take(chunk);
    // Reporting the full length matters: a short count reads as a partial write
    // and the sink reissues the rest, forever.
    const done = rest[rest.length - 1];
    if (typeof done === "function") done(null, Buffer.byteLength(String(chunk)), chunk);
    return undefined;
  }) as unknown as typeof fs.write;
  fs.writeSync = ((fd: number, chunk: unknown, ...rest: unknown[]) => {
    if (fd !== 1) return realWriteSync(fd, chunk, ...rest);
    take(chunk);
    return Buffer.byteLength(String(chunk));
  }) as unknown as typeof fs.writeSync;
  try {
    await run();
    const wanted = `"msg":${JSON.stringify(waitFor)}`;
    for (let i = 0; i < 500 && !lines.some((line) => line.includes(wanted)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  } finally {
    fs.write = realWrite as unknown as typeof fs.write;
    fs.writeSync = realWriteSync as unknown as typeof fs.writeSync;
  }
  return lines;
}

const STOPPED = "sweeper.orphan_handles_stopped (the lock connection dropped, so this traversal "
  + "was no longer exclusive and the rest of it is left to the next leader)";

/** A lease that holds until `afterProbes` DAGs have been judged, then reports the drop. */
function leaseLostAfter(asked: string[], afterProbes: number) {
  const dropped = new Error("Connection terminated unexpectedly");
  return { lost: () => (asked.length >= afterProbes ? dropped : undefined) };
}

test("the count handed to the next leader is what was not walked", async () => {
  const TOTAL = 8;
  const WALKED = 3;
  seedHandles(TOTAL);
  const asked = stubDbRunning();

  const lines = await captureLogLines(
    () => reapOrphanHandles(leaseLostAfter(asked, WALKED)),
    STOPPED,
  );
  const record = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((entry) => entry.msg === STOPPED);
  assert.ok(record, `the stop was never logged:\n${lines.join("\n")}`);

  assert.equal(asked.length, WALKED, "the premise: the traversal really did stop part way");
  assert.equal(
    record.remaining,
    TOTAL - WALKED,
    "the handles left for the next leader are the ones this pass never reached",
  );
});

test("a pass that tore nothing down still reports the ground it covered", async () => {
  // The exact shape of the defect. `dropped` is 0 here -- every DAG is running,
  // which is the normal state of the bucket -- so a `remaining` computed from it
  // is the whole bucket no matter how far the loop got. Seven of eight walked
  // has to read as one left, not eight.
  const TOTAL = 8;
  const WALKED = 7;
  seedHandles(TOTAL);
  const asked = stubDbRunning();

  const lines = await captureLogLines(
    () => reapOrphanHandles(leaseLostAfter(asked, WALKED)),
    STOPPED,
  );
  const record = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((entry) => entry.msg === STOPPED);
  assert.ok(record, `the stop was never logged:\n${lines.join("\n")}`);

  assert.equal(record.dropped, 0, "nothing was terminal, so nothing was torn down");
  assert.equal(
    record.remaining,
    1,
    "with no teardowns to count, a remaining derived from them reports the whole bucket",
  );
  assert.equal(record.examined, WALKED, "and how much was covered is reported in its own field");
});

test("stopping on the first handle hands the whole bucket over", async () => {
  // The boundary at the other end, and the one case where the old arithmetic
  // was accidentally right: nothing walked means everything remains. It has to
  // stay right.
  const TOTAL = 5;
  seedHandles(TOTAL);
  const asked = stubDbRunning();

  const lines = await captureLogLines(
    () => reapOrphanHandles(leaseLostAfter(asked, 0)),
    STOPPED,
  );
  const record = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((entry) => entry.msg === STOPPED);
  assert.ok(record, `the stop was never logged:\n${lines.join("\n")}`);

  assert.equal(asked.length, 0, "the gate is read before the first DAG is judged");
  assert.equal(record.remaining, TOTAL);
  assert.equal(record.examined, 0);
});

test("a lease that holds walks the bucket out and logs no handover", async () => {
  // The ordinary pass. Nothing is left over, so nothing may be reported as left
  // over -- an accounting fix that starts emitting a stop line on a clean sweep
  // would be a worse signal than the one it replaced.
  const TOTAL = 4;
  seedHandles(TOTAL);
  const asked = stubDbRunning();

  const lines = await captureLogLines(
    () => reapOrphanHandles({ lost: () => undefined }),
    STOPPED,
  );
  assert.equal(asked.length, TOTAL, "every handle was judged");
  assert.ok(
    !lines.some((line) => line.includes(STOPPED)),
    "a pass that finished must not report a handover",
  );
});
