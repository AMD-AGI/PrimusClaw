// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lineLogger } from "../src/index.js";

const PASTED_KEY = "ak-" + "Pasted1x2y3z4w5v6u7t";
const BEARER = "Bearer " + "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJlLXZhbHVl";
const TEMPAUTH = "v1." + "eyJzaXRlaWQiOiJhYmMiLCJhdWQiOiJ4In0" + ".Zm9vYmFyU2lnbmF0dXJlMTIz";

function capture() {
  const lines: string[] = [];
  const log = lineLogger({ level: "debug", write: (l) => lines.push(l), now: () => Date.UTC(2026, 10, 9, 12, 0, 0) });
  return { lines, log };
}

describe("the worker log", () => {
  it("masks credential shapes in the message and in every field", () => {
    const { lines, log } = capture();
    log.child({ upstream: `Authorization: ${BEARER}` }).error(`a library failed for ${PASTED_KEY}`, {
      error: "RuntimeError",
    });
    const line = lines[0] ?? assert.fail("no line");
    assert.ok(line.includes("a library failed for [hidden]") && line.includes("error=RuntimeError"));
    assert.ok(!line.includes(PASTED_KEY) && !line.includes("eyJhbGci"));
  });

  it("keeps ordinary lines as they are", () => {
    const { lines, log } = capture();
    log.info("turn t-1 finished", { seconds: 2.5 });
    assert.deepEqual(lines, ["2026-11-09T12:00:00.000Z INFO turn t-1 finished seconds=2.5"]);
  });

  it("masks credential query parameters whatever their shape", () => {
    const { lines, log } = capture();
    log.info("HTTP request", { url: `https://files.example.test/d.aspx?UniqueId=1b2c3d&tempauth=${TEMPAUTH}&v=2` });
    const line = lines[0] ?? assert.fail("no line");
    assert.ok(line.includes("tempauth=[hidden]&v=2") && !line.includes(TEMPAUTH));
    assert.ok(line.includes("UniqueId=1b2c3d"));
  });
});
