// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorkloadListPage } from "../src/sandbox/multi-node/workload-parse.js";

test("parseWorkloadListPage reads id/phase/kind out of a SaFE list response", () => {
  // Verbatim shape of GET /api/v1/workloads: the session sweep needs the kind to
  // tell a GPU cluster from the session's own sandbox.
  const body = {
    totalCount: 2,
    items: [
      {
        workloadId: "claw-1785495315218",
        phase: "Running",
        groupVersionKind: { version: "v1", kind: "RayJob" },
        displayName: "claw-1785495315218-ray",
      },
      {
        workloadId: "claw-1785495342932-sandbox-sph67",
        phase: "Pending",
        groupVersionKind: { version: "v1", kind: "Sandbox" },
      },
    ],
  };

  assert.deepStrictEqual(parseWorkloadListPage(body), {
    items: [
      { id: "claw-1785495315218", phase: "running", kind: "RayJob" },
      { id: "claw-1785495342932-sandbox-sph67", phase: "pending", kind: "Sandbox" },
    ],
    totalCount: 2,
  });
});

test("parseWorkloadListPage tolerates a workload whose phase/kind are not set yet", () => {
  const page = parseWorkloadListPage({ items: [{ workloadId: "w1" }] });
  assert.deepStrictEqual(page?.items, [{ id: "w1", phase: "", kind: "" }]);
});

test("parseWorkloadListPage skips entries it cannot address", () => {
  const page = parseWorkloadListPage({ items: [{ phase: "Running" }, {}, null, 7] });
  assert.deepStrictEqual(page?.items, []);
  // The count still reflects what the page carried, so the caller can tell that
  // four entries were dropped rather than that the session owns nothing.
  assert.equal(page?.totalCount, 4);
});

test("an empty list is a list; an unrecognised body is not", () => {
  // The distinction session teardown depends on: only the first proves that the
  // session owns no clusters.
  assert.deepStrictEqual(parseWorkloadListPage({ totalCount: 0, items: [] }), {
    items: [],
    totalCount: 0,
  });

  for (const body of [{}, null, undefined, [], "not json", 42, { data: { items: [] } }]) {
    assert.equal(parseWorkloadListPage(body), null, `body=${JSON.stringify(body)}`);
  }
});

test("a server count beyond the page is preserved so truncation is detectable", () => {
  // SaFE reports 250 matches but the sweep asks for one page; the caller must be
  // able to see that it did not get everything.
  const page = parseWorkloadListPage({ totalCount: 250, items: [{ workloadId: "w1" }] });
  assert.equal(page?.items.length, 1);
  assert.equal(page?.totalCount, 250);
});

test("a missing or nonsense count falls back to what the page carried", () => {
  assert.equal(parseWorkloadListPage({ items: [{ workloadId: "w1" }] })?.totalCount, 1);
  assert.equal(parseWorkloadListPage({ totalCount: -3, items: [] })?.totalCount, 0);
  assert.equal(parseWorkloadListPage({ totalCount: "many", items: [] })?.totalCount, 0);
});
