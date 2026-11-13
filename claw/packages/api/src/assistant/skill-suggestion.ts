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

const SAVE_AS_SKILL_ZH = /(?:存|保存|沉淀|记|做|整理|总结|写|加|收藏|归纳)\s*(?:成|为|作|下来|起来)[^。！？!?\n]{0,12}?(?:技能|skill)/i;
const ASKS_ZH = /(?:要不要|要不|需不需要|需要|是否|想不想|想要|可以|能不能|建议|帮你)[^。！？!?\n]{0,30}?(?:存|保存|沉淀|记|做|整理|总结|写|加|收藏|归纳)\s*(?:成|为|作|下来|起来)[^。！？!?\n]{0,12}?(?:技能|skill)|(?:技能|skill)[^。！？!?\n]{0,6}?(?:吗|么|呢)/i;
const ASKS_EN = /\b(?:want|like|shall|should|would|could)\b[^.?!\n]{0,60}\b(?:save|turn|make|keep|store)\b[^.?!\n]{0,60}\bskills?\b[^.!\n]*\?/i;

/** Whether `text` asks the user, in words, whether to save something as a skill. */
export function asksToSaveAsSkill(text: string): boolean {
  const s = (text || "").normalize("NFKC");
  if (ASKS_EN.test(s)) return true;
  if (!SAVE_AS_SKILL_ZH.test(s)) return false;
  return ASKS_ZH.test(s) || /[?？]/.test(s.slice(s.search(SAVE_AS_SKILL_ZH)));
}

/**
 * Why a say that asks whether to save a skill is refused, or null when it may go: personal skills off, or not such a say, or this turn
 * (of session `sid`, begun at `began`) already drafted or saved a skill.
 */
export async function textSkillSuggestion(q: Querier, sid: string, began: Date | undefined, text: string): Promise<string | null> {
  if (!CLAW_USER_SKILLS_ENABLED || !asksToSaveAsSkill(text)) return null;
  const done = (await q(
    `SELECT 1 FROM claw_skill_events WHERE session_id = $1 AND op IN ('draft', 'create', 'update')
       AND created_at >= COALESCE($2::timestamptz, NOW() - INTERVAL '15 minutes') LIMIT 1`,
    [sid, began ? new Date(began).toISOString() : null],
  )).rows.length > 0;
  if (done) return null;
  return "do not ask in words whether to save a skill: call skill_draft with the skill you would save (name, description, SKILL.md). "
    + "Its card asks the user, with Save and Discard. Then say one short line about it, or nothing more";
}
