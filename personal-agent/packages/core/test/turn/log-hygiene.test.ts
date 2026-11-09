// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A failed Claw call never puts what Claw answered into the log (test_log_hygiene.py, the turn's side): Claw, or a proxy
 * in front of it, can echo the request back in its error body, with the person's message and key in it.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { ClawError } from "../../src/claw/errors.js";
import { play } from "./play.js";
import type { World } from "./world.js";

const MESSAGE_MARK = "PLAIN-MESSAGE-MARK-5521";
const SAFE_KEY = ["ak", "q7Lm2Xv9Rt4Bn8Wc3Yp6"].join("-"); // the key the user linked (no key literal in the source)
const b64url = (raw: string): string => Buffer.from(raw).toString("base64url");
const JWT = [b64url('{"alg":"RS256"}'), b64url('{"sub":"teams"}'), b64url("signature-value-here")].join(".");
const BEARER = `Bearer ${JWT}`;
/** What Claw answers a failed call with: the request echoed back, as a validation error does. */
const ECHO_BODY = JSON.stringify({
  ok: false,
  error: "internal_error",
  detail: `cannot handle ${MESSAGE_MARK} for ${SAFE_KEY} (Authorization: ${BEARER})`,
});

/** Everything the turn logged or kept back for the log. */
function logs(w: World): string {
  return `${w.log.text()}\n${JSON.stringify(w.errors.withheld)}`;
}

function assertClean(text: string, ...markers: string[]): void {
  for (const marker of markers) assert.ok(!text.includes(marker), `${marker} reached the log:\n${text}`);
}

it("test_a_refused_send_does_not_log_the_body_claw_answered", async () => {
  const run = await play([], {
    request: { key: SAFE_KEY, text: `${MESSAGE_MARK} hello` },
    sessionId: "s1",
    setUp: (w) => {
      w.claw.failSendWith = new ClawError(500, ECHO_BODY);
    },
  });
  assert.ok(
    run.claw.calls.some(
      (c) => c[0] === "send" && c[1] === SAFE_KEY && c[2] === "s1" && c[3] === `${MESSAGE_MARK} hello`,
    ),
  );
  assert.ok(run.texts.length > 0); // refused, and the user was told
  assertClean(logs(run), MESSAGE_MARK, SAFE_KEY, JWT);
});

it("test_a_dropped_stream_logs_its_status_not_the_body", async () => {
  const run = await play([], {
    request: { key: SAFE_KEY, text: `${MESSAGE_MARK} hello` },
    setUp: (w) => {
      w.claw.scripts = () => new ClawError(502, ECHO_BODY);
    },
  });
  const text = logs(run);
  assertClean(text, MESSAGE_MARK, SAFE_KEY, JWT);
  const dropped = run.log.lines.filter((l) => l.message === "claw stream dropped");
  assert.ok(dropped.length > 0, text);
  assert.ok(
    dropped.every((l) => l.fields["error"] === "Claw returned 502 (internal_error)"),
    text,
  );
});
