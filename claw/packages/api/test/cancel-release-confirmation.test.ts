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
 *   R10 the route forwards the field and leaves the rest of the response alone
 */
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { HandleInfo } from "@claw/protocol";

process.env.SAFE_API_URL = "http://safe.test";

const { db } = await import("../src/infra/db.js");
const { handleRegistry, stopAllHandlesForDag } = await import("../src/tasks/sandbox-stopper.js");
const { cancelTask } = await import("../src/tasks/lifecycle.js");

const originalQuery = db.query;
const originalRegistry = { ...handleRegistry };
const originalFetch = globalThis.fetch;
after(() => {
  db.query = originalQuery;
  Object.assign(handleRegistry, originalRegistry);
  globalThis.fetch = originalFetch;
});
afterEach(() => {
  db.query = originalQuery;
  Object.assign(handleRegistry, originalRegistry);
  globalThis.fetch = originalFetch;
});

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

/** Records every workload id a stop was issued for, answering per-id. */
function stubSafe(answer: (workloadId: string) => Response | Promise<Response>): string[] {
  const stopped: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const wid = /\/workloads\/([^/]+)\/stop$/.exec(url)?.[1] ?? "";
    stopped.push(wid);
    return await answer(wid);
  }) as typeof globalThis.fetch;
  return stopped;
}

test("R1 a stop SaFE acknowledges is reported as confirmed", async () => {
  stubDb();
  stubHandles({ main: "w-1" });
  const stopped = stubSafe(() => new Response("", { status: 200 }));

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
  const stopped = stubSafe((wid) =>
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
  const stopped = stubSafe(() => new Response("", { status: 200 }));

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
  stubDb();
  handleRegistry.listForDag = async () => ({ main: { workload_id: "" } });
  handleRegistry.destroy = async () => "";
  const stopped = stubSafe(() => new Response("", { status: 200 }));

  const r = await cancelTask("t-root");

  assert.equal(r.released, "unconfirmed");
  assert.deepEqual(stopped, [], "there is no workload id to issue a stop against");
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
  assert.equal(r.interrupt_key, "t-root", "the interrupt is still published");
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

test("R10 the route forwards the field and leaves the rest of the response alone", async () => {
  // Read from source rather than through a Fastify instance, which would need
  // NATS: what matters is the shape of the object the handler returns, and that
  // `ok` / `cancelled` and the status code are not rewritten alongside it.
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/routes/tasks.ts", import.meta.url), "utf-8")
  );
  const handler = src.slice(src.indexOf('"/v1/tasks/:taskId/cancel"'));
  const body = handler.slice(0, handler.indexOf("/v1/tasks/:taskId/retry"));

  assert.match(
    body, /\.\.\.\(r\.released \? \{ released: r\.released \} : \{\}\)/,
    "the field is spread in only when the cancel established something",
  );
  assert.match(body, /ok: true,\s*cancelled: r\.cancelled,/, "the existing fields are unchanged");
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
