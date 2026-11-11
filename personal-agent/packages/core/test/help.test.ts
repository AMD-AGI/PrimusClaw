// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Ported from teams/tests/test_capabilities.py: what help looks like (`renderHelp`), and the registry's own shape. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { renderHelp } from "../src/capabilities/help.js";
import { cpLength } from "../src/text/py-text.js";
import { byKey, CAPABILITIES, CATEGORIES, type Part } from "../src/capabilities/registry.js";
import { shown } from "../src/capabilities/visibility.js";

const PARTS: ReadonlySet<Part> = new Set<Part>(["github", "remote", "brief"]);

test("test_the_registry_is_well_formed", () => {
  const keys = CAPABILITIES.map((c) => c.key);
  assert.equal(keys.length, new Set(keys).size);
  const categories = new Set<string>(CATEGORIES.map((c) => c.key));
  for (const c of CAPABILITIES) {
    assert.ok(categories.has(c.category) || c.key === "help", c.key);
    assert.ok(["dm", "group", "both"].includes(c.where) && ["dm", "group"].includes(c.typedIn));
    assert.ok(["", "assistant", "session", "understanding"].includes(c.mode));
    assert.equal(Boolean(c.sayZh), Boolean(c.sayEn), c.key);
    assert.equal(Boolean(c.reaches), Boolean(c.sayZh), c.key);
  }
  for (const key of categories)
    assert.ok(
      CAPABILITIES.some((c) => c.category === key),
      key,
    );
});

test("test_help_lists_no_commands_and_every_category_in_order", () => {
  for (const lang of ["zh", "en"]) {
    for (const group of [false, true]) {
      const text = renderHelp(lang, { group, parts: PARTS });
      assert.ok(!text.includes("`/") && !/(?:^|\s|「|")\/[a-z]/u.test(text), text);
      const titles = CATEGORIES.filter((category) =>
        CAPABILITIES.some((c) => shown(c, { group, assistant: false, parts: PARTS }) && c.category === category.key),
      ).map((category) => (lang === "zh" ? category.zh : category.en));
      const found = text
        .split("\n")
        .filter((line) => line.startsWith("**"))
        .map((line) => line.replace(/^\*+|\*+$/gu, ""))
        .filter((line) => titles.includes(line));
      assert.deepEqual(found, titles);
    }
  }
  const zh = renderHelp("zh", { parts: PARTS });
  assert.deepEqual(
    CATEGORIES.map((c) => c.zh),
    ["对话与任务", "代你审 PR 和合入", "你自己的设置", "远程 agent", "通知与免打扰", "反馈"],
  );
  assert.ok(CATEGORIES.every((c) => zh.includes(`**${c.zh}**`)));
});

test("test_each_line_is_short_enough_for_a_phone", () => {
  for (const [lang, limit] of [
    ["zh", 90],
    ["en", 150],
  ] as const) {
    for (const [assistant, understanding] of [
      [false, false],
      [true, false],
      [true, true],
    ] as const) {
      // A group's recent messages kept (#725), at the default and at the largest settings, or not.
      for (const groupContext of [undefined, { messages: 30, hours: 4 }, { messages: 200, hours: 24 }]) {
        for (const group of [false, true]) {
          const text = renderHelp(lang, {
            group,
            parts: PARTS,
            values: { quiet: "22:00-08:00", github: "未连接" },
            assistant,
            understanding,
            ...(groupContext === undefined ? {} : { groupContext }),
          });
          for (const line of text.split("\n")) assert.ok(cpLength(line) <= limit, line);
        }
      }
    }
  }
});

test("test_settings_show_their_current_value_and_a_group_never_does", () => {
  const values = { quiet: "23:00-07:00", delegation: "开", timezone: "Asia/Tokyo" };
  const zh = renderHelp("zh", { parts: PARTS, values });
  assert.ok(zh.includes("（当前：23:00-07:00）") && zh.includes("（当前：开）") && zh.includes("（当前：Asia/Tokyo）"));
  assert.ok(!renderHelp("zh", { group: true, parts: PARTS, values }).includes("当前"));
});

test("test_menu_buttons_are_mentioned_once_at_the_end", () => {
  for (const lang of ["zh", "en"]) {
    const text = renderHelp(lang, { parts: PARTS });
    assert.equal(text.split(lang === "zh" ? "菜单" : "menu").length - 1, 1);
    assert.ok(text.trimEnd().endsWith("。") || text.trimEnd().endsWith("."));
  }
});

test("test_parts_that_are_off_are_not_offered", () => {
  const text = renderHelp("zh");
  for (const words of ["把我的 GitHub 连上", "review 合入", "agent", "给我发简报"])
    assert.ok(!text.includes(words), words);
});

test("test_with_the_assistant_help_says_it_looks_up_github_and_the_web_itself", () => {
  const lookupLines = {
    en: [
      '- Ask about your GitHub PRs, issues and CI directly (read-only, as you): "how many PRs do I have open?"',
      '- Search the web or read a page: "search the web for what is new in ROCm 7"',
    ],
    zh: [
      "- 直接问你的 GitHub PR、issue 和 CI（只读，以你的身份）：「我现在开着的 PR 有几个？」",
      "- 上网搜索，或读一个网页：「上网搜一下 ROCm 7 有哪些新功能」",
    ],
  } as const;
  const lookupWords = ["GitHub PRs, issues and CI", "Search the web", "GitHub PR、issue 和 CI", "上网搜索"];
  for (const lang of ["en", "zh"] as const) {
    for (const parts of [PARTS, new Set<Part>()]) {
      for (const understanding of [false, true]) {
        const text = renderHelp(lang, { assistant: true, understanding, parts });
        const chat =
          (text.split(lang === "en" ? "**Chat and tasks**\n" : "**对话与任务**\n")[1] ?? "").split("\n\n")[0] ?? "";
        for (const line of lookupLines[lang]) assert.ok(chat.split("\n").includes(line), chat);
      }
      for (const text of [
        renderHelp(lang, { parts }),
        renderHelp(lang, { group: true, parts }),
        renderHelp(lang, { group: true, assistant: true, parts }),
      ]) {
        // (a group's help names them only as what a 1:1 chat adds, after the group's own capabilities)
        const own = text.split(lang === "en" ? "**More in a 1:1 chat with me**" : "**私聊我还可以**")[0] ?? "";
        assert.ok(!lookupWords.some((w) => own.includes(w)), text);
      }
    }
  }
});

test("test_review_entries_say_what_the_worker_does", () => {
  const zh = renderHelp("zh", { parts: PARTS });
  for (const key of [
    "group_review",
    "review_direct",
    "review_many",
    "review_model",
    "review_notice",
    "github_confirm_mode",
  ]) {
    assert.ok(zh.includes(byKey(key).zh), key);
  }
  const group = renderHelp("zh", { group: true, parts: PARTS });
  assert.ok(!group.includes(byKey("review_direct").zh) && !group.includes(byKey("review_notice").zh));
  assert.ok(group.includes(byKey("review_many").zh));
});

test("test_whether_a_merge_waits_for_a_tap_is_said_without_a_fixed_list", () => {
  const c = byKey("review_confirm");
  assert.equal(c.zh, "合入前是否要审的人点确认，按 TA 的设置和审查结论决定");
  for (const text of [c.zh, c.en]) {
    assert.ok(!/架构|接口|安全|依赖|architecture|interface|security|dependenc/iu.test(text));
  }
});

const ONE_TO_ONE_TITLE = { zh: "**私聊我还可以**", en: "**More in a 1:1 chat with me**" } as const;

/** The block of a group's help that names what a 1:1 chat adds, as its lines ([] when there is none). */
function oneToOneBlock(text: string, lang: "zh" | "en"): string[] {
  const at = text.split("\n\n").find((block) => block.startsWith(ONE_TO_ONE_TITLE[lang]));
  return at === undefined ? [] : at.split("\n");
}

test("a capability named as what a 1:1 chat adds is one a group does not show, named in both languages", () => {
  const named = CAPABILITIES.filter((c) => c.dmZh !== "" || c.dmEn !== "");
  assert.ok(named.some((c) => c.key === "agents") && named.some((c) => c.key === "memory"));
  for (const c of named) {
    assert.ok(c.dmZh !== "" && c.dmEn !== "", c.key);
    assert.equal(c.where, "dm", c.key);
  }
});

test("a group's help names the main things of a 1:1 chat and how to open one; a 1:1 chat's help does not", () => {
  const all = new Set<Part>(["github", "remote", "brief", "schedule", "watch_job"]);
  for (const lang of ["zh", "en"] as const) {
    for (const assistant of [false, true]) {
      const group = renderHelp(lang, { group: true, assistant, parts: all, bot: "Clawy" });
      const lines = oneToOneBlock(group, lang);
      const names = CAPABILITIES.filter(
        (c) => c.dmZh !== "" && shown(c, { group: false, assistant, parts: all, understanding: false }),
      ).map((c) => `- ${lang === "zh" ? c.dmZh : c.dmEn}`);
      assert.deepEqual([...lines.slice(1, -1)].sort(), [...new Set(names)].sort(), group);
      assert.equal(lines[1], `- ${lang === "zh" ? byKey("agents").dmZh : byKey("agents").dmEn}`); // (it leads)
      assert.ok((lines.at(-1) ?? "").includes(lang === "zh" ? "发起私聊" : "start a chat"));
      assert.ok(
        lines.every((line) => cpLength(line) <= (lang === "zh" ? 90 : 150)),
        group,
      );
      // the block sits after the group's own capabilities and before what the bot does as whom
      const blocks = group.split("\n\n").map((block) => block.split("\n")[0]);
      const at = blocks.indexOf(ONE_TO_ONE_TITLE[lang]);
      assert.ok(at > blocks.indexOf(lang === "zh" ? "**反馈**" : "**Feedback**"));
      assert.ok(at < blocks.indexOf(lang === "zh" ? "**我能做什么、以谁的身份做**" : "**What I can do, and as whom**"));
      for (const values of [{}, { quiet: "23:00-07:00", timezone: "Asia/Tokyo" }]) {
        assert.deepEqual(oneToOneBlock(renderHelp(lang, { assistant, parts: all, values }), lang), []);
      }
    }
    const zh = lang === "zh";
    // what is off is not named: no machine without remote agents, no GitHub binding without the review service
    const none = renderHelp(lang, { group: true, assistant: true, parts: new Set<Part>() });
    const noneLines = oneToOneBlock(none, lang).join("\n");
    for (const key of ["agents", "github_bind", "brief", "schedule", "watch_job"]) {
      assert.ok(!noneLines.includes(zh ? byKey(key).dmZh : byKey(key).dmEn), key);
    }
    assert.ok(noneLines.includes(zh ? byKey("memory").dmZh : byKey("memory").dmEn));
  }
});

test("a group's help never shows a setting's value, even in what a 1:1 chat adds", () => {
  const values = { quiet: "23:00-07:00", delegation: "开", timezone: "Asia/Tokyo", memory: "开" };
  for (const lang of ["zh", "en"] as const) {
    const text = renderHelp(lang, { group: true, assistant: true, parts: PARTS, values });
    assert.ok(
      !text.includes("23:00-07:00") && !text.includes("Asia/Tokyo") && !text.includes(lang === "zh" ? "当前" : "now:"),
    );
  }
});
