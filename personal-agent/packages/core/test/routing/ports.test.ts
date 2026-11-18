// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import "../../src/routing/features.js";
import "../../src/routing/turn-runner.js";
import { AGENT_USAGE, commandText } from "../../src/locales/commands.js";
import { routingText } from "../../src/locales/routing.js";
import {
  noRouteHandlers,
  type ClickHandler,
  type CommandHandler,
  type MessageInterceptor,
} from "../../src/ports/routing.js";

test("a router given no handlers has none of each kind", () => {
  assert.deepEqual(noRouteHandlers, { personalInterceptors: [], groupInterceptors: [], commands: [], clicks: [] });
  const interceptor: MessageInterceptor = { name: "x", intercept: () => Promise.resolve(false) };
  const command: CommandHandler = { name: "brief", run: () => Promise.resolve(true) };
  const click: ClickHandler = { verbs: ["onboard"] };
  assert.equal(interceptor.name + command.name + click.verbs.join(), "xbriefonboard");
});

test("every command text and every fixed reply exists in both languages", () => {
  for (const catalog of [commandText, routingText]) {
    const en = catalog.in("en");
    const zh = catalog.in("zh");
    assert.deepEqual(Object.keys(zh), Object.keys(en));
    for (const value of [...Object.values(en), ...Object.values(zh)])
      assert.ok(typeof value === "string" ? value !== "" : typeof value === "function" && value({ n: 2 }) !== "");
  }
  assert.ok(commandText.in("zh").repoUsage.startsWith("用法：") && commandText.in("en").repoUsage.startsWith("Use "));
  assert.ok(AGENT_USAGE.startsWith("Your agents on your own machines") && AGENT_USAGE.includes("/agent pair"));
});
