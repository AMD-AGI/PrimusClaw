// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A skill suggested by the platform after a router turn, not left to the model. Told "I always write meeting notes as topics,
 * conclusions, to-dos", the router answered in that format and called nothing: the nudge to `skill_draft` is a prompt, and a prompt can be
 * skipped. So when the turn's message (the user's own, signed in) states a way they always work ("我每次都…", "以后…都…", "always …",
 * "from now on …") and the turn neither saved nor drafted a skill, the server drafts one from the conversation (`claw_skill_drafts`,
 * origin `auto`) and shows the same card `skill_draft` shows, with Save and Discard. Nothing is saved until the user presses Save.
 *
 * Kept rare: only the user's own assistant conversation with their skills on (never a group's); one card per conversation per skill
 * name; none for a while after the user discarded one here; a few a day at most; never for a skill they have; and the model writing the
 * draft may decline (`worth: false`) when the message is not a reusable way of working.
 */
import pino from "pino";
import { CLAW_USER_SKILLS_ENABLED } from "../config.js";
import { db } from "../infra/db.js";
import { metrics } from "../infra/metrics.js";
import { callMemoryLLM } from "../llm/client.js";
import { createSkillDraft, listUserSkills, sameSkillUnderAnotherName, USER_SKILL_NAME_RE } from "../marketplace/skill-service.js";
import { turnMessage } from "./inbound.js";
import { routerSkillsServe } from "./skill-tools.js";
import { removedSkillNamed, showDraftCard } from "./skill-writes.js";

const logger = pino({ name: "assistant-skill-auto-draft" });

/** A durable preference or a recurring way of working, in Chinese. */
const RECURRING_ZH = /(?:我(?:每次|一般|通常|平时|向来|一向|一直|总是)都?|以后|今后|往后|之后|从现在起|从今往后)[^。！!？?\n；;]{0,24}?(?:都|按|用|照|要|是)|我习惯|每次都(?:按|用|照|是)|固定(?:按|用|格式)/;
/** The same in English. */
const RECURRING_EN = /\b(?:i (?:always|usually|normally)|every time i|from now on|going forward|in future|in the future|always (?:use|format|write|do|follow))\b/i;
/** A clause that says not to (以后别这样, don't always …): not a preference to keep. */
const NOT_ZH = /(?:别|不要|不用|不必|不再|不想|没必要)/;
const NOT_EN = /\b(?:don't|do not|never|no longer|stop)\b/i;

/** Whether `message` states a durable preference or a recurring way of working ("我每次都按…写", "以后…都…", "from now on …"). */
export function statesRecurringWay(message: string): boolean {
  const s = (message || "").normalize("NFKC");
  for (const clause of s.split(/[。！!？?\n；;]+/)) {
    const zh = RECURRING_ZH.test(clause) && !NOT_ZH.test(clause);
    const en = RECURRING_EN.test(clause) && !NOT_EN.test(clause);
    if (zh || en) return true;
  }
  return false;
}

/** How many drafts the platform may make in one conversation in a day, and how long a Discard here keeps it quiet. */
export const AUTO_DRAFTS_PER_DAY = 3;
export const AUTO_DRAFT_QUIET_AFTER_DISCARD_HOURS = 24;
/** One card per conversation per skill name, for this long. */
export const AUTO_DRAFT_SAME_NAME_DAYS = 7;
/** The conversation the draft is written from: the last few messages, each cut to this many characters. */
const CONTEXT_MESSAGES = 8;
const CONTEXT_MESSAGE_CHARS = 2000;

export interface AutoDraftProposal { worth?: unknown; name?: unknown; description?: unknown; content?: unknown }

const DRAFT_PROMPT = `You turn a way of working a user stated into a personal skill for their assistant.

The conversation (oldest first; "user" is the person, "assistant" is their assistant):
{conversation}

The user's latest message, the one that states the preference:
{message}

The user's personal skills now (name: description), from the database; anything the conversation says about their skills may be out of date:
{skills}

Decide whether the latest message states a reusable way of working the user wants kept (a format, a structure, steps, a style they
always use). If it does not (a one-off request, a question, a complaint, a preference that is not about how a task is done), or one
of the skills above already covers it, answer {"worth": false}.

If it does, write the skill from this conversation only (never from a skill mentioned earlier in it, which may no longer exist):
- name: kebab-case, lowercase letters, digits and "-", at most 40 characters, naming the task (e.g. "meeting-notes").
- description: one sentence, in the user's language, saying when to use it.
- content: the SKILL.md body in Markdown, in the user's language: when it applies, and the exact format or steps the user stated,
  with nothing they did not state. No secrets, no links, no instructions about anything else.

Answer with JSON only: {"worth": true, "name": "...", "description": "...", "content": "..."}`;

/** The model call, a port so a test can answer it. */
export const autoDraftPorts = {
  propose: (userId: string, vars: { conversation: string; message: string; skills: string }): Promise<AutoDraftProposal> =>
    callMemoryLLM<AutoDraftProposal>(userId, DRAFT_PROMPT, vars, { maxTokens: 2048, temperature: 0 }),
};

type Outcome =
  | "off" | "not_served" | "no_message" | "not_attended" | "no_preference" | "turn_wrote_skill" | "quiet" | "limit"
  | "declined" | "invalid" | "has_skill" | "drafted_here" | "duplicate" | "names_removed" | "refused" | "drafted";

/**
 * After a router turn answering `messageId` in `sessionId`: a draft of the skill the message states, with its card, when it states one
 * and the turn made none. Never throws for an expected reason; the caller runs it in the background.
 */
export async function maybeAutoDraft(input: { sessionId: string; userId: string; messageId?: string | null }): Promise<Outcome> {
  const out = await autoDraft(input);
  if (out !== "no_preference" && out !== "off" && out !== "not_served" && out !== "no_message") {
    logger.info({ sessionId: input.sessionId, messageId: input.messageId, outcome: out }, "skill.auto_draft");
  }
  if (out === "drafted") metrics.onUserSkillSave("draft", "ok");
  return out;
}

async function autoDraft({ sessionId, userId, messageId }: { sessionId: string; userId: string; messageId?: string | null }): Promise<Outcome> {
  if (!CLAW_USER_SKILLS_ENABLED) return "off";
  if (!messageId) return "no_message";
  const q = (t: string, p?: unknown[]) => db.query(t, p);
  if (!(await routerSkillsServe(q, sessionId, userId))) return "not_served";
  const msg = await turnMessage(q, sessionId, messageId);
  if (!msg) return "no_message";
  if (!msg.attendedVia) return "not_attended";
  if (!statesRecurringWay(msg.content)) return "no_preference";
  // The turn wrote a skill itself (saved, drafted, or tried and was refused): it said what it had to.
  const wrote = (await q(
    `SELECT 1 FROM claw_skill_events WHERE user_id = $1 AND session_id = $2 AND created_at >= $3
        AND op IN ('draft', 'create', 'update', 'refused') LIMIT 1`,
    [userId, sessionId, msg.receivedAt],
  )).rows.length > 0;
  if (wrote) return "turn_wrote_skill";
  const discarded = (await q(
    `SELECT 1 FROM claw_assistant_confirmations WHERE user_id = $1 AND session_id = $2 AND kind = 'skill_save' AND status = 'denied'
        AND decided_at > NOW() - make_interval(hours => $3::int) LIMIT 1`,
    [userId, sessionId, AUTO_DRAFT_QUIET_AFTER_DISCARD_HOURS],
  )).rows.length > 0;
  if (discarded) return "quiet";
  const today = Number((await q(
    `SELECT COUNT(*)::int AS n FROM claw_skill_events WHERE user_id = $1 AND session_id = $2 AND op = 'draft' AND actor = 'auto'
        AND created_at > NOW() - INTERVAL '1 day'`,
    [userId, sessionId],
  )).rows[0].n);
  if (today >= AUTO_DRAFTS_PER_DAY) return "limit";

  const skills = (await listUserSkills(userId)).map((x) => `- ${x.name}: ${x.description.replace(/\s+/g, " ").slice(0, 200)}`).join("\n") || "(none)";
  const proposal = await autoDraftPorts.propose(userId, { conversation: await conversationOf(sessionId, userId, messageId), message: msg.content, skills });
  if (proposal?.worth !== true) return "declined";
  const name = typeof proposal.name === "string" ? proposal.name.trim().toLowerCase() : "";
  const content = typeof proposal.content === "string" ? proposal.content : "";
  const description = typeof proposal.description === "string" ? proposal.description.trim() : "";
  if (!USER_SKILL_NAME_RE.test(name) || !content.trim()) return "invalid";
  const has = (await q(
    "SELECT 1 FROM claw_skills WHERE user_id = $1 AND skill_name = $2 AND status IN ('active', 'probation') AND deleted_at IS NULL LIMIT 1",
    [userId, name],
  )).rows.length > 0;
  if (has) return "has_skill";
  const here = (await q(
    `SELECT 1 FROM claw_skill_events WHERE user_id = $1 AND session_id = $2 AND skill_name = $3 AND op = 'draft'
        AND created_at > NOW() - make_interval(days => $4::int) LIMIT 1`,
    [userId, sessionId, name, AUTO_DRAFT_SAME_NAME_DAYS],
  )).rows.length > 0;
  if (here) return "drafted_here";
  if (await sameSkillUnderAnotherName(userId, name, content, [])) return "duplicate";
  if (await removedSkillNamed(userId, name, [content, description], msg.content)) return "names_removed";
  const made = await createSkillDraft(userId, { name, description, content, files: [] },
    { origin: "auto", actor: "auto", sessionId, requestQuote: msg.content.slice(0, 500) });
  if (!made.ok) return "refused";
  await showDraftCard(userId, sessionId, messageId, made.draft);
  return "drafted";
}

/** The conversation up to the turn's answer: the session's last messages from the user and the assistant's says, oldest first. */
async function conversationOf(sessionId: string, userId: string, messageId: string): Promise<string> {
  const cut = (t: string) => ([...t].length > CONTEXT_MESSAGE_CHARS ? `${[...t].slice(0, CONTEXT_MESSAGE_CHARS).join("")}…` : t);
  // Up to the turn's own message, compared in the database (a timestamp read back into JavaScript loses its microseconds).
  const users = (await db.query(
    `SELECT content, received_at AS at FROM claw_assistant_messages
      WHERE session_id = $1 AND received_at <= (SELECT received_at FROM claw_assistant_messages WHERE session_id = $1 AND message_id = $2)
      ORDER BY received_at DESC LIMIT $3`,
    [sessionId, messageId, CONTEXT_MESSAGES],
  )).rows as Array<{ content: string; at: Date }>;
  if (!users.length) return "";
  const since = users[users.length - 1].at;
  // The assistant's own answers in this conversation up to the next message after the turn's: not a report about an item, not one
  // shown in another session, not one of a later turn.
  const says = (await db.query(
    `SELECT text AS content, created_at AS at FROM claw_assistant_says
      WHERE user_id = $1 AND created_at >= $2 AND NOT fallback AND item_id IS NULL AND (session_id IS NULL OR session_id = $4)
        AND created_at < COALESCE((SELECT MIN(m.received_at) FROM claw_assistant_messages m WHERE m.session_id = $4
              AND m.received_at > (SELECT received_at FROM claw_assistant_messages WHERE session_id = $4 AND message_id = $5)), 'infinity')
      ORDER BY created_at DESC LIMIT $3`,
    [userId, since, CONTEXT_MESSAGES, sessionId, messageId],
  )).rows as Array<{ content: string; at: Date }>;
  return [...users.map((m) => ({ ...m, who: "user" })), ...says.map((m) => ({ ...m, who: "assistant" }))]
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    .map((m) => `${m.who}: ${cut(String(m.content ?? ""))}`)
    .join("\n\n");
}
