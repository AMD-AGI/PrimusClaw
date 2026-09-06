// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The api NATS user can read the bucket its sandbox census depends on.
 *
 * `listDagHandles` attaches to DAG_HANDLES, which Brain creates and writes.
 * Without the read grants below the attach is denied, the census answers
 * `ok:false`, and every rollout gate and rollback step that iterates the fleet
 * stops -- a break that shows up only against a real server, since a denied
 * subject is an async error nothing in this repo consumes.
 *
 * The publish direction is asserted absent on purpose: the route is read-only,
 * and a `$KV.DAG_HANDLES.*` grant or a STREAM.CREATE would let api become the
 * bucket's creator on an api-first boot and pin its replica count for the life
 * of the cluster -- which is why the attach is `bindOnly`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const VALUES = fileURLToPath(new URL("../../../deploy/nats-values.yaml", import.meta.url));

/** The publish allow-list of one user block, as written subjects. */
function publishAllowList(user: string): string[] {
  const lines = readFileSync(VALUES, "utf8").split("\n");
  const start = lines.findIndex((l) => l.trim() === `- user: ${user}`);
  assert.notEqual(start, -1, `no '- user: ${user}' block in nats-values.yaml`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\s*- user: /.test(l));
  const block = end === -1 ? rest : rest.slice(0, end);

  const publishAt = block.findIndex((l) => l.trim() === "publish:");
  assert.notEqual(publishAt, -1, `user '${user}' declares no publish permissions`);
  const subscribeAt = block.findIndex((l, i) => i > publishAt && l.trim() === "subscribe:");
  const publish = block.slice(publishAt, subscribeAt === -1 ? block.length : subscribeAt);

  return publish
    .map((l) => /^\s*- "(.+)"\s*$/.exec(l)?.[1])
    .filter((s): s is string => s !== undefined);
}

const REQUIRED_READ_SUBJECTS = [
  "$JS.API.STREAM.INFO.KV_DAG_HANDLES",
  "$JS.API.DIRECT.GET.KV_DAG_HANDLES",
  "$JS.API.DIRECT.GET.KV_DAG_HANDLES.>",
  "$JS.API.STREAM.MSG.GET.KV_DAG_HANDLES",
  "$JS.API.CONSUMER.CREATE.KV_DAG_HANDLES",
  "$JS.API.CONSUMER.CREATE.KV_DAG_HANDLES.>",
  "$JS.API.CONSUMER.INFO.KV_DAG_HANDLES.>",
  "$JS.API.CONSUMER.MSG.NEXT.KV_DAG_HANDLES.>",
  // kv.keys() builds an ordered ephemeral consumer per sweep and tears it down
  // in a bare .catch(); without DELETE each census leaks one.
  "$JS.API.CONSUMER.DELETE.KV_DAG_HANDLES.>",
  // Without flow control kv.keys() stops yielding under backpressure, silently,
  // which reads as a fleet that shrank rather than a read that failed.
  "$JS.FC.KV_DAG_HANDLES.>",
];

test("the api user can read the DAG handle bucket its census depends on", () => {
  const allowed = new Set(publishAllowList("api"));
  const missing = REQUIRED_READ_SUBJECTS.filter((s) => !allowed.has(s));

  assert.deepEqual(missing, [],
    "the sandbox census attaches to DAG_HANDLES; these subjects are denied");
});

test("the api user cannot write the DAG handle bucket", () => {
  const forbidden = publishAllowList("api").filter((s) =>
    s.startsWith("$KV.DAG_HANDLES.")
    || s.startsWith("$JS.API.STREAM.CREATE.KV_DAG_HANDLES")
    || s.startsWith("$JS.API.STREAM.UPDATE.KV_DAG_HANDLES"));

  assert.deepEqual(forbidden, [], "the census is read-only; api must not create or write this bucket");
});

test("brain keeps the write access api is denied", () => {
  const allowed = new Set(publishAllowList("brain"));

  assert.ok(allowed.has("$KV.DAG_HANDLES.dag-handles.*"),
    "brain writes the DAG handle rows the census reads");
});
