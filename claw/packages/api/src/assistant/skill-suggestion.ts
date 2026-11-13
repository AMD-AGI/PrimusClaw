// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A skill the assistant suggests on its own is a draft with a card (`skill_draft`), never a question in words: a question the user
 * cannot press, and that drafts nothing, is what the router reached for when told to "suggest" (a meeting-notes format the user
 * said they always use was answered with "要不要把这种格式存成技能？" and no draft). So `say` refuses, with personal skills on, a message
 * that asks whether to save something as a skill, unless this turn has drafted one (whose card is the question) or saved one; the
 * refusal tells the router to call skill_draft first. Pure test plus one read.
 */
import { CLAW_USER_SKILLS_ENABLED } from "../config.js";
import type { Querier } from "../infra/db.js";

// Leaning towards letting a say through: a missed nudge costs the user one card, a refused answer costs them the answer.

/** A save-into-a-skill phrase in Chinese: 存成/保存为/沉淀成/做成 … 技能. */
const SAVE_AS_SKILL_ZH = /(?:存|保存|沉淀|记|做|整理|总结|写|加|收藏|归纳)\s*(?:成|为|作)[^，,。！!？?\n；;]{0,12}?(?:技能|skill)/i;
/** The same phrase said of something done already (已经存成技能了, 之前把它存成技能了): a statement, not an offer. */
const DONE_ZH = /(?:已|已经|之前|刚才|刚刚|早就)|(?:技能|skill)了/i;
/** What makes a clause an offer or a question to the user. */
const OFFERS_ZH = /(?:要不要|要不|需不需要|需要我|是否|想不想|要我|我来|我可以|可以帮你|帮你|建议)|(?:吗|么|呢)\s*$/;
/** A save-as phrase with something being made into a skill: save/turn/make/keep this … as/into a skill. */
const SAVE_AS_SKILL_EN = /\b(?:save|turn|make|keep|store|add)\s+(?:this|that|it|these|them|the (?:steps|format|workflow|process|flow))\b(?:\s+[\w-]+){0,3}?\s+(?:into|as)\s+(?:a |an |one of your |your |my )?(?:new |personal |reusable )?skills?\b/i;
/** An offer form that starts the clause: "Want me to …", "Shall I …", "Would you like …", "Can I …". */
const OFFER_START_EN = /^(?:(?:do you |would you |)want me to|shall i|should i|would you like|do you want|can i|could i|may i|let me know if you(?:'d| would) like)\b/i;
/** A clause that says something cannot be done is never an offer ("I could not save this as a skill", "I can't …"). */
const NEGATED_EN = /\b(?:not|no|never|cannot|unable)\b|n't\b/i;
/** The same in Chinese: 无法, 不能, 没法, 没能, 失败. */
const NEGATED_ZH = /(?:无法|不能|没法|没能|没有办法|不可以|失败)/;

/**
 * Whether `text` asks the user, in words, whether to save something as a skill: a clause (split at every comma, stop and question
 * mark) that holds a save-into-a-skill phrase, is not about something saved already, and offers or asks.
 */
export function asksToSaveAsSkill(text: string): boolean {
  const s = (text || "").normalize("NFKC");
  // Each clause with the mark that ends it: "要不要把它存成技能？" is a question; "已保存为技能，截止是周五吗？" holds none.
  for (const m of s.matchAll(/([^，,。！!？?\n；;]+)([，,。！!？?\n；;]?)/g)) {
    const clause = m[1].trim();
    const ends = m[2] ?? "";
    if (SAVE_AS_SKILL_EN.test(clause) && !NEGATED_EN.test(clause) && (OFFER_START_EN.test(clause) || ends === "?" || ends === "？")) return true;
    if (!SAVE_AS_SKILL_ZH.test(clause) || DONE_ZH.test(clause) || NEGATED_ZH.test(clause)) continue;
    if (OFFERS_ZH.test(clause) || ends === "?" || ends === "？") return true;
  }
  return false;
}

/**
 * Why a say that asks whether to save a skill is refused, or null when it may go: personal skills off, or not such a say, or this turn
 * (of session `sid`, begun at `began`) already drafted or saved a skill, or had a skill write refused (the router must be able to tell
 * the user why).
 */
export async function textSkillSuggestion(
  q: Querier, sid: string, userId: string, began: Date | undefined, text: string,
): Promise<string | null> {
  if (!CLAW_USER_SKILLS_ENABLED || !asksToSaveAsSkill(text)) return null;
  // Where the user's skills are not served (a group's session), skill_draft cannot help: the say goes as it is.
  const { routerSkillsServe } = await import("./skill-tools.js");
  if (!(await routerSkillsServe(q, sid, userId))) return null;
  const done = (await q(
    `SELECT 1 FROM claw_skill_events WHERE session_id = $1 AND op IN ('draft', 'create', 'update', 'refused')
       AND created_at >= COALESCE($2::timestamptz, NOW() - INTERVAL '15 minutes') LIMIT 1`,
    [sid, began ? new Date(began).toISOString() : null],
  )).rows.length > 0;
  if (done) return null;
  return "do not ask in words whether to save a skill: call skill_draft with the skill you would save (name, description, SKILL.md). "
    + "Its card asks the user, with Save and Discard. Then say one short line about it, or nothing more";
}
