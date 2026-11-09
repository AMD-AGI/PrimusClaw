// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Feedback's cards against the Python worker's snapshots. Both sides are written as `json.dumps(indent=1, sort_keys=True)`
 * writes them, so the comparison is the bytes the Python test compares, whatever layout the snapshot file has here.
 * (These four join the shared catalog, `test-support/card-catalog`, once its snapshot test reads them that way.)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { pyJsonDumps, type ViewMap } from "@primusclaw/personal-agent";

import { RENDERERS, renderView } from "../../src/views/index.js";
import { FEEDBACK_CARDS } from "../../../../test-support/card-catalog/feedback.js";

const SNAPSHOTS = new URL("../../../../test-support/data/card_snapshots/", import.meta.url);

function python(value: unknown): string {
  return pyJsonDumps(value, { indent: 1, sortKeys: true });
}

for (const entry of FEEDBACK_CARDS) {
  test(`feedback card matches its snapshot: ${entry.id}`, () => {
    const snapshot: unknown = JSON.parse(readFileSync(new URL(`${entry.id}.json`, SNAPSHOTS), "utf8"));
    assert.equal(python(entry.build()), python(snapshot));
  });
}

test("a report card in a group says only the asker can use it", () => {
  const card = python(renderView(RENDERERS, { name: "feedbackReport", model: { promptId: "p-2", group: true } }));
  assert.ok(
    card.includes(
      "💬 Did something go wrong? You can tell the PrimusClaw team. Only the person who asked can use this button.",
    ),
  );
  assert.ok(card.includes('"prompt": "p-2"'));
});

test("the offer after a failed yes is a note under the question with yes and no again", () => {
  const model: ViewMap["feedbackOfferRetry"] = { offerId: "off-2", issueNumber: 7, note: "Press Yes again." };
  const card = renderView(RENDERERS, { name: "feedbackOfferRetry", model });
  const text = python(card);
  assert.ok(text.includes('"text": "🔔 Add your last question and my answer to #7?"'));
  assert.ok(text.includes('"text": "Press Yes again."'));
  assert.equal((text.match(/"offer": "off-2"/g) ?? []).length, 2);
});
