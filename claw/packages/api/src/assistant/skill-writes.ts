// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Saving and managing the user's personal skills from a conversation (`CLAW_USER_SKILLS_ENABLED`):
 *
 *  - The user asks for it ("存成技能", "沉淀成 skill", "save this as a skill"): it is saved at once, and a card says what was saved,
 *    with Undo and Edit. The router does it itself with `skill_save`, from what the conversation holds: one hop, no worker, no sandbox,
 *    and the card is in the same chat the request was made in. (Handing it to a worker is two hops more, a new item and a report back,
 *    and the worker has to be told the user's words second hand.) The request is the user's own words, quoted, and checked against the
 *    message the turn answers (`quoteIsFrom`) and read as a request to save (`asksToSaveSkill`); the turn must answer a message the user
 *    sent signed in (`attendedTurn`), asked again in the transaction that writes.
 *  - The assistant suggests it on its own: `skill_draft` keeps a draft (`claw_skill_drafts`) and shows a card with Save and Discard; only
 *    the user's press (the card's `skill_save` confirmation, `schedules.ts`), the typed approval command, or their own yes in words
 *    (`skill_save` with the draft's id, the yes quoted) saves it.
 *  - A worker's save_skill (`handleWorkerSkillWrites`, from its completion): saved at once only with the user's own request quoted from
 *    what they wrote; otherwise a draft, as above.
 *  - Both: the same checks as every save (name, size, room, a secret or an instruction hijack refused with where it is and never what),
 *    and a refusal is the answer the user is told. Every write is audited (`claw_skill_events`) and recorded so it can be undone for a day
 *    (`claw_skill_changes`): a new skill deleted again, an update back to the version before, a delete restored, a turn-off turned back.
 *
 * Only the user's own assistant, in a conversation their skills serve (`routerSkillsServe`): never a group's, an observer's or a review's.
 */
import pino from "pino";
import { db, inTransaction, type Querier } from "../infra/db.js";
import { metrics } from "../infra/metrics.js";
import { publishEvent } from "../events/store.js";
import { normalizeText, quoteIsFrom } from "../memory/gates.js";
import { humanMessages } from "../memory/service.js";
import {
  confirmSkillDraft, createSkillDraft, deleteUserSkillRecorded, discardSkillDraft, latestUndoableChange, listUserSkills, pendingSkillDrafts,
  readSkillDraft, refreshChangeAfter, removedSkills, sameSkillUnderAnotherName, saveUserSkillRecorded, setUserSkillEnabled, showUserSkill, undoSkillChange,
  addSkillFile, updateSkillFile, removeSkillFile,
  type SkillDraft, type SkillWriteRefused,
} from "../marketplace/skill-service.js";
import type { AssistantSkillCard } from "../notifications/assistant-events.js";
import type { PendingSkill, PendingSkillFileMutation } from "@claw/protocol";
import { recordSkillCard, type SayDeps } from "./outbound.js";
import { proposeConfirmation } from "./schedules.js";
import { asksToAct, asksToChangeSkill, asksToSaveSkill, confirmsDraft, negatedBefore } from "./skill-intent.js";
import { routerSkillsServe } from "./skill-tools.js";
import type { AssistantTokenClaims } from "./token.js";
import { assertLiveRun, attendedTurn, ToolRefused } from "./tools.js";
import { commandLanguageOf, type CommandLanguage } from "./typed-commands.js";

const logger = pino({ name: "assistant-skill-writes" });

/** What leaves the module after a commit, so a test can see it: the card's announcement, and a session event where there is no assistant. */
export const skillWritePorts: { sayDeps: SayDeps; publishSessionEvent: (sessionId: string, event: Record<string, unknown>) => Promise<void> } = {
  sayDeps: {},
  publishSessionEvent: async (sessionId, event) => { await publishEvent(sessionId, event as any); },
};

/** The lines of SKILL.md a card shows. */
export const CARD_PREVIEW_LINES = 30;
export const CARD_PREVIEW_CHARS = 1500;
/** How long before its item was started a worker's quote of the user's request may have been said (the request that started it). */
const WORKER_QUOTE_WINDOW_MIN = 10;

export function previewOf(content: string): string {
  const lines = (content || "").split(/\r?\n/).slice(0, CARD_PREVIEW_LINES).join("\n");
  const chars = [...lines];
  return chars.length > CARD_PREVIEW_CHARS ? `${chars.slice(0, CARD_PREVIEW_CHARS - 1).join("")}…` : lines;
}

const hasHan = (text: string): boolean => /\p{Script=Han}/u.test(text);

// --- What the user is told ---------------------------------------------------------------------------------------------

/** The card's message in words, for a channel that draws no card, in the language of the conversation. */
export function skillCardText(card: AssistantSkillCard, lang: CommandLanguage): string {
  const zh = lang === "zh";
  const files = card.files.length ? card.files.map((f) => f.path).join(", ") : "";
  const manual = card.invocation === "manual" ? (zh ? "（只在你点名时使用）" : " (used only when you name it)") : "";
  const about = card.description ? (zh ? `\n用途：${card.description}` : `\nWhen to use it: ${card.description}`) : "";
  const withFiles = files ? (zh ? `\n附带文件：${files}` : `\nFiles: ${files}`) : "";
  switch (card.kind) {
    case "saved":
      return card.created
        ? (zh
          ? `已存为你的个人技能「${card.name}」v${card.version}${manual}。${about}${withFiles}\n以后相关的请求会自动用到它。点「撤销」可撤回，点「修改」可编辑；也可以跟我说「撤销技能 ${card.name}」。`
          : `Saved as your personal skill "${card.name}" v${card.version}${manual}.${about}${withFiles}\nRelated requests will use it from now on. Press Undo to take it back or Edit to change it, or tell me "undo skill ${card.name}".`)
        : (zh
          ? `已更新你的个人技能「${card.name}」，现在是 v${card.version}${manual}。${about}${withFiles}\n点「撤销」回到上一版，点「修改」可再编辑。`
          : `Updated your personal skill "${card.name}", now v${card.version}${manual}.${about}${withFiles}\nPress Undo to go back to the version before, or Edit to change it again.`);
    case "deleted":
      return zh ? `已删除你的个人技能「${card.name}」。点「撤销」可以恢复（24 小时内）。` : `Deleted your personal skill "${card.name}". Press Undo to bring it back (within 24 hours).`;
    case "disabled":
      return zh ? `已停用你的个人技能「${card.name}」：它还在，但不会再被用到。点「撤销」可重新启用。` : `Turned off your personal skill "${card.name}": it is kept but not used. Press Undo to turn it back on.`;
    case "enabled":
      return zh ? `已重新启用你的个人技能「${card.name}」。` : `Turned your personal skill "${card.name}" back on.`;
    case "draft":
      return zh
        ? `我起草了一个个人技能「${card.name}」，还没有保存。${about}${withFiles}\n要保存吗？点「保存」保存，点「放弃」丢弃，或者直接回复「保存」。`
        : `I drafted a personal skill "${card.name}"; nothing is saved yet.${about}${withFiles}\nSave it? Press Save, or Discard, or just reply "save it".`;
  }
}

/** The card of a skill as it is now (`saved`, `disabled`, `enabled`), or, given `before`, as it was (`deleted`). */
async function cardNow(userId: string, name: string, kind: AssistantSkillCard["kind"], extra: Partial<AssistantSkillCard> = {}): Promise<AssistantSkillCard | null> {
  const s = await showUserSkill(userId, name);
  if (!s) return null;
  return {
    kind, name: s.name, version: s.version, description: s.description, invocation: s.invocation,
    files: s.file_list.map((f) => ({ path: f.path, size_bytes: f.size_bytes })), preview: kind === "deleted" ? "" : previewOf(s.content), ...extra,
  };
}

function draftCard(d: SkillDraft, confirmationId: string): AssistantSkillCard {
  return {
    kind: "draft", name: d.skill_name, version: d.replaces ? Number(d.replaces.replace(/^v/, "")) + 1 : 1, created: !d.replaces,
    description: d.description, invocation: d.invocation ?? "auto",
    files: d.files.map((f) => ({ path: f.path, size_bytes: Buffer.byteLength(f.content, "utf8") })), preview: previewOf(d.content),
    confirmation_id: confirmationId,
  };
}

/** Store and announce a card in the user's assistant session. A failure is logged, never the tool's: the write it tells of is done. */
async function showCard(input: { userId: string; sessionId: string; turnMessageId?: string; lang: CommandLanguage; card: AssistantSkillCard; key: string }): Promise<number> {
  try {
    const out = await inTransaction((q) => recordSkillCard(q, {
      userId: input.userId, sessionId: input.sessionId, text: skillCardText(input.card, input.lang), card: input.card, key: input.key,
      ...(input.turnMessageId ? { turnMessageId: input.turnMessageId } : {}),
    }, skillWritePorts.sayDeps));
    if (out) await out.announce();
    return out?.subscribers ?? 0;
  } catch (err) {
    logger.error({ err, userId: input.userId, skill: input.card.name, kind: input.card.kind }, "assistant.skill_card_failed");
    return 0;
  }
}

// --- Whose turn it is --------------------------------------------------------------------------------------------------

function requireRouter(claims: AssistantTokenClaims): void {
  if (claims.role !== "router") throw new ToolRefused("not_allowed", `this tool is for the router, not the ${claims.role}`);
}

async function requireServed(q: Querier, claims: AssistantTokenClaims, userId: string): Promise<void> {
  if (!(await routerSkillsServe(q, claims.sid, userId))) {
    throw new ToolRefused("skills_not_here", "the user's personal skills are not available in this conversation");
  }
}

/** A turn that acts on the user's skills: it answers a message they sent signed in, fresh, in a conversation their skills serve. */
async function actingTurn(claims: AssistantTokenClaims): Promise<{ userId: string; content: string; lang: CommandLanguage }> {
  requireRouter(claims);
  return inTransaction(async (q) => {
    let turn;
    try {
      turn = await attendedTurn(q, claims);
    } catch (err) {
      // What a worker wrote is in this turn now: a skill written from it is the user's to look at first, on a draft's card.
      if (err instanceof ToolRefused && err.code === "read_untrusted") {
        throw new ToolRefused("read_untrusted", "this turn has read what a worker wrote, so it saves nothing at once: use skill_draft instead, and the user saves it with one press of Save");
      }
      throw err;
    }
    await requireServed(q, claims, turn.userId);
    const lang = await commandLanguageOf(turn.message.content, undefined, turn.message.context.reply_language ?? null);
    return { userId: turn.userId, content: turn.message.content, lang };
  });
}

/** The same question inside the transaction that writes: a turn interrupted since writes nothing. */
function stillActing(claims: AssistantTokenClaims, userId: string): (q: Querier) => Promise<void> {
  return async (q) => {
    if ((await attendedTurn(q, claims)).userId !== userId) throw new ToolRefused("turn_not_live", "the session changed hands");
  };
}

/** A live turn of the user's own assistant, whoever's message it answers (a draft only shows a card; reading only reads). */
async function liveTurn(claims: AssistantTokenClaims): Promise<string> {
  requireRouter(claims);
  return inTransaction(async (q) => {
    const { userId } = await assertLiveRun(q, claims);
    await requireServed(q, claims, userId);
    return userId;
  });
}

function text(v: unknown, field: string, max = 64_000): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new ToolRefused("invalid_arguments", `${field} is text`);
  if (v.length > max) throw new ToolRefused("invalid_arguments", `${field} is too long`);
  return v;
}

function nameOf(v: unknown): string {
  const name = text(v, "name", 200).trim();
  if (!name) throw new ToolRefused("invalid_arguments", "name is the skill's name, such as weekly-report");
  return name;
}

function filesOf(v: unknown): Array<{ path: string; content: string }> {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ToolRefused("invalid_arguments", "files is a list of {path, content}");
  return v.map((f, i) => {
    const path = typeof f?.path === "string" ? f.path.trim() : "";
    if (!path || typeof f?.content !== "string") throw new ToolRefused("invalid_arguments", `files[${i}] needs a path and its content as text`);
    return { path, content: f.content as string };
  });
}

function invocationOf(v: unknown): "auto" | "manual" | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (v === "auto" || v === "manual") return v;
  throw new ToolRefused("invalid_arguments", "invocation is auto (used whenever it fits) or manual (used only when the user names it)");
}

/** The quote is the user's own words from the message this turn answers, and says what `says` asks for; else a refusal saying what to do. */
/**
 * The words of `message` just before `quote` in it: what a negation in front of the quote would be ("不要" + "把这个存成技能"). Found
 * as written, else as the quote check normalises both (`normalizeText`); "" when the quote starts the message.
 */
export function textBefore(message: string, quote: string): string {
  const at = message.indexOf(quote);
  if (at >= 0) return message.slice(0, at);
  const m = normalizeText(message);
  const i = m.indexOf(normalizeText(quote));
  return i > 0 ? m.slice(0, i) : "";
}

function requireQuote(content: string, quote: unknown, says: (q: string) => boolean, notSaid: string): string {
  const q = typeof quote === "string" ? quote : "";
  if (!quoteIsFrom(q, [content])) {
    throw new ToolRefused("quote_not_from_user", "request_quote must be the user's own words from the message you are answering, copied exactly");
  }
  // A quote cut out of a sentence that says not to ("不要" + "把这个存成技能", "don't" + "delete weekly-report") asks for nothing.
  if (!says(q) || negatedBefore(textBefore(content, q))) throw new ToolRefused("not_asked", notSaid);
  return q;
}

function refused(op: Parameters<typeof metrics.onUserSkillSave>[0], r: { error: string; message: string }): never {
  metrics.onUserSkillSave(op, r.error);
  throw new ToolRefused(r.error, r.message);
}

// --- The router's tools ------------------------------------------------------------------------------------------------

/** How long a removed skill stays one a new skill may not name. */
const REMOVED_NAME_DAYS = 30;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `text` names `name` as a skill: marked as one (`/name`, `name` in quotes or backticks, 「name」, "name skill", "name 技能",
 * "skill name", "技能 name"), never as a word in prose ("Send a follow-up email" does not name the skill follow-up).
 */
export function marksSkill(text: string, name: string): boolean {
  const t = (text || "").normalize("NFKC").toLowerCase();
  const n = escapeRe(name.toLowerCase());
  const W = "a-z0-9_-";
  return new RegExp(
    `(?:(?<![^\\s])/${n}(?![${W}])|[\`"'“「]${n}[\`"'”」]|(?<![${W}])${n}\\s*(?:skill|技能)|(?:skill|技能)\\s*[:：]?\\s*${n}(?![${W}]))`,
  ).test(t);
}

/** Whether `text` holds `name` as a word of its own: "deploy" is not in "deploy-prod". */
function namesWord(text: string, name: string): boolean {
  return new RegExp(`(?<![a-z0-9_-])${escapeRe(name.toLowerCase())}(?![a-z0-9_-])`).test((text || "").normalize("NFKC").toLowerCase());
}

/** A skill the user deleted or undid lately that `texts` (a new skill's) names as a skill, other than `name` and one their `message` names. */
export async function removedSkillNamed(
  userId: string, name: string, texts: string[], message = "",
): Promise<{ name: string; how: string } | null> {
  const text = texts.join("\n");
  const since = Date.now() - REMOVED_NAME_DAYS * 86_400_000;
  return (await removedSkills(userId)).find((r) =>
    r.name !== name && Date.parse(r.removed_at) >= since && marksSkill(text, r.name) && !namesWord(message, r.name)) ?? null;
}

/**
 * A skill written from a conversation does not point at a skill the user removed lately (deleted, or a save they undid, in the last
 * `REMOVED_NAME_DAYS`): what the router remembers of an earlier turn is not theirs any more. Only a name marked as a skill counts
 * (`marksSkill`), and never one the user's own message of this turn names: they may mean it. A refusal the router writes it again for.
 */
async function requireNoRemovedSkill(
  userId: string, name: string, texts: string[], op: "create" | "draft" | "update", message = "",
): Promise<void> {
  const named = await removedSkillNamed(userId, name, texts, message);
  if (named) {
    refused(op, {
      error: "names_removed_skill",
      message: `the skill names ${named.name}, a skill the user ${named.how === "undone" ? "undid" : "deleted"}: write it without ${named.name}, from this conversation only`,
    });
  }
}

/**
 * A refused write of a skill is noted for the turn (`claw_skill_events` op `refused`, this session): the router must be able to tell the
 * user why, and the say guard (`skill-suggestion.ts`) lets every say of a turn that had a refused skill write go. Best effort: a note
 * that cannot be written never turns the refusal into a fault.
 */
const SAVE_CHECK_REFUSALS = new Set(["secret", "injection", "invalid", "invalid_name", "too_large", "too_many_files", "full"]);

function notingRefusals<A extends unknown[]>(
  run: (claims: AssistantTokenClaims, ...args: A) => Promise<Record<string, unknown>>,
): (claims: AssistantTokenClaims, ...args: A) => Promise<Record<string, unknown>> {
  return async (claims, ...args) => {
    try {
      return await run(claims, ...args);
    } catch (err) {
      // (a refusal of the save's own checks is recorded by the save already: `recordRefusal`)
      if (err instanceof ToolRefused && !SAVE_CHECK_REFUSALS.has(err.code)) {
        await db.query(
          `INSERT INTO claw_skill_events (user_id, skill_name, op, actor, session_id, detail)
           SELECT s.user_id, $2, 'refused', 'model', $1, $3::jsonb FROM claw_sessions s WHERE s.session_id = $1`,
          [claims.sid, String((args[0] as { name?: unknown } | undefined)?.name ?? "").slice(0, 200), JSON.stringify({ reason: err.code, tool: run.name })],
        ).catch((e) => logger.warn({ err: (e as Error)?.message, sid: claims.sid }, "skill.refusal_note_failed"));
      }
      throw err;
    }
  };
}

/** `skill_list`: the user's skills (turned off and manual ones included) and the drafts waiting for their answer. Read-only. */
export async function skillList(claims: AssistantTokenClaims): Promise<Record<string, unknown>> {
  const userId = await liveTurn(claims);
  const [skills, drafts, removed] = await Promise.all([listUserSkills(userId), pendingSkillDrafts(userId), removedSkills(userId)]);
  return {
    ok: true,
    skills: skills.map((s) => ({
      name: s.name, version: s.version, description: s.description, ...(s.enabled ? {} : { turned_off: true }),
      ...(s.invocation === "manual" ? { manual: true } : {}), ...(s.origin === "import" ? { imported: true } : {}), files: s.files,
      last_used_at: s.last_used_at,
    })),
    drafts_waiting: drafts.map((d) => ({ draft_id: d.id, name: d.skill_name, description: d.description, drafted_at: d.created_at })),
    // Skills the user had and has no longer: deleted by them, or a save they undid. Said as it is, never as a failure.
    deleted_lately: removed.map((r) => ({ name: r.name, how: r.how, removed_at: r.removed_at })),
  };
}

/**
 * `skill_save`: the user asked for a skill to be saved (new, or a new version of one of theirs), or said yes to a draft (`draft_id`).
 * Saved now, with a card that says what was saved and offers Undo and Edit.
 */
export const skillSave = notingRefusals(async function skillSave(claims: AssistantTokenClaims, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { userId, content: message, lang } = await actingTurn(claims);
  const draftId = typeof args.draft_id === "string" ? args.draft_id.trim() : "";
  if (draftId) {
    // The whole message, not a quote out of it: a yes is a short reply of its own, or a sentence that names the draft's skill and
    // says to save it (`confirmsDraft`).
    requireQuote(message, args.request_quote, () => true, "");
    const draft = await readSkillDraft(userId, draftId);
    if (!confirmsDraft(message, draft?.skill_name ?? "")) {
      refused("create", {
        error: "not_asked",
        message: "the user's message is no yes to the draft: a yes is a short reply (好的, 可以, yes, ok, save it) or names the skill and says to save it; ask them, or let them press Save on its card",
      });
    }
    const saved = await inTransaction(async (q) => {
      const out = await confirmSkillDraft(userId, draftId, { actor: "model_confirmed", sessionId: claims.sid, query: q, guard: stillActing(claims, userId) });
      // Its card is answered too: a later press of Save is told it was saved already.
      if (out.ok) {
        await q(
          `UPDATE claw_assistant_confirmations SET status = 'done', result = $3::jsonb, decided_via = 'command', decided_at = NOW()
            WHERE user_id = $1 AND kind = 'skill_save' AND status = 'pending' AND params->>'draft_id' = $2`,
          [userId, draftId, JSON.stringify({ ok: true, name: out.draft.skill_name, version: out.version, created: out.created })],
        );
      }
      return out;
    });
    if (!saved.ok) refused("create", saved);
    return announceSaved(claims, userId, lang, saved, saved.draft.skill_name);
  }
  requireQuote(message, args.request_quote, asksToSaveSkill,
    "the user's words do not ask to save this as a skill: if saving it is your own idea, use skill_draft so they confirm it first");
  const name = nameOf(args.name);
  const content = text(args.content, "content");
  const files = filesOf(args.files);
  const invocation = invocationOf(args.invocation);
  await requireNoRemovedSkill(userId, name, [content, text(args.description, "description")], "create", message);
  const same = await sameSkillUnderAnotherName(userId, name, content, files);
  if (same) refused("create", { error: "duplicate", message: `the user already has exactly this skill, named ${same}: nothing was saved; tell them` });
  const saved = await saveUserSkillRecorded(userId, {
    name, description: text(args.description, "description"), content, files, ...(invocation ? { invocation } : {}),
  }, { origin: "chat", actor: "model", sessionId: claims.sid, guard: stillActing(claims, userId) });
  if (!saved.ok) refused("create", saved);
  return announceSaved(claims, userId, lang, saved, name);
});

async function announceSaved(
  claims: AssistantTokenClaims, userId: string, lang: CommandLanguage,
  saved: { version: number; created: boolean; changed: boolean; change_id?: string; undo_expires_at?: string }, name: string,
): Promise<Record<string, unknown>> {
  if (!saved.changed || !saved.change_id) {
    metrics.onUserSkillSave(saved.created ? "create" : "update", "unchanged");
    return { ok: true, name, version: saved.version, changed: false, note: "the user already has this skill exactly so: nothing changed; tell them in one line" };
  }
  metrics.onUserSkillSave(saved.created ? "create" : "update", "ok");
  const card = await cardNow(userId, name, "saved", { created: saved.created, change_id: saved.change_id, undo_expires_at: saved.undo_expires_at });
  const subscribers = card ? await showCard({ userId, sessionId: claims.sid, turnMessageId: claims.mid, lang, card, key: saved.change_id }) : 0;
  return {
    ok: true, name, version: saved.version, created: saved.created, change_id: saved.change_id,
    note: `${saved.created ? "saved" : "updated"}: the user was shown a card with what was saved and Undo and Edit buttons. Tell them in one short line; do not repeat the card.`
      + (subscribers === 0 ? ` No chat of theirs can draw the card now, so add that they can say "undo skill ${name}" (撤销技能 ${name}) to take it back.` : ""),
  };
}

/** `skill_draft`: a skill the assistant suggests on its own, shown as a draft with Save and Discard; nothing is saved until the user says so. */
export const skillDraft = notingRefusals(async function skillDraft(claims: AssistantTokenClaims, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const userId = await liveTurn(claims);
  const name = nameOf(args.name);
  const content = text(args.content, "content");
  const files = filesOf(args.files);
  const invocation = invocationOf(args.invocation);
  const lang: CommandLanguage = hasHan(`${args.description ?? ""}${content}`) ? "zh" : "en";
  await requireNoRemovedSkill(userId, name, [content, text(args.description, "description")], "draft");
  const same = await sameSkillUnderAnotherName(userId, name, content, files);
  if (same) refused("draft", { error: "duplicate", message: `the user already has exactly this skill, named ${same}: no draft was made` });
  const out = await inTransaction(async (q) => {
    const made = await createSkillDraft(userId, {
      name, description: text(args.description, "description"), content, files, ...(invocation ? { invocation } : {}),
    }, { origin: "chat", actor: "model", sessionId: claims.sid, query: q });
    if (!made.ok) return made;
    const d = made.draft;
    const card = await proposeConfirmation(q, claims, userId, "skill_save", { draft_id: d.id, name: d.skill_name, description: d.description }, {
      text: () => skillCardText(draftCard(d, ""), lang), allowLabel: lang === "zh" ? "保存" : "Save",
      skillCard: (confirmationId) => draftCard(d, confirmationId),
    });
    return { ok: true as const, draft: d, ...card };
  });
  if (!out.ok) refused("draft", out as SkillWriteRefused);
  metrics.onUserSkillSave("draft", "ok");
  if (out.announce) await out.announce();
  return {
    ok: true, draft_id: out.draft.id, name, saved: false,
    note: "nothing is saved yet: the user was shown the draft on a card with Save and Discard, and the card is the question; do not ask it again "
      + `in words. If they say yes in words, call skill_save with draft_id ${out.draft.id} and their yes as request_quote.`,
  };
});

/**
 * A draft's card with Save and Discard in the user's assistant session (`sessionId`), kept for the turn `messageId`: the card
 * `skill_draft` shows, for a draft the platform made (a worker's, or one drafted after a turn, `skill-auto-draft.ts`).
 */
export async function showDraftCard(userId: string, sessionId: string, messageId: string, d: SkillDraft): Promise<void> {
  const lang: CommandLanguage = hasHan(`${d.description}${d.content}`) ? "zh" : "en";
  const out = await inTransaction((q) => proposeConfirmation(q, { sid: sessionId, mid: messageId }, userId, "skill_save",
    { draft_id: d.id, name: d.skill_name, description: d.description }, {
      text: () => skillCardText(draftCard(d, ""), lang), allowLabel: lang === "zh" ? "保存" : "Save",
      skillCard: (confirmationId) => draftCard(d, confirmationId),
    }));
  if (out.announce) await out.announce();
}

/** `skill_update`: the user asked for a change to one of their skills. Saved now as its next version, with the card (Undo goes back). */
export const skillUpdate = notingRefusals(async function skillUpdate(claims: AssistantTokenClaims, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { userId, content: message, lang } = await actingTurn(claims);
  const name = nameOf(args.name);
  requireQuote(message, args.request_quote, (q) => asksToChangeSkill(q, name), "the user's words do not ask to change this skill");
  const now = await showUserSkill(userId, name);
  if (!now) refused("update", { error: "not_found", message: `the user has no skill named ${name}` });
  const invocation = invocationOf(args.invocation);
  await requireNoRemovedSkill(userId, name, [text(args.content, "content"), text(args.description, "description")], "update", message);
  const saved = await saveUserSkillRecorded(userId, {
    name,
    description: args.description === undefined || args.description === null ? now.description : text(args.description, "description"),
    content: args.content === undefined || args.content === null ? now.content : text(args.content, "content"),
    files: filesOf(args.files), ...(invocation ? { invocation } : {}),
  }, { origin: "chat", actor: "model", sessionId: claims.sid, guard: stillActing(claims, userId) });
  if (!saved.ok) refused("update", saved);
  return announceSaved(claims, userId, lang, saved, name);
});

/** `skill_disable` / `skill_enable`: the user asked to stop using one of their skills (kept), or to use it again. */
export const skillSetEnabled = notingRefusals(async function skillSetEnabled(claims: AssistantTokenClaims, args: Record<string, unknown>, enabled: boolean): Promise<Record<string, unknown>> {
  const { userId, content: message, lang } = await actingTurn(claims);
  const name = nameOf(args.name);
  const op = enabled ? "enable" : "disable";
  requireQuote(message, args.request_quote, (q) => asksToAct(q, op, name), `the user's words do not ask to ${enabled ? "turn this skill on" : "turn this skill off"}`);
  const out = await setUserSkillEnabled(userId, name, enabled, { actor: "model", sessionId: claims.sid, guard: stillActing(claims, userId) });
  if (!out.ok) refused(op, out);
  metrics.onUserSkillSave(op, out.changed ? "ok" : "unchanged");
  if (!out.changed) return { ok: true, name, changed: false, note: `it was ${enabled ? "on" : "off"} already; tell them` };
  const card = await cardNow(userId, name, enabled ? "enabled" : "disabled", { change_id: out.change_id, undo_expires_at: out.undo_expires_at });
  if (card) await showCard({ userId, sessionId: claims.sid, turnMessageId: claims.mid, lang, card, key: out.change_id! });
  return { ok: true, name, enabled, change_id: out.change_id, note: "done: the user was shown a card with Undo. Tell them in one line." };
});

/** `skill_delete`: the user asked to delete one of their skills. Deleted now (every version), with a card whose Undo restores it. */
export const skillDelete = notingRefusals(async function skillDelete(claims: AssistantTokenClaims, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { userId, content: message, lang } = await actingTurn(claims);
  const name = nameOf(args.name);
  requireQuote(message, args.request_quote, (q) => asksToAct(q, "delete", name), "the user's words do not ask to delete this skill");
  const before = await cardNow(userId, name, "deleted");
  const out = await deleteUserSkillRecorded(userId, name, { actor: "model", sessionId: claims.sid, guard: stillActing(claims, userId) });
  if (!out.ok) refused("delete", out);
  metrics.onUserSkillSave("delete", "ok");
  const card: AssistantSkillCard = before
    ? { ...before, version: out.version, change_id: out.change_id, undo_expires_at: out.undo_expires_at }
    : { kind: "deleted", name, version: out.version, description: "", invocation: "auto", files: [], preview: "", change_id: out.change_id, undo_expires_at: out.undo_expires_at };
  await showCard({ userId, sessionId: claims.sid, turnMessageId: claims.mid, lang, card, key: out.change_id! });
  return { ok: true, name, deleted: true, change_id: out.change_id, note: "deleted: the user was shown a card whose Undo restores it. Tell them in one line." };
});

/** `skill_undo`: the user asked to take back the last change of one of their skills (a save, an update, a delete, a turn-off). */
export const skillUndo = notingRefusals(async function skillUndo(claims: AssistantTokenClaims, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { userId, content: message } = await actingTurn(claims);
  const name = nameOf(args.name);
  requireQuote(message, args.request_quote, (q) => asksToAct(q, "undo", name), "the user's words do not ask to undo a change of this skill");
  const change = await latestUndoableChange(userId, name);
  if (!change) refused("undo", { error: "not_found", message: `there is no change of ${name} in the last day to undo` });
  const out = await undoSkillChange(userId, change.id, { actor: "model", sessionId: claims.sid, guard: stillActing(claims, userId) });
  if (!out.ok) refused("undo", out);
  metrics.onUserSkillSave("undo", "ok");
  return { ok: true, name, undone: out.undone, version: out.version, note: "undone: tell the user in one line what it is now" };
});

// --- A draft's card, answered (`schedules.ts`) -------------------------------------------------------------------------

/** The press on a draft's card: `allow` saves it as the card showed it, `deny` drops it. In the decision's transaction. */
export async function decideSkillDraft(q: Querier, userId: string, params: Record<string, unknown>, allow: boolean): Promise<Record<string, unknown> & { ok: boolean }> {
  const draftId = typeof params.draft_id === "string" ? params.draft_id : "";
  if (!allow) {
    await discardSkillDraft(userId, draftId, q);
    metrics.onUserSkillSave("draft", "discarded");
    return { ok: true, discarded: true };
  }
  const saved = await confirmSkillDraft(userId, draftId, { actor: "model_confirmed", query: q });
  if (!saved.ok) {
    metrics.onUserSkillSave("create", saved.error);
    return { ok: false, error: saved.error, message: saved.message };
  }
  metrics.onUserSkillSave(saved.created ? "create" : "update", saved.changed ? "ok" : "unchanged");
  return {
    ok: true, name: params.name ?? null, version: saved.version, created: saved.created,
    ...("change_id" in saved ? { change_id: saved.change_id, undo_expires_at: saved.undo_expires_at } : {}),
  };
}

// --- A worker's save_skill ---------------------------------------------------------------------------------------------

/**
 * The user's own words a worker's request quote may come from: for a work item's worker, what they wrote to their assistant, signed
 * in, around when the item was started (the request that started it: from a few minutes before until just after); for a chat of their
 * own, what they wrote there. A later message is not the request that started this worker's work: a save it asks for is the router's,
 * or, quoted by the worker, a draft the user confirms.
 */
async function userWordsFor(sessionId: string, userId: string): Promise<string[]> {
  const item = (await db.query(
    "SELECT created_at FROM claw_work_items WHERE worker_session_id = $1 AND user_id = $2 LIMIT 1", [sessionId, userId],
  ).catch(() => ({ rows: [] }))).rows[0] as { created_at: Date } | undefined;
  if (!item) return humanMessages(sessionId);
  return ((await db.query(
    `SELECT m.content FROM claw_assistant_messages m JOIN claw_assistants a ON a.session_id = m.session_id AND a.user_id = $1
      WHERE m.user_id = $1 AND m.attended_via IS NOT NULL AND m.received_at >= $2::timestamptz - make_interval(mins => $3::int)
        AND m.received_at <= $2::timestamptz
      ORDER BY m.received_at DESC LIMIT 20`,
    [userId, new Date(item.created_at).toISOString(), WORKER_QUOTE_WINDOW_MIN],
  )).rows as Array<{ content: string }>).map((r) => r.content);
}

async function assistantSessionOf(userId: string): Promise<string | null> {
  const row = (await db.query(
    `SELECT a.session_id FROM claw_assistants a JOIN claw_sessions s ON s.session_id = a.session_id AND s.deleted_at IS NULL
      WHERE a.user_id = $1 AND COALESCE(s.config->>'memory', '') NOT IN ('off', 'false') LIMIT 1`,
    [userId],
  ).catch(() => ({ rows: [] }))).rows[0] as { session_id: string } | undefined;
  return row?.session_id ?? null;
}

/**
 * What a worker's turn asked to save (`skills_to_save`, `skill_file_mutations`, from its completion), in a session the user's skills
 * serve. A skill whose `request_quote` is the user's own request to save it, from what they wrote, is saved now and shown with Undo and
 * Edit; any other is a draft the user confirms (its file writes go into the draft, never onto a skill of theirs), and so are file
 * writes on a skill of theirs that this turn did not save at their request. Shown in the user's
 * assistant when they have one, else as a session event of this session. Never throws for one skill: each is logged and the next goes on.
 */
export async function handleWorkerSkillWrites(
  sessionId: string, userId: string, skills: PendingSkill[], mutations: PendingSkillFileMutation[],
): Promise<void> {
  let words: string[] | null = null;
  const explicit = async (s: PendingSkill): Promise<boolean> => {
    const quote = typeof s.request_quote === "string" ? s.request_quote : "";
    if (!quote || !asksToSaveSkill(quote)) return false;
    words ??= await userWordsFor(sessionId, userId).catch(() => []);
    // Said by the user, and not cut out of a sentence that says not to.
    return words.some((w) => quoteIsFrom(quote, [w]) && !negatedBefore(textBefore(w, quote)));
  };
  const drafted = new Set<string>();
  const saves: Array<{ name: string; change_id: string; created: boolean }> = [];
  const draftsMade: SkillDraft[] = [];
  for (const skill of skills) {
    const name = typeof skill?.skill_name === "string" ? skill.skill_name : "";
    try {
      const invocation = skill.invocation === "manual" || skill.invocation === "auto" ? skill.invocation : undefined;
      // The same skill the user has under another name: neither saved nor drafted, as the router's tools refuse it.
      const same = await sameSkillUnderAnotherName(userId, name, skill.content, Array.isArray(skill.files) ? skill.files : []);
      if (same) {
        drafted.add(name);
        metrics.onUserSkillSave("create", "duplicate");
        logger.info({ skillName: name, sessionId, sameAs: same }, "skill.worker_duplicate");
        continue;
      }
      if (await explicit(skill)) {
        const saved = await saveUserSkillRecorded(userId, {
          name, content: skill.content, description: skill.description || "", files: Array.isArray(skill.files) ? skill.files : [], ...(invocation ? { invocation } : {}),
        }, { origin: "worker", actor: "model", sessionId });
        metrics.onUserSkillSave("create", saved.ok ? (saved.changed ? "ok" : "unchanged") : saved.error);
        if (saved.ok && "change_id" in saved) saves.push({ name, change_id: saved.change_id, created: saved.created });
        logger.info({ skillName: name, sessionId, ok: saved.ok, ...(saved.ok ? { version: saved.version } : { reason: saved.error }) }, "skill.worker_saved");
        continue;
      }
      // Not asked for in the user's own words: a draft, with this turn's file writes for it folded in (a removal of a file the skill
      // already has is kept as one, for the save to make).
      const files = new Map((Array.isArray(skill.files) ? skill.files : []).map((f) => [f.path, f]));
      const removed = new Set<string>();
      for (const m of mutations.filter((m) => m.skill_name === name)) {
        if (m.action === "remove") { files.delete(m.file_path); removed.add(m.file_path); continue; }
        removed.delete(m.file_path);
        files.set(m.file_path, { path: m.file_path, content: m.content || "", ...(m.is_binary ? { is_binary: true } : {}) });
      }
      drafted.add(name);
      const made = await createSkillDraft(userId, {
        name, content: skill.content, description: skill.description || "", files: [...files.values()], removeFiles: [...removed],
        ...(invocation ? { invocation } : {}),
      }, { origin: "worker", actor: "model", sessionId, requestQuote: skill.request_quote ?? null });
      metrics.onUserSkillSave("draft", made.ok ? "ok" : made.error);
      if (made.ok) draftsMade.push(made.draft);
      logger.info({ skillName: name, sessionId, ok: made.ok, ...(made.ok ? { draftId: made.draft.id } : { reason: made.error }) }, "skill.worker_drafted");
    } catch (err) {
      logger.error({ err, sessionId, skillName: name }, "skill.save_failed");
    }
  }

  // File writes on a skill the user has, not asked for in this turn: a draft of the skill with them, which the user confirms first.
  const savedHere = new Set(saves.map((s) => s.name));
  const onTheirOwn = new Map<string, PendingSkillFileMutation[]>();
  for (const m of mutations) {
    if (drafted.has(m.skill_name) || savedHere.has(m.skill_name)) continue;
    onTheirOwn.set(m.skill_name, [...(onTheirOwn.get(m.skill_name) ?? []), m]);
  }
  for (const [name, writes] of onTheirOwn) {
    try {
      const now = await showUserSkill(userId, name);
      if (!now) {
        // No current skill of the user's by that name (none, or one still on probation): nothing to draft from, and nothing applied.
        drafted.add(name);
        logger.warn({ skill: name, sessionId }, "skill_file.mutation_failed");
        continue;
      }
      const files = new Map<string, { path: string; content: string; is_binary?: boolean }>();
      const removed = new Set<string>();
      for (const m of writes) {
        if (m.action === "remove") { files.delete(m.file_path); removed.add(m.file_path); continue; }
        removed.delete(m.file_path);
        files.set(m.file_path, { path: m.file_path, content: m.content || "", ...(m.is_binary ? { is_binary: true } : {}) });
      }
      drafted.add(name);
      const made = await createSkillDraft(userId, {
        name, content: now.content, description: now.description, files: [...files.values()], removeFiles: [...removed],
      }, { origin: "worker", actor: "model", sessionId });
      metrics.onUserSkillSave("draft", made.ok ? "ok" : made.error);
      if (made.ok) draftsMade.push(made.draft);
      logger.info({ skillName: name, sessionId, ok: made.ok, ...(made.ok ? { draftId: made.draft.id } : { reason: made.error }) }, "skill.worker_files_drafted");
    } catch (err) {
      logger.error({ err, sessionId, skillName: name }, "skill.save_failed");
    }
  }

  // File writes on a skill just saved at the user's request in this turn: part of that save.
  const fileWrite = { actor: "model" as const, origin: "worker" as const, sessionId };
  for (const m of mutations) {
    if (drafted.has(m.skill_name)) continue;
    try {
      let r;
      if (m.action === "add") r = await addSkillFile(userId, m.skill_name, { file_path: m.file_path, content: m.content || "", is_binary: m.is_binary }, fileWrite);
      else if (m.action === "update") r = await updateSkillFile(userId, m.skill_name, { file_path: m.file_path, content: m.content || "", is_binary: m.is_binary }, fileWrite);
      else if (m.action === "remove") r = await removeSkillFile(userId, m.skill_name, m.file_path, fileWrite);
      else { logger.warn({ action: m.action }, "skill_file.unknown_action"); continue; }
      if (r.ok) logger.info({ skill: m.skill_name, action: m.action, path: m.file_path }, "skill_file.mutation_applied");
      else logger.warn({ skill: m.skill_name, action: m.action, path: m.file_path, err: r.error }, "skill_file.mutation_failed");
    } catch (err) {
      logger.error({ err, skill: m.skill_name, action: m.action }, "skill_file.mutation_error");
    }
  }

  if (!saves.length && !draftsMade.length) return;
  const router = await assistantSessionOf(userId);
  for (const s of saves) {
    try {
      // The undo takes back the save and the file writes that followed it in this turn.
      await refreshChangeAfter(s.change_id);
      const card = await cardNow(userId, s.name, "saved", { created: s.created, change_id: s.change_id });
      if (!card) continue;
      const lang: CommandLanguage = hasHan(`${card.description}${card.preview}`) ? "zh" : "en";
      if (router) await showCard({ userId, sessionId: router, lang, card, key: s.change_id });
      else await skillWritePorts.publishSessionEvent(sessionId, { type: "skill_card", session_id: sessionId, text: skillCardText(card, lang), skill_card: card });
    } catch (err) {
      logger.error({ err, sessionId, skillName: s.name }, "skill.worker_card_failed");
    }
  }
  for (const d of draftsMade) {
    try {
      const lang: CommandLanguage = hasHan(`${d.description}${d.content}`) ? "zh" : "en";
      if (router) {
        await showDraftCard(userId, router, `skill-draft:${d.id}`, d);
      } else {
        // No assistant: the draft is confirmed on the skill routes (`/v1/users/me/skill-drafts/:id/confirm`).
        const card: AssistantSkillCard = { ...draftCard(d, ""), draft_id: d.id };
        delete card.confirmation_id;
        await skillWritePorts.publishSessionEvent(sessionId, { type: "skill_card", session_id: sessionId, text: skillCardText(card, lang), skill_card: card });
      }
    } catch (err) {
      logger.error({ err, sessionId, skillName: d.skill_name }, "skill.worker_draft_card_failed");
    }
  }
}
