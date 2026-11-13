// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The gates between the model and a write to the user's skills (`assistant/skill-intent.ts`), on the sentences people say. Pure: no
 * database. The same sentences go through the router's tools over a real Postgres in `assistant-skill-save.test.ts` (E14).
 *
 *   I1 a yes to a draft: 好的/可以/行/保存吧/yes/ok; never a no, however it is put: 不行, 不可以, 不好, 不对, 不是, 不同意, 不确认, 不要,
 *      算了, 先不存, no, not ok, don't
 *   I2 turning a skill off: 停用/关掉/别再用/不要再用/不再用/先别用/stop using/don't use ... anymore; never 不要关掉, 别关掉, 不要停用,
 *      don't turn off, do not disable
 *   I3 undo: 撤销/undo alone is about a skill; 取消/恢复/restore/revert only with the skill's name or 技能/skill
 *   I4 save, change, delete and enable: a negated sentence asks for nothing
 */
import assert from "node:assert/strict";
import test from "node:test";

import { asksToAct, asksToChangeSkill, asksToSaveSkill, confirmsDraft } from "../src/assistant/skill-intent.js";

const NAME = "weekly-report";

test("I1 a yes to a draft is a yes, and every way of saying no is a no", () => {
  for (const yes of ["好的", "好的，保存吧", "可以", "行", "保存", "存吧", "确认", "同意", "没问题", "是的", "yes", "ok", "OK, save it", "sure, go ahead"]) {
    assert.equal(confirmsDraft(yes), true, yes);
  }
  for (const no of [
    "不行", "不可以", "不好", "不对", "不是", "不同意", "不确认", "不要", "不用了", "别存", "算了", "先不存", "不保存", "取消", "放弃",
    "没同意", "no", "nope", "not ok", "not now", "no, don't", "don't save it", "do not save", "cancel", "discard",
  ]) {
    assert.equal(confirmsDraft(no), false, no);
  }
});

test("I2 turning a skill off: only where a negation is the request itself", () => {
  for (const off of [
    `停用 ${NAME}`, `把 ${NAME} 技能关掉`, `别再用 ${NAME} 了`, `不要再用 ${NAME}`, `以后不再用 ${NAME}`, `先别用 ${NAME} 这个技能了`,
    `stop using ${NAME}`, `disable ${NAME}`, `turn off ${NAME}`, `don't use ${NAME} anymore`, `no longer use ${NAME}`,
  ]) {
    assert.equal(asksToAct(off, "disable", NAME), true, off);
  }
  for (const keep of [
    `不要关掉${NAME}`, `别关掉 ${NAME} 技能`, `不要停用 ${NAME}`, `别禁用 ${NAME}`, `don't turn off ${NAME}`, `do not disable ${NAME}`,
    `never disable ${NAME}`, `别再用 ${NAME} 了，不对，不要关掉它`,
  ]) {
    assert.equal(asksToAct(keep, "disable", NAME), false, keep);
  }
});

test("I3 undo: 撤销 or undo is about a skill; 取消, 恢复 and restore only with its name or the word skill", () => {
  for (const undo of ["撤销", "撤销技能 weekly-report", "undo that", `恢复 ${NAME}`, "把刚才的技能还原", `restore ${NAME}`, "revert the skill"]) {
    assert.equal(asksToAct(undo, "undo", NAME), true, undo);
  }
  for (const other of ["取消明天的会议", "恢复我的电脑备份", "restore my laptop backup", "revert the deploy", "不要撤销", "don't undo it"]) {
    assert.equal(asksToAct(other, "undo", NAME), false, other);
  }
});

test("I4 save, change, delete and enable: a negated sentence asks for nothing", () => {
  assert.equal(asksToSaveSkill("把这个存成技能"), true);
  assert.equal(asksToSaveSkill("save this as a skill"), true);
  for (const no of ["不要把这个存成技能", "别存成技能", "don't save this as a skill", "do not save it as a skill"]) {
    assert.equal(asksToSaveSkill(no), false, no);
  }
  assert.equal(asksToChangeSkill(`把 ${NAME} 改一下`, NAME), true);
  assert.equal(asksToChangeSkill(`不要改 ${NAME}`, NAME), false);
  assert.equal(asksToAct(`删掉 ${NAME} 技能`, "delete", NAME), true);
  for (const no of [`别删 ${NAME}`, `不要删除 ${NAME} 技能`, `don't delete ${NAME}`]) assert.equal(asksToAct(no, "delete", NAME), false, no);
  assert.equal(asksToAct(`重新启用 ${NAME}`, "enable", NAME), true);
  assert.equal(asksToAct(`别再用 ${NAME}`, "enable", NAME), false, "a turn-off is no turn-on");
});
