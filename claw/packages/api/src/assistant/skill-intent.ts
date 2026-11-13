// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the user's own words ask of their personal skills, read from the quote a skill tool is given (`skill-writes.ts`). Pure.
 *
 * The quote is checked to be the user's (`quoteIsFrom`, against the message the turn answers) before any of these is asked; these
 * only tell what that sentence asks for. A request to save as a skill ("存成技能", "沉淀成 skill", "save this as a skill") is saved at
 * once; anything short of one is the assistant's own idea and becomes a draft the user confirms first. So
 * `asksToSaveSkill` errs towards no: a sentence it does not read as a request costs the user one press, never a skill they did not ask
 * for.
 */

function said(text: string): string {
  return (text || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
}

const SKILL_WORD_ZH = /(技能|skill)/;
// A sentence that says not to: never a request, whatever else it says ("不要存成技能", "don't save this as a skill").
const NEGATED = /(不要|不用|别|不必|无需|不需要|先不|不想|勿)/;
const NEGATED_EN = /\b(don'?t|do not|never|no need|not now|without)\b/;

function negated(s: string): boolean {
  return NEGATED.test(s) || NEGATED_EN.test(s);
}
// Verbs that put something into a skill: 存/保存/存为/沉淀/记成/做成/整理成/总结成/写成/收藏/加为/添加为.
const SAVE_VERB_ZH = /(存|保存|沉淀|记成|记为|记作|做成|整理成|总结成|写成|收藏|加为|添加为|变成|当成|作为)/;
const SAVE_EN = /\b(save|store|keep|turn|make|record|add|create)\b[^.?!\n]{0,60}\b(skills?)\b/;
const AS_SKILL_EN = /\bas (?:a |an |my |our )?(?:new |personal |reusable |own )?skills?\b/;

/** Whether the words ask for something to be saved as a skill: a save verb and the word skill (技能) together. */
export function asksToSaveSkill(quote: string): boolean {
  const s = said(quote);
  if (negated(s)) return false;
  if (SKILL_WORD_ZH.test(s) && SAVE_VERB_ZH.test(s) && /[一-鿿]/.test(s)) return true;
  return SAVE_EN.test(s) || AS_SKILL_EN.test(s);
}

/** Whether the words say yes to a draft the assistant showed: a yes or a save word. */
export function confirmsDraft(quote: string): boolean {
  const s = said(quote);
  if (/(不要|不用|别存|不存|算了|取消|不保存|^不$|^否)/.test(s) || /\b(no|don't|do not|cancel|discard|nope)\b/.test(s)) return false;
  return /(存|保存|好的?|可以|行|确认|同意|没问题|对|是的?)/.test(s) || /\b(yes|yep|ok|okay|sure|save|keep|confirm|go ahead|do it)\b/.test(s)
    || asksToSaveSkill(s);
}

const CHANGE_ZH = /(改|修改|更新|调整|替换|加上|加一|去掉|删去|补充|换成)/;
const CHANGE_EN = /\b(change|update|edit|modify|replace|rewrite|adjust|add|remove|rename)\b/;

/** Whether the words ask for a change to a skill: a change verb, and the skill's name or the word skill (技能). */
export function asksToChangeSkill(quote: string, name: string): boolean {
  const s = said(quote);
  const about = (name && s.includes(name.toLowerCase())) || SKILL_WORD_ZH.test(s);
  return about && !negated(s) && (CHANGE_ZH.test(s) || CHANGE_EN.test(s));
}

const ACTS: Readonly<Record<"delete" | "disable" | "enable" | "undo", { zh: RegExp; en: RegExp }>> = {
  delete: { zh: /(删|删除|删掉|移除|去掉)/, en: /\b(delete|remove|drop|get rid of)\b/ },
  disable: { zh: /(停用|禁用|别再用|不要再用|不再用|关掉|关闭|先别用|暂停)/, en: /\b(disable|turn off|stop using|switch off|pause)\b/ },
  enable: { zh: /(启用|恢复使用|重新用|再用|打开|开启|恢复)/, en: /\b(enable|turn on|switch on|use again|re-?enable)\b/ },
  undo: { zh: /(撤销|撤回|取消|还原|恢复|回退|反悔)/, en: /\b(undo|revert|roll ?back|take back|restore)\b/ },
};

/** Whether the words ask to delete, turn off, turn on or undo a skill: the verb, and the skill's name or the word skill (技能). */
export function asksToAct(quote: string, act: keyof typeof ACTS, name: string): boolean {
  const s = said(quote);
  const about = (name && s.includes(name.toLowerCase())) || SKILL_WORD_ZH.test(s) || act === "undo";
  // ("别再用" is how one turns a skill off: a negation is the request there, and refuses every other act.)
  return about && (act === "disable" || !negated(s)) && (ACTS[act].zh.test(s) || ACTS[act].en.test(s));
}
