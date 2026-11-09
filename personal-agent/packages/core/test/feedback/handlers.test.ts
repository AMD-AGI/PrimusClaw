// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { DailyBrief, Observer, w8RouteHandlers } from "@primusclaw/personal-agent";

import { observeWorld } from "../observe/world.js";
import { linkedWorld } from "./world.js";

test("the router gets feedback first in a 1:1 chat and observe before feedback in a group", () => {
  const world = linkedWorld();
  const observer: Observer = observeWorld().observer;
  const brief = new DailyBrief({
    enabled: false,
    links: world.store.links,
    prefs: world.store.prefs,
    triggers: {
      list: () => Promise.resolve([]),
      create: () => Promise.resolve({}),
      update: () => Promise.resolve({}),
      delete: () => Promise.resolve(),
    },
    assistant: { brief: () => Promise.resolve({}) },
    assistantOn: () => false,
    briefMarkdown: () => "",
    log: world.log,
  });
  const handlers = w8RouteHandlers({ flow: world.flow, thumbs: world.thumbs, observer, brief });
  assert.deepEqual(
    handlers.personalInterceptors.map((i) => i.name),
    ["feedback"],
  );
  assert.deepEqual(
    handlers.groupInterceptors.map((i) => i.name),
    ["observe", "feedback"],
  );
  assert.deepEqual(
    handlers.commands.map((c) => c.name),
    ["brief"],
  );
  assert.deepEqual(
    handlers.clicks.map((c) => c.verbs),
    [["report", "feedback"], ["thumb", "thumb_note"], ["observe"]],
  );
});
