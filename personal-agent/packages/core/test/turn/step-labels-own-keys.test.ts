// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A tool name is Claw's (and the agent's) to choose: a name every object inherits (constructor, __proto__, toString) is no
// entry of the label tables and gets the generic label, as the Python worker's dict lookups give (step_labels.py, run on the
// baseline for these names).
import assert from "node:assert/strict";
import { it } from "node:test";

import { LIVE_HEADER, LiveView } from "../../src/turn/live-view.js";
import { labelFor, lookupLabel } from "../../src/turn/step-labels.js";

const PYTHON: readonly (readonly [string, string])[] = [
  ["constructor", "Working: constructor"],
  ["__proto__", "Working: proto"],
  ["toString", "Working: to string"],
  ["hasOwnProperty", "Working: has own property"],
  ["mcp__assistant__constructor", "Working: assistant constructor"],
  ["mcp__constructor__x", "Working: constructor x"],
  ["mcp__toString__get", "Working: to string get"],
];

it("a tool named like what every object inherits gets the generic label", () => {
  for (const [tool, label] of PYTHON) {
    assert.equal(labelFor(tool).one, label, tool);
    assert.equal(lookupLabel(tool), label, tool);
  }
  assert.equal(labelFor("constructor", undefined, "zh").one, "处理中：constructor");
});

it("a step of such a tool is a running line in the live view, not a crash", () => {
  const view = new LiveView();
  view.apply({ tool: ["constructor", "start"] });
  assert.equal(view.render(), `${LIVE_HEADER}\n\n⏳ Working: constructor`);
  view.apply({ tool: ["constructor", "success"] });
  assert.equal(view.render(), LIVE_HEADER);
});
