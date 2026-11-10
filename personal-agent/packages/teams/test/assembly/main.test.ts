// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The worker does not start without what it needs: one line that says why, and Python's exit statuses. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { main } from "../../src/main.js";

test("the worker does not start when a secret cannot be read", async () => {
  const lines: string[] = [];
  assert.equal(await main({}, (line) => lines.push(line)), 2);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /CRITICAL secrets: .*TEAMS_ENCRYPTION_KEYS.*the worker does not start without them$/);
});

test("a setting that cannot work stops the worker with status 1 and says which", async () => {
  const lines: string[] = [];
  const env = { TEAMS_ENCRYPTION_KEYS: "x".repeat(43) + "=", OUTBOUND_MODE: "true" };
  const status = await main(env, (line) => lines.push(line));
  assert.equal(status, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /CRITICAL the worker does not start: /);
});
