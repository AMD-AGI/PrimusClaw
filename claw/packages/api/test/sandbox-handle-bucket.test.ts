// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The API destroys sandboxes out of the bucket Brain registers them in.
 *
 * This is the defect that made every other guarantee in this area vacuous, and
 * it is invisible at every level a test normally looks at. `sandbox-stopper`
 * read `infra/nats.kv`, which is `BRAIN_REGISTRY`; Brain writes handles to a
 * bucket of its own called `DAG_HANDLES`. Both sides used the same
 * `DagHandleMap`, the same key shape and the same encoding, and neither ever
 * errored -- the reader simply asked a bucket that had nothing in it.
 *
 * What that cost: every API-side teardown found an empty map and tore nothing
 * down, so a DAG's sandboxes outlived their DAG, on the cancel path, the
 * agent_done path and the sweeper alike. And it is exactly the shape of bug
 * this whole feature was asked to make visible, so shipping the report over the
 * top of it would have turned a silent leak into a confident `nothing_held` --
 * a worse outcome than the silence, because now something is asserting.
 *
 * A unit test cannot catch a name that is wrong but consistent, and an
 * integration test that stubs the registry cannot either. What does catch it is
 * pinning the two names to each other, since the bug is precisely that they
 * disagreed. Read from source because the two live in different packages and
 * the API's binding is a module-scoped `let` that only `initNats` fills.
 *
 * Coverage:
 *   B1 Brain's writer and the API's reader name the same bucket
 *   B2 the stopper reads that binding, not the short-lived registry one
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DAG_HANDLES_BUCKET } from "../src/infra/nats.js";

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");
}

test("B1 Brain's handle writer and the API's handle reader name the same bucket", () => {
  const brain = read("../../brain/src/sandbox/handles.ts");
  const declared = /const BUCKET = "([A-Z_]+)"/.exec(brain)?.[1];

  assert.equal(
    declared, DAG_HANDLES_BUCKET,
    "the only writer and the only destroyer have to be looking at the same bucket; "
      + "when they were not, nothing failed and every sandbox leaked",
  );
});

test("B2 the stopper reads the DAG handles binding, not the short-lived registry", () => {
  const stopper = read("../src/tasks/sandbox-stopper.ts");

  assert.match(
    stopper, /import \{ kvDagHandles \} from "\.\.\/infra\/nats\.js"/,
    "the handle map is built over the DAG handles bucket",
  );
  // `kv` is BRAIN_REGISTRY: five-minute TTL, sized for `lock.<key>`. A handle
  // has to outlive its DAG, which for a long evaluation is hours, so reading
  // handles from there loses the mapping even when the name is right.
  assert.equal(
    /\bkv as natsKv\b/.test(stopper), false,
    "BRAIN_REGISTRY is coordination state that expires; a handle mapping must not",
  );
});
