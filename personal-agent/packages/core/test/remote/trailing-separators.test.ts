// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Trailing slashes come off a folder or an address as Python's rstrip takes them, and in linear time: a `/[/\\]+$/` replace retries
// the run of separators from every position when the text does not end in one (#636 review). The texts are a connector's or
// Claw's (a session's cwd, a root, the console address).
import assert from "node:assert/strict";
import { test } from "node:test";

import { joinPath } from "../../src/remote/conversations.js";
import { placeOf } from "../../src/remote/lines.js";
import { sessionPageUrl } from "../../src/remote/listing.js";

const asIs = (text: unknown): string => String(text);
const RUN = "/".repeat(50_000) + "x";

/** `work`'s result, and that it took well under half a second. */
function quick<T>(work: () => T): T {
  const started = performance.now();
  const result = work();
  const took = performance.now() - started;
  assert.ok(took < 500, `${String(took)} ms`);
  return result;
}

test("a folder's last part is read as python reads it, in linear time", () => {
  assert.deepEqual(
    ["/home/me/repo/", "C:\\work\\x\\", "///", "/a//b//"].map((cwd) => placeOf(cwd, asIs)),
    ["repo", "x", "", "b"],
  );
  assert.equal(
    quick(() => placeOf(RUN, asIs)),
    "x",
  );
});

test("a root joins a subfolder as python joins them, in linear time", () => {
  assert.equal(joinPath("/r/", "s"), "/r/s");
  assert.equal(
    quick(() => joinPath(RUN, "s")),
    RUN + "/s",
  );
});

test("the console's page of a session is built as python builds it, in linear time", () => {
  assert.equal(sessionPageUrl("https://c.x//"), "https://c.x/primus-claw/agent-sessions");
  quick(() => sessionPageUrl("https://c.x" + RUN));
});
