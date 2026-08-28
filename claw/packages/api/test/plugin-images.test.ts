// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A plugin offers one repo per framework, and the dispatch chain has to turn
 * that list into the single image a sandbox is created from.
 *
 * The list is the middle rung of `request > plugin > deployment default`, so
 * what this resolves to decides which of the three a run gets. Returning ""
 * means "this plugin offers none", which falls through to the default -- and
 * that is why an entry with no repo has to be skipped rather than treated as
 * the end of the list. Stopping at the first hole would hide every repo behind
 * it, and hide it as a fall through to the default: a run on the wrong image,
 * with nothing anywhere saying so.
 *
 * Two paths read a plugin row, and both have to resolve the list the same way.
 * The message path goes through formatPluginRow; the task/DAG and workbench
 * paths select the row themselves and hand a single `image` to dag-expander.
 * A path left on the old column reads '' for every plugin registered after the
 * migration, and '' falls through to the deployment default -- so the two paths
 * would disagree about which image a plugin means, silently.
 *
 * Coverage:
 *   I1 the first usable entry wins
 *   I2 an entry with no usable repo is a hole, not the end of the list
 *   I3 nothing usable, and nothing shaped like a list, resolve to ""
 *   I4 formatPluginRow surfaces the column as a list whatever the row holds
 *   I5 no path is left reading the retired column
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { formatPluginRow, pluginSandboxImage } from "../src/marketplace/plugins.js";

// I1
test("the first usable entry is the image", () => {
  assert.equal(
    pluginSandboxImage([
      { repo: "harbor.example/sglang:v1", framework: "sglang" },
      { repo: "harbor.example/vllm:v1", framework: "vllm" },
    ]),
    "harbor.example/sglang:v1",
  );
  assert.equal(pluginSandboxImage([{ repo: "  harbor.example/a:v1  " }]), "harbor.example/a:v1");
});

// I2 — the case the positional shorthand `images[0].repo` gets wrong.
test("an entry without a usable repo is skipped, not taken as the end", () => {
  const second = "harbor.example/vllm:v1";
  for (const hole of [
    { repo: "", framework: "sglang" },
    { repo: "   ", framework: "sglang" },
    { framework: "sglang" },
    null,
    undefined,
    "not-an-object",
    ["not-an-object"],
  ]) {
    assert.equal(
      pluginSandboxImage([hole, { repo: second, framework: "vllm" }]),
      second,
      `${JSON.stringify(hole)} should have been skipped`,
    );
  }
});

// I3
test("nothing usable resolves to the empty string, which is the fall through", () => {
  // The deployment default is reached through "", so each of these has to
  // produce exactly that rather than throwing on a row shaped unexpectedly.
  for (const nothing of [
    [],
    [{ repo: "" }, { repo: "   " }, {}],
    undefined,
    null,
    "not-a-list",
    42,
    { repo: "an object is not a list of them" },
  ]) {
    assert.equal(pluginSandboxImage(nothing), "", `${JSON.stringify(nothing)} offers no image`);
  }
});

// I4
test("formatPluginRow always surfaces images as a list", async () => {
  const row = { id: 1, name: "p", version: "1.0.0", tools: [], resource: {} };

  const withList = await formatPluginRow({ ...row, images: [{ repo: "harbor.example/a:v1" }] });
  assert.deepEqual(withList.images, [{ repo: "harbor.example/a:v1" }]);

  // A row written before the column existed reads back as null; consumers call
  // pluginSandboxImage on this value, so it has to be a list either way.
  for (const stored of [null, undefined, "not-a-list", { repo: "not-a-list" }]) {
    const out = await formatPluginRow({ ...row, images: stored });
    assert.deepEqual(out.images, [], `images=${JSON.stringify(stored)} should surface as []`);
    assert.equal(pluginSandboxImage(out.images), "");
  }
});

// I5 — the message path and the task/workbench paths select the row separately,
// and a path still naming the retired column resolves '' for every plugin
// registered after the migration. Asserted over the source because what is
// wrong is a query, and a query that selects the wrong column still returns a
// row: there is no value these paths could be handed that would fail.
test("no path selects or reads the retired image column", () => {
  const src = (rel: string) =>
    readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf-8");

  for (const rel of ["routes/tasks.ts", "workbenches/registry.ts"]) {
    const text = src(rel);
    assert.match(text, /pluginSandboxImage\(row\.images\)/, `${rel} must resolve through the list`);
    assert.doesNotMatch(
      text,
      /\bimage\b(?=[^\n]*FROM plugins)|String\(row\.image\b/,
      `${rel} must not name the retired column`,
    );
  }

  // The three message-path call sites resolve through the formatted row.
  for (const rel of ["sessions/dispatch.ts", "events/consumer.ts", "routes/a2a.ts"]) {
    assert.match(
      src(rel),
      /pluginSandboxImage\(formatted\.images\)/,
      `${rel} must resolve through the list`,
    );
  }
});
