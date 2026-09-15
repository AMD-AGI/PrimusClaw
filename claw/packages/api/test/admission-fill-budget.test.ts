// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What bounds one admission pass, with no database in the way.
 *
 * The paging fill is the only thing standing between a saturated ceiling and
 * the fleet-wide admission lock: every caller's page is exactly `want` rows
 * wide, so the short-page exit is not reached while rows keep coming, and a
 * ceiling that fits nothing rejects every one of them. Without a budget the
 * pass reads the whole backlog before it lets the lock go, and creation,
 * retry, expansion and hand-off wait behind it for the length of the queue.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import { fillWithinCeiling, resetFillResumeForTest } from "../src/tasks/admission.js";

beforeEach(() => { resetFillResumeForTest(); });

/**
 * A page source that is always full, the way every real caller's is.
 *
 * It refuses rather than looping forever once a pass has read more than any
 * budget should let it: an unbounded fill would otherwise hang the run instead
 * of naming what it did.
 */
function endlessPages(want: number, fitsAt: number | null) {
  let pages = 0;
  const source = {
    get pages() { return pages; },
    page: async (skip: string[], from = 0) => {
      assert.ok(skip.length < 10_000, "the fill read the whole backlog");
      pages++;
      return Array.from({ length: want }, (_, i) => ({ id: `t-${from + skip.length + i}` }));
    },
    fits: (row: { id: string }) =>
      fitsAt !== null && row.id === `t-${fitsAt}`,
    idOf: (row: { id: string }) => row.id,
  };
  return source;
}

test("a pass over a queue nothing fits gives the lock back instead of draining it", async () => {
  const source = endlessPages(8, null);
  const accepted = await fillWithinCeiling({
    page: source.page, fits: source.fits, idOf: source.idOf, want: 8,
  });
  assert.deepEqual(accepted, [], "a saturated ceiling accepts nothing");
  assert.ok(source.pages > 1, `one page is not paging past anything, got ${source.pages}`);
  assert.ok(source.pages <= 64, `the pass kept reading, ${source.pages} pages in`);
});

test("a row that fits behind a prefix that does not is still reached", async () => {
  // The property admission-drain-gates.test.ts protects against a database,
  // asserted here against the budget: a blocked prefix is paged past, not
  // treated as the end of the queue.
  const source = endlessPages(8, 100);
  const accepted = await fillWithinCeiling({
    page: source.page, fits: source.fits, idOf: source.idOf, want: 1,
  });
  assert.deepEqual(accepted, [{ id: "t-100" }]);
});

test("consecutive passes read further, so a blocked prefix is not re-read for ever", async () => {
  // The budget alone would be starvation, not delay: every pass starts with an
  // empty skip list, so a prefix longer than the budget is re-read from the top
  // on every tick and the row behind it is never reached at all. The resume
  // point is what turns the bound into progress.
  const source = endlessPages(8, null);
  const opts = {
    page: source.page, fits: source.fits, idOf: source.idOf, want: 1,
    resume: "test_queue",
  };
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await fillWithinCeiling(opts), [], `pass ${i} accepted something`);
  }
  // Three bounded passes have read past 1536, which the first pass -- capped at
  // 512 -- could not reach, and which every pass would still be short of if
  // each one began at the head.
  assert.deepEqual(
    await fillWithinCeiling({ ...opts, fits: (row) => row.id === "t-1600" }),
    [{ id: "t-1600" }],
    "the resume point did not advance across passes",
  );
});

test("without a resume name every pass re-reads the same prefix", async () => {
  // The property the fix is measured against: this is what the budget alone
  // does, and it is why the resume point exists.
  const source = endlessPages(8, null);
  const opts = { page: source.page, fits: source.fits, idOf: source.idOf, want: 1 };
  for (let i = 0; i < 3; i++) assert.deepEqual(await fillWithinCeiling(opts), []);
  assert.deepEqual(
    await fillWithinCeiling({ ...opts, fits: (row) => row.id === "t-1600" }),
    [],
    "an unnamed caller must keep starting at the head",
  );
});

test("a pass that reaches the end of the queue forgets where it stopped", async () => {
  // Otherwise the offset walks away from a backlog that has since drained and
  // the head of the queue stops being read at all.
  let from = -1;
  const opts = {
    page: async (_skip: string[], f = 0) => { from = f; return []; },
    fits: () => true,
    idOf: (row: { id: string }) => row.id,
    want: 1,
    resume: "drains",
  };
  const blocked = endlessPages(8, null);
  await fillWithinCeiling({
    page: blocked.page, fits: blocked.fits, idOf: blocked.idOf, want: 1, resume: "drains",
  });
  await fillWithinCeiling(opts);
  assert.ok(from > 0, "the drained pass did not resume from the budgeted one");
  await fillWithinCeiling(opts);
  assert.equal(from, 0, "a drained queue is read from the head again");
});
