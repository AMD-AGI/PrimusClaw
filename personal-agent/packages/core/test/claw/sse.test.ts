// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SseFrames, parseSseBlock, pyStr, pyStrOr, pyTruthy } from "../../src/index.js";

describe("SSE frames", () => {
  it("a frame's id, name and JSON data; the data's type names a plain message", () => {
    assert.deepEqual(parseSseBlock('id: 7\nevent: chatDelta\ndata: {"text":"a"}'), {
      id: "7",
      name: "chatDelta",
      data: { text: "a" },
    });
    assert.deepEqual(parseSseBlock('event: message\ndata: {"type":"toolUsed"}'), {
      id: "",
      name: "toolUsed",
      data: { type: "toolUsed" },
    });
    assert.equal(parseSseBlock('data: {"type":0}')?.name, "");
    assert.equal(parseSseBlock('data: {"a":\ndata: 1}')?.data["a"], 1);
  });

  it("comments, non-JSON and non-object data are no event", () => {
    assert.equal(parseSseBlock(": keepalive"), null);
    assert.equal(parseSseBlock("data: not json"), null);
    assert.equal(parseSseBlock("data: [1]"), null);
  });

  it("splits a stream into frames as they complete", () => {
    const frames = new SseFrames();
    assert.deepEqual(frames.push('data: {"type":"a"}\r\n\r\ndata: {"ty'), [{ id: "", name: "a", data: { type: "a" } }]);
    assert.deepEqual(frames.push('pe":"b"}\n\n: ping\n\n'), [{ id: "", name: "b", data: { type: "b" } }]);
    assert.deepEqual(frames.push('data: {"type":"c"}'), []);
  });
});

describe("Python's reading of a JSON value", () => {
  it("str() and bool() of what Claw sends", () => {
    assert.deepEqual(["a", 3, true, false, null, undefined, [1, "x"], { a: 1 }].map(pyStr), [
      "a",
      "3",
      "True",
      "False",
      "None",
      "None",
      '[1, "x"]',
      '{"a": 1}',
    ]);
    assert.deepEqual(["", 0, false, null, [], {}, "x", 1, [0], { a: 1 }].map(pyTruthy), [
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
    ]);
    assert.equal(pyStrOr(0), "");
    assert.equal(pyStrOr("m1"), "m1");
  });
});
