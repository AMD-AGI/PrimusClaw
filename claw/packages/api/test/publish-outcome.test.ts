// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Telling "the publish failed" apart from "the publish might have worked".
 *
 * A JetStream publish is a request and a reply. The message goes out, the
 * server stores it, and the ack comes back -- and a timeout is a statement
 * about the ack, not about the message. The stream may be holding it.
 *
 * That distinction did not matter while a failed publish was simply retried
 * with a fresh identity. It matters now that the replay republishes under the
 * queued row's id, because the stream drops the second copy of a message it
 * already has: the first copy runs, against the run row the first attempt
 * opened. A caller that tore that row down on its way out leaves a healthy
 * worker to be refused on its first heartbeat, and the turn is lost rather
 * than merely repeated -- the failure the id was added to prevent, reached
 * from the other side.
 *
 * So the two guesses are not symmetric, and this refuses to guess: certain
 * only when the server answered, and everything else is unknown.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { publishCertainlyFailed } from "../src/infra/nats.js";

test("nobody answered, so nothing was stored", () => {
  // 503 is no responders: the request never reached a JetStream server.
  assert.equal(publishCertainlyFailed(Object.assign(new Error("no responders"), {
    code: "503",
  })), true);
});

test("the server declined, and said why", () => {
  // An api_error is the server refusing the message -- wrong stream, subject
  // that maps nowhere. It answered, so the answer is certain.
  assert.equal(publishCertainlyFailed(Object.assign(new Error("no stream matches"), {
    code: "404",
    api_error: { code: 404, err_code: 10060, description: "no stream matches subject" },
  })), true);
});

test("a timeout is not an answer", () => {
  // The one that used to be treated as failure. The message may be on the
  // stream with only its ack lost, and acting on the guess loses a turn.
  assert.equal(publishCertainlyFailed(Object.assign(new Error("TIMEOUT"), {
    code: "TIMEOUT",
  })), false);
});

test("a connection that went away mid-request is not an answer either", () => {
  assert.equal(publishCertainlyFailed(new Error("CONNECTION_CLOSED")), false);
});

test("nothing at all is not an answer", () => {
  assert.equal(publishCertainlyFailed(null), false);
  assert.equal(publishCertainlyFailed(undefined), false);
});
