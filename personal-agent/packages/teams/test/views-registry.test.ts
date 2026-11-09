// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { RENDERERS, renderView, type Renderers } from "../src/views/index.js";

test("a view is shown by the renderer of its name, with its model", () => {
  // (no feature has declared a view yet in this package's build; a stand-in map is enough to see the dispatch)
  const renderers = {
    demo: (model: { words: string }) => ({ type: "message", text: model.words }),
  } as unknown as Renderers;
  const view = { name: "demo", model: { words: "hello" } } as unknown as Parameters<typeof renderView>[1];
  assert.deepEqual(renderView(renderers, view), { type: "message", text: "hello" });
  assert.equal(typeof RENDERERS, "object");
});
