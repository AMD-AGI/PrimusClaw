// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Idle reclaim honours a person's open terminal, and only idleness.
 *
 * A shell in a browser terminal is not on the EnvD jobs roster, so the idle
 * clock alone would reclaim a sandbox under it. `confirmReclaim` is the one gate
 * every idle destroy passes, and the claim is read there. Pinned through the
 * source for the same reason as the sibling evidence tests: the decision sits
 * between two I/O calls this package's fakes cannot interleave.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(
  fileURLToPath(new URL("../src/sandbox/keepalive.ts", import.meta.url)),
  "utf8",
);

function bodyOf(name: string): string {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} is gone; this test is about it`);
  const after = SRC.slice(at);
  const end = after.indexOf("\n}\n");
  return after.slice(0, end > 0 ? end : after.length);
}

test("the claim is read before any evidence can authorise an idle destroy", () => {
  const body = bodyOf("confirmReclaim");
  const claim = body.indexOf("readTerminalHold(");
  const decision = body.indexOf("decide(info)");
  assert.ok(claim >= 0, "confirmReclaim reads the terminal claim");
  assert.ok(decision > claim, "and does so before it consults the reclaim decision");
});

test("a held or unreadable claim refuses the destroy; an absent one falls through", () => {
  const body = bodyOf("confirmReclaim");
  const at = body.indexOf("readTerminalHold(");
  const branch = body.slice(at, at + 700);
  assert.match(branch, /term\.state !== "none"/, "unreadable holds like held");
  assert.match(branch, /return false;/, "the destroy is refused");
});

test("only idleness is held back: a replaced instance still reclaims", () => {
  const body = bodyOf("confirmReclaim");
  const at = body.indexOf("readTerminalHold(");
  const before = body.slice(Math.max(0, at - 120), at);
  assert.match(before, /reason === "idle_empty"/);
});
