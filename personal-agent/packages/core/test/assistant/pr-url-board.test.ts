// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A review asked of someone else, as the board lists it (`askedLine`): owner/repo#N only when Claw's pr_url is exactly a pull
 * request's address, else the item's id; a value that only starts like one could carry a link or a line of its own. The cases are
 * the Python worker's, line for line.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { askedLine } from "../../src/assistant/work-items.js";
import { askerView } from "../../../../test-support/card-catalog/assistant.js";

const BOARD_CASES: readonly (readonly [string, string])[] = [
  ["https://github.com/AMD-AGI/PrimusClaw/pull/7", "AMD-AGI/PrimusClaw#7"],
  ["https://github.com/AMD-AGI/PrimusClaw/pull/7\nhttps://evil.example", "kwi_9"],
  ["https://github.com/AMD-AGI/PrimusClaw/pull/7 [x](https://evil.example)", "kwi_9"],
  ["[click](https://evil.example)", "kwi_9"],
  ["https://github.com/AMD-AGI/PrimusClaw/pull/7/files", "kwi_9"],
  ["https://github.com]/o/r/pull/1", "kwi_9"],
  ["https://github.com/o/r/pull/x", "kwi_9"],
  ["", "kwi_9"],
];

it("the board names a pull request only from an exact address, case for case as python", () => {
  for (const [prUrl, starts] of BOARD_CASES) {
    const line = askedLine({
      itemId: "kwi_9",
      reviewer: "Lin Mei",
      view: askerView({ itemId: "kwi_9", status: "in_progress", prUrl }),
    });
    assert.ok(line.startsWith(`${starts} (Lin Mei)`), JSON.stringify(line));
    assert.ok(!line.includes("evil.example") && !line.includes("\n"), JSON.stringify(line));
  }
});
