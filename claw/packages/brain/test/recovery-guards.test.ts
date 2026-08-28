// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Four guards that were written but did not guard anything.
//
// Each is small on its own, and each fails silently, which is why none of them
// showed up in a suite that otherwise covers this area well: a kill switch that
// disables a third of a feature, a token check that can only answer no, a
// throttle keyed on a counter that changes every time, and an address assembled
// with an empty namespace that turns into a `dead` verdict.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec } from "nats";
import { instanceFromEntry } from "../src/sandbox/container-probe.js";
import { bindDagHandleKvForTest, isValidDagHandleToken } from "../src/sandbox/handles.js";
import { AGENT_SANDBOX_NAMESPACE } from "../src/config.js";

const sc = StringCodec();
let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
});

test("an agent-sandbox entry with no namespace is unusable, not dead", () => {
  // `namespace: entry.namespace || ""` built `/v1/namespaces//code-interpreters/
  // ...`, which the Router cannot resolve. The 404 read as exec_sandbox_gone,
  // and that is the one verdict allowed to destroy a live container.
  const inst = instanceFromEntry("s-1", {
    provider: "agent-sandbox",
    sessionId: "s-1",
    sandboxName: "box-1",
  });

  if (AGENT_SANDBOX_NAMESPACE) {
    assert.equal(inst?.namespace, AGENT_SANDBOX_NAMESPACE,
      "a missing namespace falls back the way the safe-workload branch always has");
  } else {
    assert.equal(inst, null,
      "an entry that cannot be addressed must not be turned into an exec that 404s");
  }
});

test("an agent-sandbox entry that names its namespace keeps it", () => {
  const inst = instanceFromEntry("s-1", {
    provider: "agent-sandbox",
    sessionId: "s-1",
    sandboxName: "box-1",
    namespace: "team-a",
  });
  assert.equal(inst?.namespace, "team-a");
});

/** The shape DagHandleMap.create writes: one row per DAG, keyed by handle. */
function handleRow(handles: Record<string, { workload_id: string; token?: string }>) {
  return sc.encode(JSON.stringify(handles));
}

test("a DAG handle token is found one level in, where the map actually writes it", async () => {
  // Read off the top of the value this always answered no, so the fallback for
  // a node whose token lives only in the handle map -- because a sibling owns
  // hands.<sessionId> -- rejected every token it was given.
  restore = bindDagHandleKvForTest({
    async keys() { return (async function* () { yield "dag_handles.root-1"; })(); },
    async get() {
      return { value: handleRow({ build: { workload_id: "wl-1", token: "tok-abc" } }) };
    },
  });

  assert.equal(await isValidDagHandleToken("tok-abc"), true);
});

test("a DAG handle token that belongs to nobody is still rejected", async () => {
  restore = bindDagHandleKvForTest({
    async keys() { return (async function* () { yield "dag_handles.root-1"; })(); },
    async get() {
      return { value: handleRow({ build: { workload_id: "wl-1", token: "tok-abc" } }) };
    },
  });

  assert.equal(await isValidDagHandleToken("tok-other"), false);
});

test("a handle row with no tokens in it does not match an empty-ish token", async () => {
  restore = bindDagHandleKvForTest({
    async keys() { return (async function* () { yield "dag_handles.root-1"; })(); },
    async get() { return { value: handleRow({ build: { workload_id: "wl-1" } }) }; },
  });

  assert.equal(await isValidDagHandleToken("tok-abc"), false);
});
