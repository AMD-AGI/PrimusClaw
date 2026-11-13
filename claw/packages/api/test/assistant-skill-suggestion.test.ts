// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which messages ask the user, in words, whether to save something as a skill (`assistant/skill-suggestion.ts`): the say the router
 * must replace with a draft card. Pure: no database (the refusal itself, over Postgres: E18 in `assistant-skill-save.test.ts`).
 *
 *   S1 questions and offers to save as a skill, in Chinese and English, are caught
 *   S2 telling what was saved, answering about skills, and ordinary answers are not
 */
import assert from "node:assert/strict";
import test from "node:test";

import { asksToSaveAsSkill } from "../src/assistant/skill-suggestion.js";

test("S1 a question or an offer to save as a skill is caught", () => {
  for (const asked of [
    "要不要把这种格式存成技能？", "整理好了。要不要把这种格式存成技能？以后直接用。", "需要我把它保存为技能吗？", "是否把这个流程沉淀成技能？",
    "我可以帮你把这个做法存成一个技能，要吗？", "要把它存成技能吗", "这个格式要不要做成你的个人技能？", "建议把这个流程整理成技能，以后直接用？",
    "Do you want me to save this format as a skill?", "Would you like to turn this into a skill?", "Shall I save it as one of your skills?",
  ]) {
    assert.equal(asksToSaveAsSkill(asked), true, asked);
  }
});

test("S2 telling what was saved, an answer about skills and an ordinary answer are not", () => {
  for (const said of [
    "已存为你的个人技能「meeting-notes」v1。", "已保存为技能，点「撤销」可撤回。", "你现在没有个人技能。", "standup-notes 已删除，你之前撤销了它。",
    "议题：发布节奏。结论：周四发。待办：写变更日志。", "这个技能存在吗？你可以用 /skills 看。", "Saved as your skill meeting-notes v1.",
    "I saved it. Press Undo to take it back.", "要不要我现在跑一下测试？", "Do you want me to run the tests?",
  ]) {
    assert.equal(asksToSaveAsSkill(said), false, said);
  }
});
