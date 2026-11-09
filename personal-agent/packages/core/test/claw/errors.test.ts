// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ClawAnswerInvalid,
  ClawError,
  ClawUnreachable,
  CredentialMisuse,
  ReplayRefused,
  ReviewsRefused,
  errorCodeOf,
  errorKind,
  isApiKey,
  isErrorWord,
  notAClawId,
} from "../../src/index.js";

describe("ClawError", () => {
  it("says the status and Claw's error word, never the rest of the body", () => {
    const err = new ClawError(409, '{"ok":false,"error":"sandbox_not_running","message":"key ak-secret"}');
    assert.equal(err.message, "Claw returned 409 (sandbox_not_running)");
    assert.equal(err.code, "sandbox_not_running");
    assert.equal(err.status, 409);
    assert.equal(err.name, "ClawError");
  });

  it("reads the error word of a body cut mid-JSON, and only a plain word", () => {
    assert.equal(
      errorCodeOf('{"ok": false, "error": "connector_outdated", "data": {"version": "0.1'),
      "connector_outdated",
    );
    assert.equal(errorCodeOf('{"ok": false, "error": "Has Spaces", "da'), "");
    assert.equal(errorCodeOf("<html>bad gateway"), "");
  });

  it("does not repeat an error that is not a word", () => {
    assert.equal(new ClawError(400, '{"ok":false,"error":"no such thing: ak-123"}').message, "Claw returned 400");
    assert.equal(new ClawError(502).message, "Claw returned 502");
  });

  it("reads only an object's error", () => {
    assert.equal(errorCodeOf("[1]"), "");
    assert.equal(errorCodeOf("null"), "");
    assert.equal(errorCodeOf('{"error": null}'), "");
    assert.equal(errorCodeOf('{"error": false}'), "");
    assert.equal(errorCodeOf('{"error": 0}'), "");
    assert.equal(errorCodeOf('{"error": 7}'), "7");
    assert.equal(errorCodeOf('{"error": {"a": 1}}'), '{"a":1}');
  });

  it("refuses a non-id as Claw refuses an id that is not the caller's", () => {
    const err = notAClawId();
    assert.equal(err.status, 404);
  });

  it("keeps a refusal of reviews whole", () => {
    const err = new ReviewsRefused(429, "too_many_reviews", "Too many.", { limit: 5 });
    assert.ok(err instanceof ClawError);
    assert.equal(err.code, "too_many_reviews");
    assert.equal(err.said, "Too many.");
    assert.deepEqual(err.data, { limit: 5 });
    assert.equal(err.name, "ReviewsRefused");
  });
});

describe("errorKind", () => {
  it("is the status for Claw's errors and only the type for anything else", () => {
    assert.equal(errorKind(new ClawError(404, '{"error":"not_found"}')), "Claw returned 404 (not_found)");
    assert.equal(errorKind(new TypeError("fetch failed https://host/?token=x")), "TypeError");
    assert.equal(errorKind(new ClawUnreachable("timeout", "changes")), "ClawUnreachable");
    assert.equal(errorKind(new ReplayRefused("too large")), "ReplayRefused");
    assert.equal(errorKind(new ClawAnswerInvalid("not a list")), "ClawAnswerInvalid");
    assert.equal(errorKind(new CredentialMisuse("ak")), "CredentialMisuse");
    assert.equal(errorKind("text"), "string");
  });

  it("says which way Claw was not reached", () => {
    assert.equal(new ClawUnreachable("network", "x").kind, "network");
    assert.match(new ClawUnreachable("timeout", "x").message, /in time/);
    assert.match(new ClawUnreachable("network", "x").message, /not reached/);
  });
});

describe("error words and credentials", () => {
  it("knows a plain error word", () => {
    assert.equal(isErrorWord("connector_outdated"), true);
    assert.equal(isErrorWord("Connector"), false);
    assert.equal(isErrorWord("a".repeat(65)), false);
  });

  it("tells an API key from a token", () => {
    assert.equal(isApiKey("ak-123"), true);
    assert.equal(isApiKey("eyJ.x.y"), false);
  });
});
