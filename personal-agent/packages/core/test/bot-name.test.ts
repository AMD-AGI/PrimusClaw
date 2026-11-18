// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The bot goes by the name its deployment gives it (PERSONAL_AGENT_BOT_NAME, `RouterConfig.botName`), and by the default name
 * when none is given: help, a group's `/context`, the way back from an attached agent, and the words "back to <name>" all say
 * the one name, never another.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { contextInterceptor, DEFAULT_GROUP_CONTEXT, GroupContext, naturalCommand } from "@primusclaw/personal-agent";

import { openTestStore } from "../../../test-support/index.js";
import { BOT_NAME } from "../src/branding.js";
import { groupAsked, link, message, said, silent, world } from "./routing/world.js";
import { ALICE } from "./routing/fixtures.js";

const NAMES = [BOT_NAME, "Robin Bot"] as const;
const OTHERS = (name: string): string[] => ["Clawy", BOT_NAME, "Robin Bot"].filter((n) => n !== name);

function named(name: string) {
  const testStore = openTestStore();
  const context = new GroupContext({
    settings: { ...DEFAULT_GROUP_CONTEXT, granted: true },
    clock: testStore.clock,
    mask: (t) => t,
    off: testStore.store.groupContext,
    log: silent,
  });
  const w = world({
    testStore,
    groupHistory: context,
    config: { botName: name },
    handlers: { groupInterceptors: [contextInterceptor(context, name)] },
  });
  link(w, ALICE.id, "ak-alice");
  groupAsked(w);
  return w;
}

test("the default name is the one no deployment setting changed", () => {
  assert.equal(BOT_NAME, "PrimusClaw Assistant");
});

for (const name of NAMES) {
  test(`help in a 1:1 chat and in a group names the bot ${name}`, async () => {
    const w = named(name);
    await w.router.handle(message("/help"));
    await w.router.handle({
      ...message("/help", { kind: "group", conversation: "g-1" }),
      mentioned: true,
      targeted: false,
    });
    await w.router.settled();
    const [personal = "", group = ""] = said(w);
    assert.ok(personal.includes(`**What ${name} can do for you**`), personal);
    assert.ok(group.includes(`@mention ${name} first`), group);
    for (const other of OTHERS(name)) for (const text of [personal, group]) assert.ok(!text.includes(other), other);
  });

  test(`a group's /context names the bot ${name}`, async () => {
    const w = named(name);
    await w.router.handle({ ...message("/context maybe", { kind: "group" }), mentioned: true, targeted: false });
    await w.router.settled();
    const [usage = ""] = said(w);
    assert.ok(usage.includes(`@${name} /context on | off | status`), usage);
    for (const other of OTHERS(name)) assert.ok(!usage.includes(other), other);
  });

  test(`"back to ${name}" detaches, as the button under an agent's words sends it`, () => {
    assert.equal(naturalCommand(`back to ${name}`, false, new Set(), name), "/agent detach");
    assert.equal(naturalCommand(`回到 ${name}`, false, new Set(), name), "/agent detach");
  });
}

test("the buttons of cards sent under the earlier and the default name still take the chat back", () => {
  for (const words of ["back to Clawy", "回到 Clawy", "back to PrimusClaw Assistant"]) {
    assert.equal(naturalCommand(words, false, new Set(), "Robin Bot"), "/agent detach", words);
  }
  assert.equal(naturalCommand("back to Robin Bot"), "back to Robin Bot"); // (another deployment's name is just words)
});
