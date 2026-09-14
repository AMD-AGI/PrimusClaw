// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whether a cancelled run's sandbox was actually released, and whether the
 * caller can find that out.
 *
 * The state this pins down existed in three places and reached nobody:
 * `safeStopWorkload` logged a non-2xx or a timeout and returned `void`,
 * `cancelTask`'s DAG-root branch returned `{ok: true}` after awaiting it, and
 * the cancel route forwarded that. So an accepted cancellation whose SaFE stop
 * failed was byte-identical to one that worked, a GPU workload kept running,
 * and the only counter built to catch exactly that stayed at zero. The point of
 * these tests is not that the teardown works -- it is that a caller who is told
 * "cancelled" can tell the two apart.
 *
 * The trap this must not fall into is inferring release from the handle map.
 * `destroy` removes the mapping BEFORE the stop is attempted, so the map is
 * empty afterwards whether the stop succeeded, failed, or timed out. An empty
 * handle map is evidence the attempt was made, never that it worked, and the
 * "one handle of several fails" case below is what would catch a future change
 * that starts reading it that way.
 *
 * `SAFE_API_URL` is read once at module scope, so it is set before the dynamic
 * import, as config-blank-env.test.ts does. The unset case needs the opposite
 * value of that same module-scope read and therefore lives in its own file,
 * cancel-release-no-safe-url.test.ts.
 *
 * Coverage:
 *   R1 a stop SaFE acknowledges is reported `confirmed`
 *   R2 a 404 from SaFE is `confirmed` -- the workload is gone, which is the goal
 *   R3 a non-2xx is `unconfirmed`, not swallowed
 *   R4 a timeout is `unconfirmed`, and does not throw out of the cancel
 *   R5 a DAG where one of several stops fails is not `confirmed`
 *   R6 a task that never recorded a handle is `nothing_held`, distinctly
 *   R7 a handle with no SaFE workload behind it is `unconfirmed`, not `nothing_held`
 *   R8 a failed release does not fail the cancellation or change its fields
 *   R9 the non-root branch omits the field rather than guessing at it
 *   R10 the route answers 200 with the field added and nothing else changed
 *   R11 a repeat cancel does not downgrade a failed release to `nothing_held`
 *   R12 a confirmed release clears the record instead of latching it
 *   R13 an accepted stop is `confirmed`, with no second request behind it
 *   R14 a deleted handle key reads as absent, not as a corrupt entry
 *   R15 an unreadable handle registry is `unconfirmed`, never `nothing_held`
 *   R16 cleanup that throws is contained: still a 200, later handles still run
 *   R17 a handle that leaked earlier is not confirmed away by a later teardown
 *   R18 a handle is on record before its stop runs, not after it fails
 *   R19 a destroy whose response was lost is recorded, not forgotten
 */
import test, { after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { HandleInfo } from "@claw/protocol";

process.env.SAFE_API_URL = "http://safe.test";

const { db } = await import("../src/infra/db.js");
const { handleRegistry, unreleasedRecord, stopAllHandlesForDag, stopSandboxByHandle } =
  await import("../src/tasks/sandbox-stopper.js");
const { cancelTask } = await import("../src/tasks/lifecycle.js");
const { registerTaskRoutes, interruptDelivery } = await import("../src/routes/tasks.js");

const originalQuery = db.query;
const originalRegistry = { ...handleRegistry };
const originalRecord = { ...unreleasedRecord };
const originalInterrupt = { ...interruptDelivery };
const originalFetch = globalThis.fetch;

/** The record's real storage is NATS KV; in-memory is the same contract. */
let recorded: Map<string, Set<string>>;

function restoreAll(): void {
  db.query = originalQuery;
  Object.assign(handleRegistry, originalRegistry);
  Object.assign(unreleasedRecord, originalRecord);
  Object.assign(interruptDelivery, originalInterrupt);
  globalThis.fetch = originalFetch;
}
after(restoreAll);
afterEach(restoreAll);
beforeEach(() => {
  recorded = new Map();
  unreleasedRecord.mark = async (dag, handle) => {
    if (!recorded.has(dag)) recorded.set(dag, new Set());
    recorded.get(dag)!.add(handle);
  };
  unreleasedRecord.clear = async (dag, handle) => { recorded.get(dag)?.delete(handle); };
  unreleasedRecord.any = async (dag) => (recorded.get(dag)?.size ?? 0) > 0;
  interruptDelivery.publish = () => {};
  interruptDelivery.flush = async () => {};
});

/** The session's owner, so the route's ownership gate passes on its own. */
const CALLER = {
  userId: "u-1", userName: "u-1", roles: ["default"],
  platformKey: "pk", virtualKey: "vk-u-1",
};

const DAG_ROOT = {
  task_id: "t-root",
  session_id: "s-1",
  status: "running",
  dag_node_id: "__dag_root__",
  dag_root_task_id: "t-root",
};

/** Answers as if `task` were the only row, and every UPDATE matched it. */
function stubDb(task: Record<string, unknown> = DAG_ROOT): void {
  db.query = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("SELECT * FROM claw_tasks WHERE task_id")) {
      return params[0] === task.task_id ? { rows: [task], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    // The cancel route's access gate, for the tests that go over HTTP.
    if (sql.startsWith("SELECT user_id FROM claw_sessions")) {
      return { rows: [{ user_id: CALLER.userId }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT config FROM claw_sessions")) {
      return { rows: [{ config: {} }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE claw_tasks SET status")) {
      return { rows: [{ ...task, status: "cancelled" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
}

/**
 * A handle registry holding `handles`, whose `destroy` reports each workload id
 * once and nothing on a second call -- the same not-registered answer the real
 * map gives, so the map is genuinely empty by the time an outcome is read.
 */
function stubHandles(handles: Record<string, string>): void {
  const live = new Map(Object.entries(handles));
  handleRegistry.listForDag = async (): Promise<Record<string, HandleInfo>> =>
    Object.fromEntries([...live].map(([name, wid]) => [name, { workload_id: wid }]));
  handleRegistry.destroy = async (_dag: string, name: string): Promise<string | null> => {
    if (!live.has(name)) return null;
    const wid = live.get(name)!;
    live.delete(name);
    return wid;
  };
}

/**
 * A SaFE that answers the stop per workload id, and records any OTHER workload
 * request separately.
 *
 * `read` exists to be asserted empty. A review round added a confirming
 * `GET /api/v1/workloads/<id>` after each accepted stop, on the theory that a
 * 2xx is not a release -- which is true, since SaFE's teardown is asynchronous
 * under a finalizer. The read cannot establish it either: the apiserver's read
 * is database-backed and answers 200 for a workload that stopped perfectly
 * normally, so it reported `unconfirmed` for every successful cancellation
 * there is. Keeping the counter means R13 can assert the second request is
 * *absent*, which is the property that version violated.
 */
function stubSafe(
  answer: (workloadId: string) => Response | Promise<Response>,
): { stopped: string[]; read: string[] } {
  const stopped: string[] = [];
  const read: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const stopId = /\/workloads\/([^/]+)\/stop$/.exec(url)?.[1];
    if (stopId !== undefined) {
      stopped.push(stopId);
      return await answer(stopId);
    }
    // Nothing should reach here. Recorded rather than thrown so the assertion
    // names the request that was made, instead of a test failing on a stray
    // fetch with no indication of which one.
    read.push(/\/workloads\/([^/]+)$/.exec(url)?.[1] ?? url);
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return { stopped, read };
}

test("R1 a stop SaFE acknowledges is reported as confirmed", async () => {
  stubDb();
  stubHandles({ main: "w-1" });
  const { stopped } = stubSafe(() => new Response("", { status: 200 }));

  const r = await cancelTask("t-root");

  assert.equal(r.released, "confirmed");
  assert.deepEqual(stopped, ["w-1"], "the stop must actually be issued, not assumed");
});

test("R2 a 404 from SaFE is confirmed: the workload is gone, which is the goal", async () => {
  // The one non-2xx that is a success. SaFE does not know the workload, and
  // "SaFE does not know this workload" is the state the stop was trying to
  // reach -- a retry of an already-effective stop, or a workload SaFE reaped
  // first. Counting it as a failure would page somebody for a clean teardown.
  stubDb();
  stubHandles({ main: "w-gone" });
  stubSafe(() => new Response("not found", { status: 404 }));

  assert.equal((await cancelTask("t-root")).released, "confirmed");
});

test("R3 a non-2xx is reported unconfirmed rather than swallowed", async () => {
  stubDb();
  stubHandles({ main: "w-1" });
  stubSafe(() => new Response("boom", { status: 500 }));

  const r = await cancelTask("t-root");

  assert.equal(
    r.released, "unconfirmed",
    "SaFE refused the stop, so the workload may still be burning a GPU",
  );
});

test("R4 a stop that times out is unconfirmed, and does not throw out of the cancel", async () => {
  // A timeout is the case that most deserves `unconfirmed` and is least like
  // `gone`: the request may well have been received and acted on, or not, and
  // this side cannot tell. It must not be rounded to either certainty.
  stubDb();
  stubHandles({ main: "w-1" });
  globalThis.fetch = (async () => {
    throw Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
  }) as typeof globalThis.fetch;

  const r = await cancelTask("t-root");

  assert.equal(r.released, "unconfirmed");
  assert.equal(r.ok, true, "a cleanup that timed out must not fail the cancellation");
});

test("R5 a DAG where one of several stops fails is not reported confirmed", async () => {
  // The averaging bug this exists to prevent: two handles released cleanly and
  // one did not, and the honest report is the pessimistic one. This is also the
  // test that fails if anyone reintroduces "the handle map is empty, therefore
  // everything was released" -- the map IS empty here, and the answer is still
  // unconfirmed.
  stubDb();
  stubHandles({ a: "w-a", b: "w-b", c: "w-c" });
  const { stopped } = stubSafe((wid) =>
    new Response("", { status: wid === "w-b" ? 502 : 200 })
  );

  const r = await cancelTask("t-root");

  assert.equal(r.released, "unconfirmed");
  assert.deepEqual(
    stopped.sort(), ["w-a", "w-b", "w-c"],
    "one failure must not abort the remaining teardowns",
  );
  assert.deepEqual(
    await handleRegistry.listForDag("t-root"), {},
    "the map is empty either way, which is why it cannot be the evidence",
  );
});

test("R6 a task that never recorded a handle is nothing_held, not a failed release", async () => {
  stubDb();
  stubHandles({});
  const { stopped } = stubSafe(() => new Response("", { status: 200 }));

  const r = await cancelTask("t-root");

  assert.equal(
    r.released, "nothing_held",
    "nothing was leaked, which is a different fact from a release that failed",
  );
  assert.deepEqual(stopped, [], "no handle means no call to make");
});

test("R7 a handle with no SaFE workload behind it is unconfirmed, not nothing_held", async () => {
  // agent-sandbox handles are registered with `workload_id: ""` (Brain's
  // ensureHands), and this path has never had a way to stop one: the old code
  // shared a falsy check with "no such handle" and returned early. Something
  // IS held and this code did not release it, so reporting `nothing_held`
  // would assert the opposite of what is true.
  //
  // Asserted on stopSandboxByHandle directly, because the aggregate cannot
  // tell this apart: `nothing_held` for the one handle of a non-empty DAG
  // aggregates to `unconfirmed` too, so a cancel-level assertion would stay
  // green with the branch returning exactly the wrong value.
  stubDb();
  handleRegistry.listForDag = async () => ({ main: { workload_id: "" } });
  handleRegistry.destroy = async () => "";
  const { stopped } = stubSafe(() => new Response("", { status: 200 }));

  assert.equal(await stopSandboxByHandle("t-root", "main", "s-1"), "unconfirmed");
  assert.deepEqual(stopped, [], "there is no workload id to issue a stop against");
  assert.equal(
    await unreleasedRecord.any("t-root"), true,
    "and it is on record, so the next caller does not read the empty map as nothing_held",
  );

  assert.equal((await cancelTask("t-root")).released, "unconfirmed", "and it aggregates through");
});

test("R8 a failed release changes nothing about the cancellation itself", async () => {
  // Cancellation writes a verdict; cleanup reports on itself. Dispatron and the
  // sweeper both rely on the verdict landing whatever the teardown did, so the
  // new field is additive and the old ones are untouched.
  stubDb();
  stubHandles({ main: "w-1" });
  stubSafe(() => new Response("boom", { status: 500 }));

  const r = await cancelTask("t-root");

  assert.equal(r.ok, true);
  assert.equal(r.cancelled, 1, "the rows were still transitioned");
  assert.equal(r.interrupt_key, "t-root", "and the interrupt is still addressed");
  // That the interrupt is actually PUBLISHED is the route's half of this, and
  // is asserted where it happens -- see R10, which watches the seam.
});

test("R9 a non-root cancel omits the field rather than guessing at it", async () => {
  // This branch stops no sandbox -- teardown happens when the DAG root
  // transitions, or when the sweeper reaches it. `nothing_held` would claim no
  // handle was ever recorded, which was never checked; `unconfirmed` would
  // report a failed attempt that was never made. Absent is the true answer, and
  // it is also what keeps the response identical for callers who predate this.
  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("SELECT * FROM claw_tasks WHERE task_id")) {
      return {
        rows: [{ ...DAG_ROOT, task_id: "t-mid", dag_node_id: "n-mid" }],
        rowCount: 1,
      };
    }
    if (sql.startsWith("UPDATE claw_tasks SET status")) {
      return { rows: [{ task_id: "t-mid" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;

  const r = await cancelTask("t-mid");

  assert.equal("released" in r, false, "no sandbox was touched, so nothing is established");
});

/** The cancel route, with the caller already authorized. */
async function cancelOverHttp(taskId: string): Promise<{ status: number; body: unknown }> {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: unknown }).user = CALLER;
  });
  await registerTaskRoutes(app);
  await app.ready();
  try {
    const res = await app.inject({ method: "POST", url: `/v1/tasks/${taskId}/cancel` });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  } finally {
    await app.close();
  }
}

test("R10 the route answers 200 with the field added and nothing else changed", async () => {
  // Over HTTP rather than by matching the handler's source. A source match
  // cannot see a status code -- a `reply.status(500)` added before the return
  // would leave it green -- and the status code is one of the three things
  // this change promised not to touch.
  stubDb();
  stubHandles({ main: "w-1" });
  stubSafe(() => new Response("boom", { status: 500 }));
  let published: string[] = [];
  interruptDelivery.publish = (key: string) => { published.push(key); };

  const failed = await cancelOverHttp("t-root");

  assert.equal(failed.status, 200, "a release that could not be established is still a 200");
  assert.deepEqual(
    failed.body, { ok: true, cancelled: 1, released: "unconfirmed" },
    "the whole body: `ok` and `cancelled` as before, `released` added beside them",
  );
  assert.deepEqual(published, ["t-root"], "and the interrupt still went out");

  // The same request when the release does land, so the field is shown to
  // track the outcome rather than being a constant the route always appends.
  stubHandles({ main: "w-1" });
  stubSafe(() => new Response("", { status: 200 }));
  const ok = await cancelOverHttp("t-root");
  assert.deepEqual(ok.body, { ok: true, cancelled: 1, released: "confirmed" });
});

test("R11 a repeat cancel does not downgrade a failed release to nothing_held", async () => {
  // The hole the record exists to close, and the one place the forbidden
  // inference could still get in. The first cancel empties the handle map
  // BEFORE its stop fails; a second cancel therefore reads an empty map, and
  // reading that as "nothing was ever held" turns a leaked GPU into a clean
  // bill of health -- exactly what this feature was asked to stop doing.
  stubDb();
  stubHandles({ main: "w-1" });
  stubSafe(() => new Response("boom", { status: 500 }));

  assert.equal((await cancelTask("t-root")).released, "unconfirmed");
  assert.deepEqual(await handleRegistry.listForDag("t-root"), {}, "the map is empty now");

  const second = await cancelTask("t-root");
  assert.equal(
    second.released, "unconfirmed",
    "the workload was never released, and a second look must not say otherwise",
  );
});

test("R12 a confirmed release clears the record instead of latching it", async () => {
  // The other side of R11: the record must not be a one-way latch that makes
  // every DAG unconfirmed forever. Seeded as already-outstanding on purpose --
  // the earlier version of this test started from an empty record, so it passed
  // with the `clear` call deleted and proved only that nothing had been written.
  stubDb();
  await unreleasedRecord.mark("t-root", "main", "w-1");
  assert.equal(await unreleasedRecord.any("t-root"), true, "the DAG starts out leaking");

  stubHandles({ main: "w-1" });
  stubSafe(() => new Response("", { status: 200 }));

  assert.equal((await cancelTask("t-root")).released, "confirmed");
  assert.equal(
    await unreleasedRecord.any("t-root"), false,
    "a release that landed has to retire the evidence that it had not",
  );
  assert.equal((await cancelTask("t-root")).released, "nothing_held", "and stay retired");
});

test("R13 an accepted stop is confirmed, and only one request is made", async () => {
  // `confirmed` means SaFE accepted the stop. It deliberately does NOT mean the
  // GPU is free -- SaFE tears the data plane down asynchronously under a
  // finalizer, so the two differ by whatever the controller is behind by.
  //
  // A review round tried to close that gap with a follow-up
  // `GET /api/v1/workloads/<id>`, confirming only on a 404. It cannot: the
  // apiserver's read is database-backed and filters `is_deleted = false`, while
  // the stop path writes phase/end_time/deletion_time and never `is_deleted`.
  // The read answers 200 for a perfectly normal stop, so that version reported
  // `unconfirmed` for every successful cancellation there is. This asserts the
  // absence of that second request, because a field that cries wolf constantly
  // is worse than the silence it replaced.
  stubDb();
  stubHandles({ main: "w-1" });
  const { stopped, read } = stubSafe(() => new Response("", { status: 200 }));

  assert.equal((await cancelTask("t-root")).released, "confirmed");
  assert.deepEqual(stopped, ["w-1"]);
  assert.deepEqual(read, [], "no confirming read: it would report a clean stop as a failure");
});

test("R14 a deleted handle key reads as absent, not as a corrupt entry", async () => {
  // The KV adapter now lets read failures propagate so an unreadable registry
  // cannot be reported as `nothing_held` (R15). That made the tombstone matter:
  // `kv.get` does not filter DEL/PURGE -- it answers with the deleted entry,
  // whose value is empty -- and an empty body is exactly what a stricter JSON
  // parse calls corrupt. Every handle this module destroys leaves one behind,
  // so without the DEL check a completely clean teardown reads as unreadable
  // and every later cancel of that DAG answers `unconfirmed` forever.
  const { makeKvStore } = await import("../src/tasks/sandbox-stopper.js");
  /** Only `get` is exercised here; the rest of the bucket is never reached. */
  const bucket = (get: () => Promise<unknown>) =>
    makeKvStore({ get } as unknown as Parameters<typeof makeKvStore>[0]);

  assert.equal(
    await bucket(async () => ({ operation: "DEL", value: new Uint8Array() }))
      .get("dag-handles.t-root"),
    null,
    "a destroyed handle is a key that is not there, not a key that is broken",
  );
  assert.equal(
    await bucket(async () => ({ operation: "PUT", value: new Uint8Array() }))
      .get("dag-handles.t-root"),
    null,
    "and so is an empty value that carries no operation marker",
  );
  await assert.rejects(
    () => bucket(async () => ({ operation: "PUT", value: new TextEncoder().encode("{oops") }))
      .get("dag-handles.t-root"),
    "while a genuinely corrupt payload is an unknown, which must not read as absent",
  );
  await assert.rejects(
    () => bucket(async () => { throw new Error("nats: no responders"); })
      .get("dag-handles.t-root"),
    "as is a bucket that cannot be reached at all",
  );
});

test("R15 an unreadable handle registry is unconfirmed, never nothing_held", async () => {
  // Driven through the real adapter rather than by replacing `listForDag` with
  // a throwing function: the earlier version did the latter, which asserts that
  // `stopAllHandlesForDag` catches a throw and never that the adapter produces
  // one. The adapter is the part that used to turn every read failure into
  // `null`, which `listForDag` renders as `{}` -- and an unreachable NATS
  // reporting a clean release for every DAG in the fleet is the failure this
  // exists to prevent.
  stubDb();
  const { makeKvStore } = await import("../src/tasks/sandbox-stopper.js");
  const { DagHandleMap } = await import("@claw/protocol");
  const unreachable = new DagHandleMap(makeKvStore({
    get: async () => { throw new Error("nats: no responders"); },
  } as unknown as Parameters<typeof makeKvStore>[0]));
  handleRegistry.listForDag = (dag: string) => unreachable.listForDag(dag);

  assert.equal((await cancelTask("t-root")).released, "unconfirmed");
});

test("R17 a handle that leaked earlier is not confirmed away by a later teardown", async () => {
  // `agent_done` tears a handle down as soon as its last user finishes. If that
  // stop fails, the mapping is already gone, so a cancel arriving afterwards
  // sees only the handles that remain -- releases them perfectly well -- and
  // would report `confirmed` over the top of the workload nobody released.
  // Confirming this call's own loop is not confirming the DAG.
  stubDb();
  await unreleasedRecord.mark("t-root", "already-leaked", "w-gone");
  stubHandles({ still_here: "w-2" });
  const { stopped } = stubSafe(() => new Response("", { status: 200 }));

  const r = await cancelTask("t-root");

  assert.deepEqual(stopped, ["w-2"], "the handle it can see is released");
  assert.equal(
    r.released, "unconfirmed",
    "and the one it cannot see is still outstanding, which is the DAG's answer",
  );
});

test("R18 a handle is on record before its stop is attempted, not after it fails", async () => {
  // Between `destroy` and the outcome the handle is in neither place: gone from
  // the map, not yet in the record. A concurrent cancel landing in that window
  // used to see an empty map and an empty record and answer `confirmed` for a
  // workload whose only stop was still in flight -- and a process that died
  // mid-stop left no trace that the attempt had happened at all.
  stubDb();
  stubHandles({ main: "w-1" });
  let markedWhileInFlight: boolean | null = null;
  globalThis.fetch = (async () => {
    markedWhileInFlight = await unreleasedRecord.any("t-root");
    return new Response("", { status: 200 });
  }) as typeof globalThis.fetch;

  assert.equal((await cancelTask("t-root")).released, "confirmed");
  assert.equal(
    markedWhileInFlight, true,
    "the window has to fail safe: on record first, cleared by a release that lands",
  );
  assert.equal(await unreleasedRecord.any("t-root"), false, "and it does get cleared");
});

test("R16 cleanup that throws is contained: 200, and the other handles still run", async () => {
  // `loadPlatformKeyForSession` runs outside the stop's own try/catch, so a
  // database hiccup threw straight through the aggregate and out of
  // cancelTask -- producing a 500 for a cancellation already written to the
  // database, and abandoning every handle after the first.
  const live = new Map([["a", "w-a"], ["b", "w-b"]]);
  db.query = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("SELECT * FROM claw_tasks WHERE task_id")) {
      return params[0] === "t-root" ? { rows: [DAG_ROOT], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("SELECT user_id FROM claw_sessions")) {
      return { rows: [{ user_id: CALLER.userId }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT config FROM claw_sessions")) throw new Error("db: connection reset");
    if (sql.startsWith("UPDATE claw_tasks SET status")) {
      return { rows: [{ ...DAG_ROOT, status: "cancelled" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  handleRegistry.listForDag = async () =>
    Object.fromEntries([...live].map(([n, w]) => [n, { workload_id: w }]));
  const destroyed: string[] = [];
  handleRegistry.destroy = async (_dag: string, name: string) => {
    destroyed.push(name);
    const wid = live.get(name) ?? null;
    live.delete(name);
    return wid;
  };
  stubSafe(() => new Response("", { status: 200 }));

  const res = await cancelOverHttp("t-root");

  assert.equal(res.status, 200, "the verdict is written; a cleanup that threw is not the caller's 500");
  assert.deepEqual(res.body, { ok: true, cancelled: 1, released: "unconfirmed" });
  assert.deepEqual(
    destroyed, ["a", "b"],
    "the second handle is still attempted -- one broken teardown must not abandon the rest",
  );
});

test("stopAllHandlesForDag aggregates on its own, without a cancel around it", async () => {
  // The sweeper and the agent_done path reach the same teardown by other
  // routes; the aggregation belongs to the teardown, not to cancelTask.
  stubDb();
  stubHandles({ a: "w-a", b: "w-b" });
  stubSafe(() => new Response("", { status: 200 }));
  assert.equal(await stopAllHandlesForDag("t-root", "s-1"), "confirmed");

  stubHandles({ a: "w-a", b: "w-b" });
  stubSafe((wid) => new Response("", { status: wid === "w-a" ? 503 : 200 }));
  assert.equal(await stopAllHandlesForDag("t-root", "s-1"), "unconfirmed");
});

test("R19 a destroy whose response was lost is recorded, not forgotten", async () => {
  // The last way a false clear could get in. `destroy` removes the mapping on
  // the server and the response is lost; the handle is now gone from the map
  // with nothing recorded anywhere, so the next caller reads an empty map, an
  // empty record, and answers `nothing_held` for a workload never stopped.
  //
  // Recorded with an empty workload id, which is the truth -- `destroy` is what
  // would have returned it. The deliberate cost is that nothing clears this
  // entry, because no later teardown revisits a handle that is no longer in the
  // map. A standing false alarm is visible and checkable; a false clear on a
  // live GPU is neither.
  stubDb();
  handleRegistry.listForDag = async () => ({ main: { workload_id: "w-1" } });
  handleRegistry.destroy = async () => { throw new Error("nats: request timeout"); };
  const { stopped } = stubSafe(() => new Response("", { status: 200 }));

  assert.equal((await cancelTask("t-root")).released, "unconfirmed");
  assert.deepEqual(stopped, [], "no workload id came back, so no stop could be issued");
  assert.equal(
    await unreleasedRecord.any("t-root"), true,
    "the handle has to be on record, or the next cancel reads the gap as nothing_held",
  );

  // The next caller, with the map now genuinely empty: the record is what stops
  // it inventing the one answer it must never invent.
  handleRegistry.listForDag = async () => ({});
  assert.equal((await cancelTask("t-root")).released, "unconfirmed");
});
