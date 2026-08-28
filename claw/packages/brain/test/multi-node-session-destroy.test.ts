// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Does session teardown admit when it did not finish?
 *
 * Every way it can fall short looks identical from outside unless it says so: no
 * platform key, a SaFE list that errored, a workload that refused to delete. A
 * warning logged and a resolved promise is indistinguishable from a clean
 * teardown.
 * The caller decides exactly one thing from this result: a complete teardown
 * lets it delete the `hands.<sid>` handle, while an incomplete one leaves that
 * handle parked for the idle-reclaim sweeper, which is how the session's
 * clusters are found at all. So "always succeeds" meant the handle was always
 * dropped, and with it the only record those clusters could be reached
 * through -- leaving them to the workload's own timeout.
 *
 * The result now says what happened, and these pin each way it can be
 * incomplete.
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";

process.env.SAFE_API_URL = "http://safe.test";

const { SafeMultiNodeProvider, reclaimIdleSessionClusters } = await import(
  "../src/sandbox/multi-node/safe-provider.js"
);

const SESSION = "sess-1";
const KEY = "safe-key";

interface StubbedCall {
  url: string;
  method: string;
}

/** Mirrors SESSION_PAGE_SIZE in sandbox/multi-node/safe-provider.ts. */
const PAGE_SIZE = 200;

/**
 * Install a fetch that answers the workload list with `list` and every DELETE
 * with `deleteStatus`. Returns the calls made, and restores fetch on cleanup.
 *
 * The list is served by `offset`, the way SaFE does. A stub that ignored it and
 * returned the same rows to every request would let the walk re-collect them
 * until it hit the page cap, so a test asserting one DELETE would see twenty.
 */
function stubSafeApi(t: TestContext, opts: {
  listStatus?: number;
  list?: unknown[];
  /** Overrides the count SaFE reports, to model rows the walk cannot address. */
  totalCount?: number;
  deleteStatus?: number;
}): StubbedCall[] {
  const calls: StubbedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    // A DELETE answer carries no body — and 204 forbids one outright, so it has
    // to be null rather than "".
    if (method === "DELETE") {
      return new Response(null, { status: opts.deleteStatus ?? 204 });
    }
    const status = opts.listStatus ?? 200;
    const all = opts.list ?? [];
    const offset = Number(new URL(url, "http://safe.test").searchParams.get("offset") ?? "0");
    const body = JSON.stringify(
      workloadList(all.slice(offset, offset + PAGE_SIZE), opts.totalCount ?? all.length),
    );
    return new Response(body, { status });
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

/**
 * A SaFE workload list entry in the shape the parser expects. `kind` matters
 * only to idle reclaim, which spares anything that is not a GPU cluster.
 */
function workload(id: string, phase: string, kind?: string) {
  return kind ? { workloadId: id, phase, groupVersionKind: { kind } } : { workloadId: id, phase };
}

/** SaFE returns the list under `items`, alongside a total count. */
function workloadList(items: unknown[], totalCount?: number) {
  return { totalCount: totalCount ?? items.length, items };
}

test("a session with nothing running is complete", async (t) => {
  stubSafeApi(t, { list: [] });

  const result = await new SafeMultiNodeProvider().destroyForSession(SESSION, { platformKey: KEY });

  assert.equal(result.complete, true);
  assert.equal(result.found, 0);
  assert.equal(result.deleted, 0);
  assert.equal(result.reason, undefined);
});

test("every cluster deleted is complete", async (t) => {
  const calls = stubSafeApi(t, {
    list: [workload("w1", "running"), workload("w2", "pending")],
    deleteStatus: 204,
  });

  const result = await new SafeMultiNodeProvider().destroyForSession(SESSION, { platformKey: KEY });

  assert.deepEqual(
    { complete: result.complete, found: result.found, deleted: result.deleted },
    { complete: true, found: 2, deleted: 2 },
  );
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 2);
});

test("a workload already gone still counts as deleted", async (t) => {
  // 404 means somebody else got there first, which is the outcome we wanted.
  stubSafeApi(t, { list: [workload("w1", "running")], deleteStatus: 404 });

  const result = await new SafeMultiNodeProvider().destroyForSession(SESSION, { platformKey: KEY });

  assert.equal(result.complete, true);
  assert.equal(result.deleted, 1);
});

test("a cluster that refused to delete is reported incomplete", async (t) => {
  // This is the leak: the workload is still up, and reporting success here would
  // have the caller drop the handle the sweeper needs to reach it through.
  stubSafeApi(t, { list: [workload("w1", "running")], deleteStatus: 500 });

  const result = await new SafeMultiNodeProvider().destroyForSession(SESSION, { platformKey: KEY });

  assert.equal(result.complete, false);
  assert.equal(result.reason, "delete_failed");
  assert.equal(result.found, 1);
  assert.equal(result.deleted, 0);
});

test("a partial teardown is incomplete even though something was deleted", async (t) => {
  let nth = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? "GET") !== "DELETE") {
      return new Response(
        JSON.stringify(workloadList([workload("w1", "running"), workload("w2", "running")])),
        { status: 200 },
      );
    }
    return new Response(null, { status: ++nth === 1 ? 204 : 500 });
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const result = await new SafeMultiNodeProvider().destroyForSession(SESSION, { platformKey: KEY });

  assert.equal(result.complete, false);
  assert.equal(result.deleted, 1);
  assert.equal(result.found, 2);
});

test("a failed lookup is incomplete, not an empty session", async (t) => {
  // Nothing was enumerated, so nothing is known to be gone. Treating this as a
  // clean teardown is how a whole session's clusters survived a delete.
  stubSafeApi(t, { listStatus: 503 });

  const result = await new SafeMultiNodeProvider().destroyForSession(SESSION, { platformKey: KEY });

  assert.equal(result.complete, false);
  assert.equal(result.reason, "lookup_failed");
});

test("a 200 that is not a workload list is incomplete, not an empty session", async (t) => {
  // The dangerous shape: HTTP 200, so the list "succeeded", but the body is not
  // something we can read. Parsing it as zero workloads would report the session
  // clean and drop its handle while its clusters keep running.
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: { items: [] } }), { status: 200 })) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const result = await new SafeMultiNodeProvider().destroyForSession(SESSION, { platformKey: KEY });

  assert.equal(result.complete, false);
  assert.equal(result.reason, "lookup_failed");
});

test("a session spanning more than one page is walked to the end", async (t) => {
  // The reason paging exists. A session's finished workloads are never removed
  // from SaFE's list -- a sandbox is retired with `stop`, which only moves it to
  // `Stopped` -- so a long-lived session accumulates them and its running
  // clusters can sit past the first page. Collecting one page reported such a
  // session incomplete on every delete while leaving the rest of it running.
  const all = Array.from({ length: PAGE_SIZE + 30 }, (_, i) => workload(`w${i}`, "running"));
  const calls = stubSafeApi(t, { list: all, deleteStatus: 204 });

  const result = await new SafeMultiNodeProvider().destroyForSession(SESSION, { platformKey: KEY });

  assert.equal(result.found, all.length, "every page counts toward what was found");
  assert.equal(result.deleted, all.length);
  assert.equal(result.complete, true, "nothing was left unaddressed");
  assert.equal(
    calls.filter((c) => c.method === "GET").length,
    2,
    "one request per page, and none once the reported count is met",
  );
});

test("the filter and the ordering are asked for, not inherited", async (t) => {
  // `phase` keeps a session's finished workloads out of both the page and the
  // count, which is what stops the accumulated ones from pushing every teardown
  // onto extra pages. It lists the four non-terminal values of SaFE's
  // WorkloadPhase enum and has to be updated with it -- pinned here so a drift
  // shows up as a failure rather than as clusters nobody looks for.
  //
  // The sort is stated because the server's own defaults decide whether a page
  // that does get truncated holds the newest workloads or the oldest, and only the
  // newest can still be running.
  const calls = stubSafeApi(t, { list: [] });

  await new SafeMultiNodeProvider().destroyForSession(SESSION, { platformKey: KEY });

  const query = new URL(calls[0].url).searchParams;
  assert.equal(query.get("phase"), "Pending,Running,Updating,NotReady");
  assert.equal(query.get("sortBy"), "creation_time");
  assert.equal(query.get("order"), "desc");
});

test("an unrecognised phase is treated as alive, not skipped", async (t) => {
  // The client-side skip is the second layer. The phase filter should keep the
  // terminal rows out, but where it does not apply -- a parameter the server
  // ignores, a whitelist that has fallen behind SaFE's enum -- whatever arrives is
  // judged here. Skipping an unrecognised phase would leave a running cluster
  // behind while reporting the session clean, so it counts as alive instead, which
  // costs at worst one redundant DELETE on something already dead.
  const calls = stubSafeApi(t, { list: [workload("w1", "Ready")], deleteStatus: 204 });

  const result = await new SafeMultiNodeProvider().destroyForSession(SESSION, { platformKey: KEY });

  assert.equal(result.found, 1, "an unknown phase is the teardown's business");
  assert.equal(result.deleted, 1);
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 1);
});

test("finished workloads count toward the page but not toward the teardown", async (t) => {
  // The same second layer, for the rows the filter is meant to remove. If they
  // arrive anyway they still count toward totalCount, so the walk has to collect
  // them to satisfy it and the skip keeps them out of `found`. Counting them as
  // found is what would make a long-lived session report an unfinished teardown
  // forever, since nothing ever takes a finished workload off that list.
  const calls = stubSafeApi(t, {
    list: [
      workload("dead-1", "succeeded"),
      workload("live-1", "running"),
      workload("dead-2", "stopped"),
    ],
    deleteStatus: 204,
  });

  const result = await new SafeMultiNodeProvider().destroyForSession(SESSION, { platformKey: KEY });

  assert.equal(result.found, 1, "only the live workload is the teardown's business");
  assert.equal(result.deleted, 1);
  assert.equal(result.complete, true, "the terminal rows are accounted for, not missing");
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 1);
});

test("a shortfall against the reported count still deletes what it enumerated", async (t) => {
  // SaFE reports more matches than the walk could collect, so workloads exist it
  // never handed over. That makes the session unclean, but it must not stop the
  // ones we *can* address from being deleted -- refusing to act would leave
  // those burning too.
  const calls = stubSafeApi(t, {
    list: [workload("w1", "running")],
    totalCount: 250,
    deleteStatus: 204,
  });

  const result = await new SafeMultiNodeProvider().destroyForSession(SESSION, { platformKey: KEY });

  assert.equal(calls.filter((c) => c.method === "DELETE").length, 1, "the addressable one must go");
  assert.equal(result.deleted, 1);
  assert.equal(result.complete, false, "but the session is not proven clean");
  assert.equal(
    result.reason,
    "list_truncated",
    "distinct from a list that could not be read at all",
  );
});

test("an entry with no id does not block the entries that have one", async (t) => {
  // A malformed entry is skipped by the parser, so it shows up as a shortfall
  // against totalCount. Treating that as a dead end would mean one bad row from
  // SaFE stops a whole session's clusters from being reclaimed.
  const calls = stubSafeApi(t, {
    list: [workload("w1", "running"), { phase: "Running" }, workload("w2", "running")],
    deleteStatus: 204,
  });

  const result = await new SafeMultiNodeProvider().destroyForSession(SESSION, { platformKey: KEY });

  assert.equal(calls.filter((c) => c.method === "DELETE").length, 2);
  assert.equal(result.deleted, 2);
  assert.equal(result.complete, false);
});

test("idle reclaim keeps working when the list is unusable or short", async (t) => {
  // The idle sweeper is opportunistic: it reclaims what it can see on a timer
  // and sees the rest on a later pass. It must not inherit the fail-closed
  // semantics teardown needs -- a session whose page is short would otherwise
  // stop having its idle clusters reclaimed at all.
  const shortPage = stubSafeApi(t, {
    list: [workload("w1", "running", "RayJob")],
    totalCount: 250,
    deleteStatus: 204,
  });

  assert.equal(await reclaimIdleSessionClusters(SESSION, KEY), 1, "the visible cluster is reclaimed");
  assert.equal(shortPage.filter((c) => c.method === "DELETE").length, 1);
});

test("idle reclaim treats an unrecognised list as nothing found, not a failure", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: { items: [] } }), { status: 200 })) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  // Before the list shape was distinguished this returned zero; it must still,
  // rather than throwing into the sweeper's per-session catch.
  assert.equal(await reclaimIdleSessionClusters(SESSION, KEY), 0);
});

test("no platform key is incomplete, not nothing to do", async (t) => {
  const calls = stubSafeApi(t, { list: [] });

  const result = await new SafeMultiNodeProvider().destroyForSession(SESSION, { platformKey: "" });

  assert.equal(result.complete, false);
  assert.equal(result.reason, "no_platform_key");
  assert.equal(calls.length, 0, "without a key it cannot even list");
});
