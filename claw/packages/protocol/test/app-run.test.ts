// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_RUN_STATES, scrubSecrets, scrubText } from "../src/app-run.js";

test("the states are one closed list both sides import", () => {
  assert.deepEqual([...APP_RUN_STATES], ["provisioning", "starting", "running", "restarting", "finishing", "ended"]);
});

test("scrubText removes a secret everywhere, short ones are left alone", () => {
  const secret = "cmt_0123456789abcdef";
  assert.equal(scrubText(`a ${secret} b ${secret}`, [secret]), "a [redacted] b [redacted]");
  assert.equal(scrubText("password is abc", ["abc"]), "password is abc");
});

test("a secret holding a quote or a backslash is removed in its JSON-escaped form too", () => {
  const secret = 'tok"en\\with-specials-1234';
  const doc = { error: `rejected ${secret}`, nested: { text: `again ${secret}` } };
  const out = scrubSecrets(doc, [secret]);
  assert.ok(!JSON.stringify(out).includes(JSON.stringify(secret).slice(1, -1)));
  assert.ok(!JSON.stringify(out).includes(secret));
  assert.equal(out.error, "rejected [redacted]");
  // The plain-text rule the Brain uses is the same function.
  assert.equal(scrubText(JSON.stringify(doc), [secret]).includes("with-specials"), false);
});
