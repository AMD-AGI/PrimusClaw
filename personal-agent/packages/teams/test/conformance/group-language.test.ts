// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A group chat's language on the product path: the Teams worker of the release gate's test entry, Teams activities as Teams
 * posts them, the recording Bot Connector. A person who writes Chinese in their 1:1 chat, whose Teams client is Chinese, adds
 * the bot to a group and asks "help": the group is answered in English, since nothing the group or the message says names
 * another language. Words of their own ("你能做什么") and the group's own setting (`/lang zh`) still pick Chinese, and the 1:1
 * chat keeps the person's language.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { KitChat, SeenMessage } from "../../../../test-support/surface-conformance/driver.js";
import { dmOf, KitRun, person } from "../../../../test-support/surface-conformance/world.js";
import { teamsUnderTest } from "./teams-driver.js";

const BOT = { id: "28:bot", name: "PrimusClaw Assistant" };
const HAN = /\p{Script=Han}/u;

/** Group help, in English and in Chinese (its lead line). */
const HELP_EN = "In a group, @mention";
const HELP_ZH = "在群里先 @";

function isHelp(m: SeenMessage): boolean {
  return m.final && (m.text.includes(HELP_EN) || m.text.includes(HELP_ZH));
}

let run: KitRun | undefined;
const member = person("grouplang");
const dm = dmOf(member);

function r(): KitRun {
  if (run === undefined) throw new Error("the worker did not start");
  return run;
}

/** Teams' activity for the bot being added to a group chat (`conversationUpdate` with the bot in `membersAdded`). */
async function botAdded(group: KitChat, by: { id: string; name: string }): Promise<void> {
  const connector = r().driver.env["TEAMS_GATE_CONNECTOR_URL"] ?? "";
  const answer = await fetch(`${r().baseUrl}/gate/v1/activity`, {
    method: "POST",
    body: JSON.stringify({
      id: `added-${group.id}`,
      type: "conversationUpdate",
      serviceUrl: `${connector}/`,
      channelId: "msteams",
      from: { id: `29:${by.id}`, aadObjectId: by.id, name: by.name },
      recipient: BOT,
      conversation: { id: group.id, conversationType: "groupChat", tenantId: "conformance-tenant", isGroup: true },
      membersAdded: [{ id: BOT.id }],
      channelData: { tenant: { id: "conformance-tenant" } },
    }),
  });
  assert.equal(answer.status, 200, await answer.text());
}

/** `who` asks `text` @mentioning the bot in `group`, from a Chinese Teams client; the help it was answered with. */
async function helpAfter(group: KitChat, who: { id: string; name: string }, text: string): Promise<SeenMessage> {
  const before = r().driver.seen(group).length;
  await r().driver.say(group, who, text, { mentionsBot: true, locale: "zh-CN" });
  return r().shown(group, isHelp, `help for ${JSON.stringify(text)}`, before);
}

describe("group language on Teams", () => {
  before(async () => {
    run = await KitRun.start(teamsUnderTest());
    await run.link(member, dm);
    // he writes Chinese in his 1:1 chat: that is the language he is answered in there
    const asked = run.driver.seen(dm).length;
    await run.driver.say(dm, member, "帮我看看这个测试为什么失败", { locale: "zh-CN" });
    await run.shown(dm, (m) => m.final && m.text.startsWith("Echo: "), "his 1:1 answer", asked);
  });
  after(async () => {
    await run?.stop();
  });

  it("his 1:1 chat answers help in his language", async () => {
    const before = r().driver.seen(dm).length;
    await r().driver.say(dm, member, "help", { locale: "zh-CN" });
    const own = await r().shown(dm, (m) => m.final && m.text.length > 200, "1:1 help", before);
    assert.ok(HAN.test(own.text), own.text);
  });

  it("a person whose 1:1 chat is Chinese gets help in English in a new group, Chinese for a Chinese question", async () => {
    // he adds the bot to a new group: nothing is said for the add itself
    const group: KitChat = { id: "19:grouplang-new@thread.v2", kind: "group" };
    await botAdded(group, member);
    assert.deepEqual(r().driver.seen(group), [], "adding the bot says nothing");

    // "help", the first @mention: the language card (both languages) and help in English
    const help = await helpAfter(group, member, "help");
    assert.ok(help.text.includes(HELP_EN), help.text);
    assert.ok(!HAN.test(help.text), `help in English: ${help.text}`);
    const card = r()
      .driver.seen(group)
      .find((m) => m.text.includes("Which language should I use in this group?"));
    assert.ok(card, "the language card was put to the group");
    assert.deepEqual(
      card.buttons.map((b) => b.title),
      ["中文", "English", "跟随提问者 (Follow the asker)"],
    );

    // the bare mention (the group's introduction) and /help: English too
    for (const text of ["", "/help"]) {
      const said = await helpAfter(group, member, text);
      assert.ok(said.text.includes(HELP_EN) && !HAN.test(said.text), `${JSON.stringify(text)}: ${said.text}`);
    }

    // a question with words of its own is answered in them
    const zh = await helpAfter(group, member, "你能做什么");
    assert.ok(zh.text.includes(HELP_ZH), zh.text);

    // a Chinese question starts a turn told to answer in Chinese; his next message, with no words of its own, one told to
    // answer in English (what he wrote before in the group does not carry over)
    const asked = r().driver.seen(group).length;
    await r().driver.say(group, member, "帮我看看这个 PR", { mentionsBot: true, locale: "zh-CN" });
    const first = await r().shown(
      group,
      (m) => m.final && m.text.startsWith("Echo: "),
      "the Chinese turn's answer",
      asked,
    );
    assert.ok(first.text.includes("[Reply language: Chinese]"), first.text);
    const turned = r().driver.seen(group).length;
    await r().driver.say(group, member, "ok #3", { mentionsBot: true, locale: "zh-CN" });
    const answer = await r().shown(group, (m) => m.final && m.text.startsWith("Echo: "), "the turn's answer", turned);
    assert.ok(answer.text.includes("[Reply language: English]"), answer.text);
  });

  it("a group set to Chinese answers help in Chinese, and his 1:1 chat keeps his language", async () => {
    const chinese: KitChat = { id: "19:grouplang-zh@thread.v2", kind: "group" };
    const set = r().driver.seen(chinese).length;
    await r().driver.say(chinese, member, "/lang zh", { mentionsBot: true, locale: "zh-CN" });
    await r().shown(chinese, (m) => m.text.includes("已改为中文回复"), "the group set to Chinese", set);
    const inChinese = await helpAfter(chinese, member, "help");
    assert.ok(inChinese.text.includes(HELP_ZH), inChinese.text);

    // and his 1:1 chat still answers "help" in his language
    const again = r().driver.seen(dm).length;
    await r().driver.say(dm, member, "help", { locale: "zh-CN" });
    const still = await r().shown(dm, (m) => m.final && m.text.length > 200, "1:1 help again", again);
    assert.ok(HAN.test(still.text), still.text);
  });
});
