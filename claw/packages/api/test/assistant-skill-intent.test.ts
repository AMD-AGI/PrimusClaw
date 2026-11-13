// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The gates between the model and a write to the user's skills (`assistant/skill-intent.ts`), on the sentences people say. Pure: no
 * database. The same sentences go through the router's tools over a real Postgres in `assistant-skill-save.test.ts` (E14, E16).
 *
 *   I1 a yes to a draft is a whole short reply from the yes-set, or a sentence that names the draft's skill and says to save it; a
 *      sentence with a yes-like character in it (运行, 这是, 对比, 存到, keep me posted) and every way of saying no is not
 *   I2 a request to save is a directed phrase (存成技能, 保存到技能, save this as a skill); a question or a remark about skills
 *      (这个技能存在吗, 作为参考) and a negated one are not
 *   I3 an act names this very skill with a verb of that act next to it: another skill's name, the word 技能 alone, an edit of a step
 *      (去掉 the third step), "open it to look" (打开), 改天 and a negation (except 别再用 / stop using) are not
 *   I4 a corpus of ordinary chat sentences: false for every gate
 */
import assert from "node:assert/strict";
import test from "node:test";

import { asksToAct, asksToChangeSkill, asksToSaveSkill, confirmsDraft, negatedBefore } from "../src/assistant/skill-intent.js";

const NAME = "weekly-report";
const DRAFT = "deploy-check";

test("I1 a yes to a draft: a short reply of its own, or the draft's name with a save verb", () => {
  for (const yes of [
    "好", "好的", "好的！", "好的，保存吧", "嗯，可以", "可以", "行", "保存", "保存吧", "存吧", "存下来吧", "确认", "同意", "没问题", "是的",
    "那就保存吧", "yes", "Yes!", "ok", "OK, save it", "sure", "save it", "go ahead", "yes please",
    `好，把 ${DRAFT} 存成技能`, `保存 ${DRAFT}`, `${DRAFT} 就保存吧`, `save ${DRAFT}`,
  ]) {
    assert.equal(confirmsDraft(yes, DRAFT), true, yes);
  }
  for (const no of [
    // The reviewer's: a yes-like character inside another sentence.
    "帮我运行一下测试", "这是什么？", "对比一下这两个PR", "把它存到仓库里", "keep me posted on the build",
    // A no, however it is put.
    "不行", "不可以", "不好", "不对", "不是", "不同意", "不确认", "不要", "不用了", "别存", "算了", "先不存", "不保存", "取消", "放弃",
    "没同意", "no", "nope", "not ok", "not now", "no, don't", "don't save it", "cancel", "discard",
    // A longer sentence that does not name the draft, or names another skill.
    "好的，那我们先看看别的", "可以，不过先帮我查一下 CI", `保存 ${NAME}`, "ok, what about the other PR?", "save the file please",
  ]) {
    assert.equal(confirmsDraft(no, DRAFT), false, no);
  }
});

test("I2 a request to save is a directed phrase, never 存 or 技能 on their own", () => {
  for (const save of [
    "把这个存成技能", "请把下面这个做法存成我的一个技能", "沉淀成 skill", "把流程沉淀为技能", "做成一个技能", "记作技能", "整理成个人技能",
    "保存到我的技能里", "存进技能", "收藏为技能", "save this as a skill", "save the deploy check as a skill", "turn this into a skill",
    "make it a skill", "store these steps as my skill",
  ]) {
    assert.equal(asksToSaveSkill(save), true, save);
  }
  for (const not of [
    "这个技能存在吗？", "我的技能作为参考就行", "这个技能存了多少条", "把它存到仓库里", "技能列表在哪", "你有什么技能", "存一下这个文件",
    "不要把这个存成技能", "别存成技能", "don't save this as a skill", "add a skill for standup", "what skills do I have", "skill issue",
    "save the file", "keep it as is",
  ]) {
    assert.equal(asksToSaveSkill(not), false, not);
  }
});

test("I3 an act names this very skill, with a verb of that act next to it", () => {
  const yes: Array<[string, "delete" | "disable" | "enable" | "undo"]> = [
    [`删掉 ${NAME} 技能`, "delete"], [`删除 ${NAME}`, "delete"], [`${NAME} 这个技能删掉吧`, "delete"], [`delete ${NAME}`, "delete"],
    [`停用 ${NAME}`, "disable"], [`把 ${NAME} 关掉`, "disable"], [`别再用 ${NAME} 了`, "disable"], [`不要再用 ${NAME}`, "disable"],
    [`先别用 ${NAME} 这个技能了`, "disable"], [`stop using ${NAME}`, "disable"], [`turn off ${NAME}`, "disable"],
    [`don't use ${NAME} anymore`, "disable"],
    [`重新启用 ${NAME}`, "enable"], [`启用 ${NAME}`, "enable"], [`turn on ${NAME}`, "enable"],
    [`撤销 ${NAME}`, "undo"], [`撤销技能 ${NAME}`, "undo"], [`恢复 ${NAME}`, "undo"], [`undo ${NAME}`, "undo"], [`restore ${NAME}`, "undo"],
  ];
  for (const [q, act] of yes) assert.equal(asksToAct(q, act, NAME), true, `${act}: ${q}`);
  const no: Array<[string, "delete" | "disable" | "enable" | "undo"]> = [
    // The reviewer's: another skill, an edit of a step, "open it to look".
    ["删掉 old-report 技能", "delete"], [`${NAME} 这个技能的第三步去掉`, "delete"], [`打开 ${NAME} 看看写了什么`, "enable"],
    // The word 技能 alone, no name.
    ["删掉这个技能", "delete"], ["把技能关掉", "disable"], ["撤销", "undo"], ["撤销刚才那个改动", "undo"],
    // A negation.
    [`不要关掉${NAME}`, "disable"], [`别关掉 ${NAME} 技能`, "disable"], [`don't turn off ${NAME}`, "disable"], [`do not disable ${NAME}`, "disable"],
    [`别删 ${NAME}`, "delete"], [`不要删除 ${NAME} 技能`, "delete"], [`don't delete ${NAME}`, "delete"], [`不要撤销 ${NAME}`, "undo"],
    // Another act's verb, or a name that is part of another.
    [`别再用 ${NAME}`, "enable"], [`停用 ${NAME}`, "delete"], [`删掉 my-${NAME}`, "delete"], [`删掉 ${NAME}-v2`, "delete"],
    // Something else entirely.
    ["取消明天的会议", "undo"], ["restore my laptop backup", "undo"], [`${NAME} 的输出关掉了吗`, "disable"],
  ];
  for (const [q, act] of no) assert.equal(asksToAct(q, act, NAME), false, `${act}: ${q}`);

  for (const q of [`把 ${NAME} 改一下`, `把 ${NAME} 技能的第三步改成先拉 PR 列表`, `update ${NAME} to list the PRs first`, `${NAME} 加一步：先看 CI`]) {
    assert.equal(asksToChangeSkill(q, NAME), true, q);
  }
  for (const q of ["add a skill for standup", `${NAME} 改天再说吧`, `不要改 ${NAME}`, "把 old-report 改一下", "把这个技能改一下", `${NAME} 写得不错`]) {
    assert.equal(asksToChangeSkill(q, NAME), false, q);
  }
  assert.equal(negatedBefore("不要"), true);
  assert.equal(negatedBefore("please don't "), true);
  assert.equal(negatedBefore("好的，"), false);
});

/** Ordinary things people say to their assistant: none of them asks for any write to a skill. */
const CORPUS = [
  "帮我看看 PrimusClaw #823 的 CI", "今天天气怎么样", "帮我运行一下测试", "这是什么？", "对比一下这两个PR", "把它存到仓库里", "好久不见",
  "你好", "谢谢", "明天提醒我开会", "这个问题怎么解决", "能帮我写个周报吗", "我的技能有哪些", "这个技能存在吗？", "技能列表在哪",
  "把日志保存一下", "保存这个文件到桌面", "存一下草稿", "打开浏览器", "关掉通知", "删除那封邮件", "撤销上一次提交", "恢复出厂设置",
  "取消订阅", "启用 GPU 节点", "停用这个账号", "改天再聊", "这段代码作为参考", "把结果当成基线", "变成 JSON 格式", "加上一个单元测试",
  "去掉多余的空格", "keep me posted on the build", "ok I'll check later", "sure, but first check the PR", "can you save the logs?",
  "what is a skill?", "delete the temp branch", "turn off notifications", "undo my last commit", "restore the database backup",
  "update the README", "change the title", "stop the job", "is the deploy done?", "show me the board", "how many nodes are free",
  "summarize this thread", "write a haiku about GPUs", "存在的问题是什么", "这个做法挺好的，记一下", "行吧，你看着办", "yes the build passed",
];

test("I4 ordinary chat sentences ask for no write to a skill, through any gate", () => {
  assert.ok(CORPUS.length >= 50);
  for (const s of CORPUS) {
    assert.equal(asksToSaveSkill(s), false, `save: ${s}`);
    assert.equal(confirmsDraft(s, DRAFT), false, `draft: ${s}`);
    assert.equal(asksToChangeSkill(s, NAME), false, `change: ${s}`);
    for (const act of ["delete", "disable", "enable", "undo"] as const) assert.equal(asksToAct(s, act, NAME), false, `${act}: ${s}`);
  }
});
