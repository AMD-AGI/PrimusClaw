// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the user's own words ask of their personal skills (`skill-writes.ts`). Pure.
 *
 * These are the only code checks between the router's call of a write tool and the write, so each one is strict by its structure,
 * never a list of words found anywhere in a sentence:
 *
 *  - a yes to a draft is a whole short reply from a closed set (好, 可以, 保存吧, yes, ok, save it), or a sentence that names the draft's
 *    skill and says to save it;
 *  - a request to save is a directed verb phrase: a verb that makes something into a skill (存成技能, 沉淀为 skill, 保存到我的技能,
 *    save this as a skill, turn it into a skill), never 存 or 技能 on their own (这个技能存在吗 asks nothing);
 *  - a request to change, turn off, turn on, delete or undo a skill names that very skill, with a verb of that act next to its name
 *    (删掉 weekly-report, weekly-report 停用); the word 技能 alone, or another skill's name, is not this skill.
 *
 * And a sentence that says not to (不要, 别, don't, never) asks for nothing, except where the negation is itself how one turns a skill
 * off (别再用 X, stop using X). Anything short of these costs the user one press of the card's button, never a write they did not ask
 * for.
 */

/** NFKC, lower case, spaces collapsed: the sentence as the patterns read it. */
function said(text: string): string {
  return (text || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

// A sentence that says not to: never a request, whatever else it says ("不要存成技能", "don't save this as a skill").
const NEGATED = /(不要|不用|别|不必|无需|不需要|先不|不想|勿|不准|不许)/;
const NEGATED_EN = /\b(don'?t|do not|never|no need|not now|without|stop me)\b/;

export function negated(s: string): boolean {
  return NEGATED.test(s) || NEGATED_EN.test(s);
}

/** The text just before a quote in a message ends in a negation ("不要" + "把这个存成技能"): the quote is then no request. */
export function negatedBefore(prefix: string): boolean {
  const tail = said(prefix).slice(-12);
  return /(不要|不用|别|不必|无需|不需要|先不|不想|勿)\s*$/.test(tail) || /\b(don'?t|do not|never)\s*$/.test(tail);
}

// ---- A yes to a draft ------------------------------------------------------------------------------------------------

/** Punctuation, symbols and spaces, and the polite words around a short reply. */
const POLITE_HEAD = /^(?:嗯+|那|那就|就|请|麻烦|好的?吧?那就|ok so|well|please|then)/;
const POLITE_TAIL = /(?:吧|啊|呀|哈|呢|了|哦|嘛|please|thanks|thank you|thx)$/;

function bare(text: string): string {
  let s = said(text).replace(/[\p{P}\p{S}\s]+/gu, " ").trim();
  for (let i = 0; i < 3; i++) {
    const next = s.replace(POLITE_HEAD, "").trim().replace(POLITE_TAIL, "").trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

/** The whole replies that are a yes to a draft, after punctuation and polite words are taken off. */
const YES_REPLIES = new Set([
  "好", "好的", "好啊", "可以", "行", "确认", "同意", "没问题", "是的", "对", "对的", "要", "保存", "保存它", "保存下来", "存", "存下来",
  "存起来", "就存", "保存一下", "好保存", "好的保存", "可以保存", "行保存", "确认保存", "好存", "好的存",
  "yes", "yep", "yeah", "ok", "okay", "sure", "save", "save it", "yes save it", "ok save it", "go ahead", "do it", "confirm", "yes please",
  "sounds good", "keep it",
]);

/** Saying to save, next to the draft's name (保存 deploy-check, deploy-check 存下来, save deploy-check). */
function savesNamed(s: string, name: string): boolean {
  const n = escape(name.toLowerCase());
  return new RegExp(`(?:保存|存下|存起来|存成|收藏)\\s*(?:这个|那个)?\\s*(?:技能|skill)?\\s*${n}(?![a-z0-9_-])`).test(s)
    || new RegExp(`(?<![a-z0-9_-])${n}\\s*(?:这个)?\\s*(?:技能|skill)?\\s*(?:就)?\\s*(?:保存|存下来|存起来|存吧)`).test(s)
    || new RegExp(`\\b(?:save|keep)\\s+(?:the\\s+)?(?:skill\\s+)?${n}(?![a-z0-9_-])`).test(s);
}

/**
 * Whether the user's message (the whole of it, not a quote) says yes to the draft of `name`: a whole short reply from the yes-set, or a
 * sentence that names the draft's skill and says to save it, with no negation either way.
 */
export function confirmsDraft(message: string, name: string): boolean {
  const s = said(message);
  if (negated(s) || /[不没](?:行|可以|好|对|是|同意|确认|要|存|保存)/.test(s) || /\b(no|not|nope|nah|cancel|discard)\b/.test(s)) return false;
  const reply = bare(message);
  if (YES_REPLIES.has(reply) || YES_REPLIES.has(reply.replace(/(?<=[^a-z ]) | (?=[^a-z ])/g, ""))) return true;
  return !!name && (savesNamed(s, name) || (namesSkill(s, name) && asksToSaveSkill(s)));
}

// ---- A request to save -----------------------------------------------------------------------------------------------

const SKILL = "(?:技能|skill)";
const FILLER = "(?:我的|一个|一条|个人|新的?|个|一项)";
/** 存成技能, 沉淀为 skill, 做成我的一个技能, 记作技能, 加为技能. */
const SAVE_AS_ZH = new RegExp(`(?:存|保存|沉淀|记|做|整理|总结|写|加|收藏|归纳)\\s*(?:成|为|作)\\s*${FILLER}{0,3}\\s*${SKILL}`);
/** 保存到我的技能里, 存进技能, 收藏为技能 (存在 is no save: 在 is not one of these). */
const SAVE_INTO_ZH = new RegExp(`(?:存|保存|收藏)(?:下来|起来)?\\s*(?:到|进|为)\\s*${FILLER}{0,3}\\s*${SKILL}`);
/** save this as a skill, turn it into a skill, make that a skill of mine. */
const SAVE_AS_EN = new RegExp(
  "\\b(?:save|store|keep|turn|make|record|add)\\b(?: [a-z0-9'_-]+){0,6} (?:as|into) (?:a |an |my |our |one of my )?(?:new |personal |reusable |own )?skills?\\b",
);
const MAKE_A_SKILL_EN = /\bmake (?:this|that|it|these|them) (?:a|my|into a) (?:new |personal )?skill\b/;

/** Whether the words ask for something to be saved as a skill: a directed save phrase, and no negation. */
export function asksToSaveSkill(quote: string): boolean {
  const s = said(quote);
  if (negated(s)) return false;
  return SAVE_AS_ZH.test(s) || SAVE_INTO_ZH.test(s) || SAVE_AS_EN.test(s) || MAKE_A_SKILL_EN.test(s);
}

// ---- Acts on a named skill -------------------------------------------------------------------------------------------

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether the sentence names the skill `name` itself, as a word of its own (not part of a longer name). */
export function namesSkill(s: string, name: string): boolean {
  if (!name) return false;
  return new RegExp(`(?<![a-z0-9_.-])${escape(said(name))}(?![a-z0-9_-])`).test(said(s));
}

type Act = "delete" | "disable" | "enable" | "undo";

/** The verbs of each act: each tied to its act only (no 去掉, which edits a step; no bare 打开, which opens; no 改天). */
const VERBS: Readonly<Record<Act, { zh: string; en: string }>> = {
  delete: { zh: "删除|删掉|删了|移除|不要了", en: "delete|remove|get rid of" },
  disable: { zh: "停用|禁用|关掉|关闭|暂停|别再用|不要再用|不再用|先别用", en: "disable|turn off|switch off|stop using|pause|no longer use" },
  enable: { zh: "启用|重新启用|恢复使用|重新用|重新打开|开启", en: "enable|re-?enable|turn on|switch on|start using" },
  undo: { zh: "撤销|撤回|还原|回退|恢复", en: "undo|revert|roll back|restore|take back" },
};

/** The verb right before the name (删掉 weekly-report, 删掉这个技能 weekly-report) or right after it (weekly-report 技能删掉吧). */
function verbAtName(s: string, verbs: string, name: string): boolean {
  const n = escape(said(name));
  const between = "\\s*(?:掉|了)?\\s*(?:我的|这个|那个|个人)?\\s*(?:技能|skill)?\\s*[「“\"'`]?\\s*";
  const before = new RegExp(`(?:${verbs})${between}${n}(?![a-z0-9_-])`);
  const after = new RegExp(`(?<![a-z0-9_.-])${n}[」”"'\`]?\\s*(?:这个|那个)?\\s*(?:技能|skill)?\\s*(?:也|就|先|给我|帮我|请)?\\s*(?:${verbs})(?:掉|了|吧|啊|一下)*\\s*(?:$|[\\p{P}\\s])`, "u");
  return before.test(s) || after.test(s);
}

/** English: the verb before the name (delete weekly-report, turn off the weekly-report skill, don't use weekly-report anymore). */
function verbAtNameEn(s: string, verbs: string, name: string): boolean {
  const n = escape(said(name));
  return new RegExp(`\\b(?:${verbs})\\s+(?:the |my |this )?(?:skill )?${n}(?![a-z0-9_-])`).test(s);
}

// The phrasings where a negation is itself the request to turn a skill off: only these are exempt from the negation check.
const OFF_BY_NEGATION = /(别再用|不要再用|不再用|先别用|stop using|no longer use)/g;
const DONT_USE_ANYMORE = (name: string) => new RegExp(`\\b(?:don'?t|do not) use (?:the |my )?(?:skill )?${escape(said(name))} (?:any ?more|again)\\b`);

/**
 * Whether the words ask to delete, turn off, turn on or undo the skill `name`: its name, with a verb of that act next to it, and no
 * negation (except the phrasings where a negation is how one turns a skill off).
 */
export function asksToAct(quote: string, act: Act, name: string): boolean {
  const s = said(quote);
  if (!namesSkill(s, name)) return false;
  if (act === "disable" && DONT_USE_ANYMORE(name).test(s)) {
    return !negated(s.replace(DONT_USE_ANYMORE(name), " ").replace(OFF_BY_NEGATION, " "));
  }
  const { zh, en } = VERBS[act];
  if (!verbAtName(s, zh, name) && !verbAtNameEn(s, en, name)) return false;
  return !negated(act === "disable" ? s.replace(OFF_BY_NEGATION, " ") : s);
}

/** 修改, 改成, 改为, 改一下, 更新, 调整, 加上 a step, 去掉 a step: the verbs of a change (never 改天, never 改 alone). */
const CHANGE_ZH = /(修改|改成|改为|改一下|改改|改下|更新|调整|替换成|换成|加上|加一步|加一条|去掉|删去|删掉第|补充|重写)/;
const CHANGE_EN = /\b(change|update|edit|modify|replace|rewrite|adjust|rename)\b/;

/** Whether the words ask for a change to the skill `name`: its name, a change verb, and no negation. */
export function asksToChangeSkill(quote: string, name: string): boolean {
  const s = said(quote);
  return namesSkill(s, name) && !negated(s) && (CHANGE_ZH.test(s) || CHANGE_EN.test(s));
}
