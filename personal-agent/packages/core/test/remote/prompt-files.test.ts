// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A prompt's files go on the wire as base64 (`prompt.files[].data`), whatever their size.
import assert from "node:assert/strict";
import { test } from "node:test";

import { base64Of } from "../../src/remote/prompt.js";

test("base64 of the bytes, the same as Node's, across the chunks it is built in", () => {
  for (const size of [0, 1, 2, 3, 0x8000 - 1, 0x8000, 0x8000 * 3 + 7]) {
    const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 131 + 7) % 256);
    assert.equal(base64Of(bytes), Buffer.from(bytes).toString("base64"), String(size));
  }
});
