// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { db, inTransaction, type Querier } from "../infra/db.js";
import { callMemoryLLM } from "../llm/client.js";
import { scanInjection, scanSecrets } from "../memory/gates.js";
import {
  EVOLVE_EVIDENCE_GOOD_COUNT, EVOLVE_EVIDENCE_BAD_COUNT, MAX_SELECTED_SKILLS,
  CLAW_USER_SKILLS_ENABLED,
} from "../config.js";
import pino from "pino";

const logger = pino({ name: "skill-service" });

// ===== Capacity & policy constants =====
// The one place a personal skill's limits are set: the skill routes, the save_skill tool's path (events/consumer.ts)
// and the platform's own writes all check these.

/** Skills one user keeps (every name not deleted, disabled ones included). A save past it is refused; none is dropped. */
export const USER_SKILL_MAX = 50;
/** SKILL.md, in characters. */
export const SKILL_MD_MAX_CHARS = 20_000;
/** The description, in characters: what a turn's skill list shows of each skill. */
export const SKILL_DESCRIPTION_MAX_CHARS = 300;
/** One supporting file, in bytes. */
export const SKILL_FILE_MAX_BYTES = 64 * 1024;
/** Supporting files per skill. */
export const SKILL_FILES_MAX = 20;
/** SKILL.md and every supporting file together, in bytes. */
export const SKILL_TOTAL_MAX_BYTES = 256 * 1024;
/**
 * A new personal skill's name: kebab-case, at most 64 characters (the Agent Skills rule). Not the platform's
 * `SKILL_NAME_RE` (brain/src/agent/platform-defaults.ts), which is wider. A name stored before this rule keeps working.
 */
export const USER_SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** How long an unconfirmed draft (claw_skill_drafts) is kept. */
export const SKILL_DRAFT_TTL_HOURS = 24;
const MAX_PROBATION_SKILLS = 5;
/** Whitelisted sub-file root directories (Hermes-compatible). */
const ALLOWED_SUB_DIRS = ["references", "templates", "scripts", "assets"];

/** Where a skill came from (`claw_skills.origin`). */
export type SkillOrigin = "chat" | "worker" | "api" | "import" | "auto";
/**
 * Who changed a skill (`claw_skill_events.actor`). `model` is the save_skill tool's direct save, until saving from a
 * conversation goes through a confirmed draft (`model_confirmed`); `auto` is the platform's own writes.
 */
export type SkillActor = "user_cmd" | "model_confirmed" | "model" | "api" | "import" | "auto";
export type SkillEventOp =
  | "draft" | "create" | "update" | "disable" | "enable" | "delete" | "restore" | "rollback" | "refused";

// ===== Content checks =====

/** Why a write was refused. */
export type SkillWriteRefusal =
  | "invalid_name" | "invalid" | "too_large" | "too_many_files" | "secret" | "injection" | "full" | "not_found";

export interface SkillWriteRefused {
  ok: false;
  error: SkillWriteRefusal;
  /** For the caller to show. Never holds what was refused. */
  message: string;
  /** Where a secret or injection was found: `SKILL.md`, `description` or the file's path, and the 1-based line. */
  at?: { file: string; line: number | null; kind: string };
}

/**
 * The first line of `text` that `scan` flags, with what it flagged, or null. Line by line so a refusal can say where
 * ("line 12 looks like a GitHub token") without repeating any of it. A match only the whole text makes (one that spans
 * lines) is reported with no line.
 */
export function firstFlaggedLine(text: string, scan: (t: string) => string | null): { line: number | null; kind: string } | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kind = scan(lines[i]);
    if (kind) return { line: i + 1, kind };
  }
  const kind = scan(text);
  return kind ? { line: null, kind } : null;
}

function where(at: { file: string; line: number | null }): string {
  return at.line === null ? at.file : `${at.file} line ${at.line}`;
}

/**
 * The secret and instruction-hijack checks every user-saved part of a skill passes (the description, SKILL.md, each
 * text file; a binary file is opaque). A secret is always refused. An instruction to the agent is refused unless the
 * caller says the user confirmed it (`allowInjection`), and always for an imported skill.
 */
export function scanSkillParts(
  parts: Array<{ file: string; text: string }>,
  opts: { origin: SkillOrigin; allowInjection?: boolean },
): SkillWriteRefused | null {
  for (const p of parts) {
    const hit = firstFlaggedLine(p.text, scanSecrets);
    if (hit) {
      const at = { file: p.file, ...hit };
      return { ok: false, error: "secret", message: `not saved: ${where(at)} looks like a credential (${hit.kind}). Replace it with a placeholder such as <YOUR_TOKEN>.`, at };
    }
  }
  if (opts.allowInjection && opts.origin !== "import") return null;
  for (const p of parts) {
    const hit = firstFlaggedLine(p.text, scanInjection);
    if (hit) {
      const at = { file: p.file, ...hit };
      return { ok: false, error: "injection", message: `not saved: ${where(at)} reads as an instruction to override the agent (${hit.kind})`, at };
    }
  }
  return null;
}

/** The check a skill the platform writes on its own gets (evolution, pattern promotion): length, hijack, secret. */
function autoSkillBlocked(text: string, maxChars: number): string | null {
  if ([...text].length > maxChars) return `content too long (max ${maxChars} chars)`;
  const injection = scanInjection(text);
  if (injection) return `threat pattern '${injection}'`;
  const secret = scanSecrets(text);
  return secret ? `looks like a credential (${secret})` : null;
}

/** SKILL.md and every supporting file, in path order: what a cached copy of the skill is keyed by. */
export function skillContentSha(content: string, files: Array<{ path: string; content: string; is_binary?: boolean }>): string {
  const h = createHash("sha256");
  h.update("SKILL.md\0").update(content).update("\0");
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(f.path).update("\0").update(f.is_binary ? "b" : "t").update("\0").update(f.content).update("\0");
  }
  return h.digest("hex");
}

async function refreshContentSha(q: Querier, skillId: number): Promise<void> {
  const row = (await q("SELECT content FROM claw_skills WHERE id = $1", [skillId])).rows[0];
  if (!row) return;
  const files = (await q("SELECT file_path, content, is_binary FROM claw_skill_files WHERE skill_id = $1", [skillId])).rows
    .map((f: any) => ({ path: f.file_path, content: f.content, is_binary: !!f.is_binary }));
  await q("UPDATE claw_skills SET content_sha = $1 WHERE id = $2", [skillContentSha(row.content || "", files), skillId]);
}

/** One writer per user at a time, so a count and the insert that follows it hold together. Inside a transaction. */
async function lockUserSkills(q: Querier, userId: string): Promise<void> {
  await q("SELECT pg_advisory_xact_lock(hashtext('claw_skills'), hashtext($1))", [userId]);
}

/** What happened to a skill, for audit. Never what a refused write carried. */
export async function recordSkillEvent(q: Querier, e: {
  userId: string; skillName: string; version?: number | null; op: SkillEventOp; actor: SkillActor;
  sessionId?: string | null; detail?: Record<string, unknown>;
}): Promise<void> {
  await q(
    `INSERT INTO claw_skill_events (user_id, skill_name, version, op, actor, session_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [e.userId, e.skillName, e.version ?? null, e.op, e.actor, e.sessionId ?? null, JSON.stringify(e.detail ?? {})],
  );
}

/** A refusal's trace, outside any transaction the refusal rolled back. Best effort: an audit failure refuses nothing more. */
async function recordRefusal(userId: string, skillName: string, actor: SkillActor, sessionId: string | null | undefined, r: SkillWriteRefused): Promise<void> {
  await recordSkillEvent(db.query, {
    userId, skillName: String(skillName || "").slice(0, 200), op: "refused", actor, sessionId,
    detail: { reason: r.error, ...(r.at ? { file: r.at.file, line: r.at.line, kind: r.at.kind } : {}) },
  }).catch((err) => logger.warn({ err: (err as Error)?.message, userId, reason: r.error }, "skill.refusal_audit_failed"));
}

// ===== Sub-file path validation =====

export interface FileValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Validate a sub-file path. Must:
 * - Start with one of the whitelisted directories
 * - Not contain ../ traversal
 * - Not be empty / absolute / contain control chars
 */
export function validateSubFilePath(filePath: string): FileValidationResult {
  if (!filePath || typeof filePath !== "string") return { ok: false, error: "file_path required" };
  if (filePath.startsWith("/")) return { ok: false, error: "absolute paths not allowed" };
  if (filePath.includes("..")) return { ok: false, error: "path traversal '..' not allowed" };
  if (/[\x00-\x1f]/.test(filePath)) return { ok: false, error: "control chars not allowed" };
  const head = filePath.split("/")[0];
  if (!ALLOWED_SUB_DIRS.includes(head)) {
    return { ok: false, error: `path must start with one of: ${ALLOWED_SUB_DIRS.join("/, ")}/ (got '${head}/')` };
  }
  if (filePath.split("/").length < 2 || filePath.endsWith("/")) {
    return { ok: false, error: "must be a file path under the directory, not the directory itself" };
  }
  return { ok: true };
}

// ===== CRUD Helpers =====

export interface SkillBundle {
  content: string;
  description: string;
  version: number;
  /** Sub-files materialized to sandbox alongside SKILL.md. */
  files?: Array<{ path: string; content: string; is_binary: boolean }>;
}

export async function getUserActiveSkills(userId: string): Promise<Record<string, SkillBundle>> {
  // Include 'probation' status so the skill can be field-tested.
  // Version is selected here too — callers need it for skills_used attribution
  // and it's the same row, so fetching it separately via getActiveSkillVersions
  // would be a redundant round-trip (that function is now a thin wrapper kept
  // for backward compat).
  const rows = (await db.query(`
    SELECT DISTINCT ON (skill_name) skill_name, content, description, version, id
    FROM claw_skills
    WHERE user_id = $1 AND status IN ('active', 'probation') AND deleted_at IS NULL AND enabled
    ORDER BY skill_name, version DESC
  `, [userId])).rows;

  if (!rows.length) return {};

  const ids = rows.map((r: any) => r.id);
  // Increment inject_count async (don't block dispatch on it)
  db.query(
    "UPDATE claw_skills SET inject_count = inject_count + 1, last_accessed = NOW() WHERE id = ANY($1)",
    [ids]
  ).catch(() => {});

  const fileRows = (await db.query(
    "SELECT skill_id, file_path, content, is_binary FROM claw_skill_files WHERE skill_id = ANY($1)",
    [ids]
  )).rows;
  const filesBySkillId: Record<number, Array<{ path: string; content: string; is_binary: boolean }>> = {};
  for (const f of fileRows) {
    (filesBySkillId[f.skill_id] = filesBySkillId[f.skill_id] || []).push({
      path: f.file_path, content: f.content, is_binary: !!f.is_binary,
    });
  }

  const skills: Record<string, SkillBundle> = {};
  for (const row of rows) {
    skills[row.skill_name] = {
      content: row.content,
      description: row.description || "",
      version: row.version,
      files: filesBySkillId[row.id] || [],
    };
  }
  return skills;
}

const SKILL_SELECT_PROMPT = `You are a skill selector. Given the user's task and available skills, return the most relevant skill names (0 to {max_skills}).

User's task:
{task}

Available skills:
{candidates}

Rules:
1. Only select skills that are clearly relevant to the task
2. Return [] if no skill is relevant
3. Never invent skill names — only use names from the list above
4. Prefer fewer, more targeted skills over loading everything

Return JSON: { "skills": ["name1", "name2"] }`;

export async function selectSkillsForTask(
  userId: string,
  taskPrompt: string,
  maxSkills: number = MAX_SELECTED_SKILLS,
): Promise<Record<string, SkillBundle>> {
  // Feature flag: empty selection short-circuits all callers (sessions route +
  // event-consumer pending branch) without touching their loops.
  if (!CLAW_USER_SKILLS_ENABLED) return {};
  const all = await getUserActiveSkills(userId);
  const names = Object.keys(all);
  if (names.length <= maxSkills) return all;

  const candidates = names.map(n => ({
    name: n, description: all[n].description || "(no description)",
  }));

  try {
    const result = await callMemoryLLM<{ skills: string[] }>(
      userId,
      SKILL_SELECT_PROMPT,
      {
        task: taskPrompt.slice(0, 1000),
        candidates: JSON.stringify(candidates),
        max_skills: String(maxSkills),
      },
      { temperature: 0 },
    );

    const selected: Record<string, SkillBundle> = {};
    for (const name of (result.skills || []).slice(0, maxSkills)) {
      if (all[name]) selected[name] = all[name];
    }
    if (Object.keys(selected).length) {
      logger.info({ userId, total: names.length, selected: Object.keys(selected) }, "skill.selection");
      return selected;
    }
    return all;
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, userId }, "skill.selection_failed_fallback_all");
    return all;
  }
}

export async function getUserSkillNames(userId: string): Promise<string[]> {
  const rows = (await db.query(
    "SELECT DISTINCT skill_name FROM claw_skills WHERE user_id = $1 AND deleted_at IS NULL", [userId]
  )).rows;
  return rows.map((r: any) => r.skill_name);
}

export async function getAllUserSkills(userId: string): Promise<any[]> {
  return (await db.query(
    "SELECT * FROM claw_skills WHERE user_id = $1 AND deleted_at IS NULL ORDER BY skill_name, version DESC",
    [userId]
  )).rows;
}

export async function getSkillDetails(userId: string, skillName: string): Promise<any[]> {
  return (await db.query(
    "SELECT * FROM claw_skills WHERE user_id = $1 AND skill_name = $2 AND deleted_at IS NULL ORDER BY version DESC",
    [userId, skillName]
  )).rows;
}

export async function getActiveSkillContent(skillName: string, userId: string): Promise<string | null> {
  const row = (await db.query(
    "SELECT content FROM claw_skills WHERE skill_name = $1 AND user_id = $2 AND status = 'active' AND deleted_at IS NULL ORDER BY version DESC LIMIT 1",
    [skillName, userId]
  )).rows[0];
  return row?.content || null;
}

/**
 * Get active version numbers for a set of skill names (for skillsUsed tracking).
 *
 * @deprecated Prefer `getUserActiveSkills(userId)` — it now returns `version`
 * on each SkillBundle, so there's no reason to make a second round-trip just
 * for versions. Kept for backward compat (e2e tests + any external callers).
 */
export async function getActiveSkillVersions(userId: string, skillNames: string[]): Promise<Record<string, number>> {
  if (!skillNames.length) return {};
  const rows = (await db.query(`
    SELECT DISTINCT ON (skill_name) skill_name, version
    FROM claw_skills
    WHERE user_id = $1 AND status IN ('active', 'probation') AND deleted_at IS NULL AND skill_name = ANY($2)
    ORDER BY skill_name, version DESC
  `, [userId, skillNames])).rows;
  const versions: Record<string, number> = {};
  for (const r of rows) versions[r.skill_name] = r.version;
  return versions;
}

/**
 * Whether the user has room for one more probation (auto-created, not yet proven) skill. Full is a refusal of the new
 * one: no skill, proven or not, is deleted to make room.
 */
async function hasProbationRoom(userId: string, q: Querier = db.query): Promise<boolean> {
  const count = (await q(
    "SELECT COUNT(*) AS n FROM claw_skills WHERE user_id = $1 AND status = 'probation' AND deleted_at IS NULL",
    [userId]
  )).rows[0].n;
  return parseInt(count) < MAX_PROBATION_SKILLS;
}

/**
 * What a skill row breaks of the per-skill limits as stored now (SKILL.md and its files together, the file count),
 * or null. Checked inside the transaction that wrote, before it commits, so no path can leave a skill over them.
 */
async function skillCapacityProblem(q: Querier, skillId: number): Promise<SkillWriteRefused | null> {
  const row = (await q(
    `SELECT octet_length(s.content) AS main,
            (SELECT COALESCE(SUM(size_bytes), 0) FROM claw_skill_files f WHERE f.skill_id = s.id) AS files,
            (SELECT COUNT(*) FROM claw_skill_files f WHERE f.skill_id = s.id) AS n
       FROM claw_skills s WHERE s.id = $1`,
    [skillId]
  )).rows[0];
  if (!row) return null;
  const total = Number(row.main) + Number(row.files);
  if (total > SKILL_TOTAL_MAX_BYTES) {
    return { ok: false, error: "too_large", message: `skill total size would be ${total} bytes, over ${SKILL_TOTAL_MAX_BYTES} (SKILL.md and its files together)` };
  }
  if (Number(row.n) > SKILL_FILES_MAX) {
    return { ok: false, error: "too_many_files", message: `too many sub-files: ${row.n} > ${SKILL_FILES_MAX}` };
  }
  return null;
}

/**
 * Record feedback for skills used in an execution.
 * score: > 0 = positive (success), < 0 = negative (failed), = 0 = neutral (mixed)
 * effectiveness = positive_count / (positive + negative + neutral)
 */
export async function recordSkillFeedback(
  userId: string,
  skillNames: string[],
  score: number,
): Promise<void> {
  if (!skillNames.length) return;
  // Whitelist column to make it safe — never inline user input.
  const col = score > 0 ? "positive_count" : score < 0 ? "negative_count" : "neutral_count";
  if (col !== "positive_count" && col !== "negative_count" && col !== "neutral_count") return;
  // Bump count, then recompute effectiveness from the updated counts.
  // Include probation rows so probation skills can graduate / get demoted via real signals.
  await db.query(
    `UPDATE claw_skills
     SET ${col} = ${col} + 1,
         effectiveness = (positive_count::REAL + (CASE WHEN $3 > 0 THEN 1 ELSE 0 END))
                       / GREATEST(positive_count + negative_count + neutral_count + 1, 1)::REAL
     WHERE user_id = $1 AND status IN ('active', 'probation') AND deleted_at IS NULL AND skill_name = ANY($2)`,
    [userId, skillNames, score]
  );
  logger.info({ userId, skillNames, score, col }, "skill.feedback_recorded");
}

// ===== E4: Probation graduation / demotion =====

/** Min total runs (positive+negative+neutral) before a probation skill is judged. */
const PROBATION_MIN_RUNS = 5;
/** Effectiveness threshold to graduate from probation to active. */
const PROBATION_GRADUATE_THRESHOLD = 0.5;

/**
 * Check whether the named skill (if currently in probation) has accumulated enough
 * feedback to either graduate to 'active' or get soft-deleted.
 *
 * Called synchronously after recordSkillFeedback in the event consumer.
 */
export async function checkProbationGraduation(userId: string, skillName: string): Promise<void> {
  const row = (await db.query(
    `SELECT id, positive_count, negative_count, neutral_count, effectiveness
     FROM claw_skills
     WHERE skill_name = $1 AND user_id = $2 AND status = 'probation' AND deleted_at IS NULL
     ORDER BY version DESC LIMIT 1`,
    [skillName, userId]
  )).rows[0];
  if (!row) return;

  const total = (row.positive_count ?? 0) + (row.negative_count ?? 0) + (row.neutral_count ?? 0);
  if (total < PROBATION_MIN_RUNS) return;

  if (row.effectiveness >= PROBATION_GRADUATE_THRESHOLD) {
    await db.query("UPDATE claw_skills SET status = 'active' WHERE id = $1", [row.id]);
    logger.info({ skillName, userId, total, eff: row.effectiveness }, "skill.probation_graduated");
  } else {
    await db.query("UPDATE claw_skills SET deleted_at = NOW() WHERE id = $1", [row.id]);
    logger.info({ skillName, userId, total, eff: row.effectiveness }, "skill.probation_demoted");
  }
}

// ===== Save Skill =====

export type SaveSkillResult =
  | {
    ok: true; id: number; version: number; created: boolean;
    /** False when the save stored what was already there (a redelivered completion, the same text again). */
    changed: boolean;
  }
  | SkillWriteRefused;

export interface SaveSkillOptions {
  /**
   * The transaction to write in. Without one, the save is its own transaction. A caller that passes one owns it: the
   * user's skill lock is taken in it and held until it ends.
   */
  query?: Querier;
  /** Where a new (or revived) skill came from. An update keeps the origin the skill was created with. */
  origin?: SkillOrigin;
  /**
   * Refuse rather than update when the name is already visible. For the platform's own new skills: a skill the user
   * created meanwhile, under the lock this save takes, is never overwritten with generated content.
   */
  createOnly?: boolean;
}

/**
 * Save / update a skill. Content only; the checks a user's save passes are `saveUserSkill`'s.
 * - Existing skill: in-place UPDATE of the visible row; the version moves when the content changes
 * - Deleted skill: the row comes back
 * - New skill: INSERT v1, refused when the user already has USER_SKILL_MAX skills. Nothing is ever dropped to make room.
 */
export async function saveSkill(
  skillName: string,
  userId: string,
  content: string,
  source: string,
  sessionId?: string,
  description = "",
  opts: SaveSkillOptions = {},
): Promise<SaveSkillResult> {
  const run = async (q: Querier): Promise<SaveSkillResult> => {
    await lockUserSkills(q, userId);
    // Case 1: active OR probation row exists → in-place update.
    //   - active: just refresh content; user can override their own / system's existing skill
    //   - probation: also refresh content; B1 fix — without this clause we silently
    //     dropped the new content via ON CONFLICT DO NOTHING in Case 3 (since v=1 was occupied).
    //     If the caller is a manual save (source='manual'), the user is vouching for the new
    //     content → graduate it to 'active' immediately. If the caller is auto* (re-save during
    //     pattern re-promotion), keep it in probation so feedback gating still applies.
    const visibleRow = (await q(
      `SELECT id, status, content, description FROM claw_skills
       WHERE skill_name = $1 AND user_id = $2
         AND status IN ('active', 'probation') AND deleted_at IS NULL
       ORDER BY version DESC LIMIT 1`,
      [skillName, userId]
    )).rows[0];

    if (visibleRow && opts.createOnly) {
      return { ok: false, error: "invalid", message: `skill '${skillName}' already exists; nothing was saved` };
    }
    if (visibleRow) {
      const newStatus = visibleRow.status === "probation" && source === "manual"
        ? "active"
        : visibleRow.status;
      // Bump version when content actually changes — keeps stats isolation
      // (shouldEvolveSkill scopes feedback to the active version number).
      const contentChanged = visibleRow.content !== content;
      const row = (await q(
        `UPDATE claw_skills SET content = $1, description = $2, source = $3,
                                source_session = $4, status = $5, last_accessed = NOW()
                                ${contentChanged ? ", version = version + 1" : ""}
         WHERE id = $6 RETURNING id, version`,
        [content, description, source, sessionId || null, newStatus, visibleRow.id]
      )).rows[0];
      await refreshContentSha(q, row.id);
      const changed = contentChanged || (visibleRow.description ?? "") !== description || newStatus !== visibleRow.status;
      return { ok: true, id: row.id, version: row.version, created: false, changed };
    }

    // A skill not visible now takes a place among the user's skills, whether it is new or comes back.
    const count = Number((await q(
      "SELECT COUNT(DISTINCT skill_name) AS n FROM claw_skills WHERE user_id = $1 AND deleted_at IS NULL",
      [userId]
    )).rows[0].n);
    if (count >= USER_SKILL_MAX) {
      return {
        ok: false, error: "full",
        message: `skills are full (${count}/${USER_SKILL_MAX}). Nothing was saved; delete or update an existing skill first.`,
      };
    }

    // Case 2: only soft-deleted row(s) exist → revive the highest-version one
    //         (this is the "delete then save_skill again" scenario)
    const softDeletedRow = (await q(
      "SELECT id FROM claw_skills WHERE skill_name = $1 AND user_id = $2 AND deleted_at IS NOT NULL ORDER BY version DESC LIMIT 1",
      [skillName, userId]
    )).rows[0];

    if (softDeletedRow) {
      const row = (await q(
        `UPDATE claw_skills
         SET content = $1, description = $2, source = $3,
             source_session = $4, status = 'active', deleted_at = NULL, last_accessed = NOW(),
             enabled = TRUE, origin = $6
         WHERE id = $5 RETURNING id, version`,
        [content, description, source, sessionId || null, softDeletedRow.id, opts.origin ?? null]
      )).rows[0];
      await refreshContentSha(q, row.id);
      return { ok: true, id: row.id, version: row.version, created: true, changed: true };
    }

    // Case 3: truly new skill → INSERT.
    // E4: auto-created skills start in 'probation' so we can validate them with real
    // execution feedback before they're trusted enough to participate in evolution.
    // Manually created skills (source='manual') skip probation since the user vouches.
    const initialStatus = source === "auto" || source === "auto-pattern" ? "probation" : "active";
    if (initialStatus === "probation" && !(await hasProbationRoom(userId, q))) {
      return { ok: false, error: "full", message: `unproven auto-created skills are full (${MAX_PROBATION_SKILLS}); nothing was saved` };
    }
    const row = (await q(`
      INSERT INTO claw_skills (skill_name, user_id, version, content, description, source, status, source_session, origin)
      VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (skill_name, user_id, version) DO NOTHING
      RETURNING id, version
    `, [skillName, userId, content, description, source, initialStatus, sessionId || null, opts.origin ?? null])).rows[0];
    if (!row) {
      // A v1 row of this name in another status (archived, rolled back) holds the key; nothing was written, as before.
      return { ok: false, error: "invalid", message: `skill '${skillName}' has an earlier version that is not active; nothing was saved` };
    }
    await refreshContentSha(q, row.id);
    return { ok: true, id: row.id, version: row.version, created: true, changed: true };
  };
  return opts.query ? run(opts.query) : inTransaction(run);
}

// ===== Skill Sub-files (E2: multi-file support) =====

export interface SkillFileInput {
  file_path: string;
  content: string;
  is_binary?: boolean;
}

/** Who a file write is for, and where it was made. Defaults: the REST routes. */
export interface SkillFileWriteOptions {
  actor?: SkillActor;
  origin?: SkillOrigin;
  sessionId?: string | null;
  allowInjection?: boolean;
  /** A transaction to write in (see SaveSkillOptions.query). */
  query?: Querier;
}

/** A file write's checks that need no database: its path, its size, and (text only) secrets and hijack. */
function checkFileInput(input: SkillFileInput, opts: SkillFileWriteOptions): SkillWriteRefused | null {
  const pathCheck = validateSubFilePath(input.file_path);
  if (!pathCheck.ok) return { ok: false, error: "invalid", message: pathCheck.error || "invalid file_path" };
  if (typeof input.content !== "string") return { ok: false, error: "invalid", message: "content required" };
  const size = Buffer.byteLength(input.content, "utf8");
  if (size > SKILL_FILE_MAX_BYTES) {
    return { ok: false, error: "too_large", message: `file too large: ${size} > ${SKILL_FILE_MAX_BYTES} bytes` };
  }
  if (input.is_binary) return null;
  return scanSkillParts([{ file: input.file_path, text: input.content }], { origin: opts.origin ?? "api", allowInjection: opts.allowInjection });
}

/**
 * Validate a sub-file write against the skill's capacity: total size and file count, counting what is stored.
 * Returns null on success, the refusal otherwise.
 */
async function validateFileWrite(
  q: Querier,
  skillId: number,
  filePath: string,
  contentSize: number,
  isUpdate: boolean,
): Promise<SkillWriteRefused | null> {
  // Total size check (mainSize = SKILL.md byte length)
  const stats = (await q(
    "SELECT content FROM claw_skills WHERE id = $1",
    [skillId]
  )).rows[0];
  if (!stats) return { ok: false, error: "not_found", message: "parent skill not found" };
  const mainSize = Buffer.byteLength(stats.content || "", "utf8");

  const fileRows = (await q(
    "SELECT file_path, size_bytes FROM claw_skill_files WHERE skill_id = $1",
    [skillId]
  )).rows;
  let subTotal = 0;
  let count = 0;
  for (const f of fileRows) {
    if (isUpdate && f.file_path === filePath) continue; // updating: replace its size
    subTotal += f.size_bytes;
    count++;
  }
  const newTotal = mainSize + subTotal + contentSize;
  if (newTotal > SKILL_TOTAL_MAX_BYTES) {
    return { ok: false, error: "too_large", message: `skill total size would exceed ${SKILL_TOTAL_MAX_BYTES} bytes (current ${mainSize + subTotal}, adding ${contentSize})` };
  }
  if (!isUpdate && count + 1 > SKILL_FILES_MAX) {
    return { ok: false, error: "too_many_files", message: `too many sub-files: ${count + 1} > ${SKILL_FILES_MAX}` };
  }
  return null;
}

/** Find the active or probation skill row id for (user, name). */
async function findVisibleSkillId(skillName: string, userId: string, q: Querier = db.query): Promise<number | null> {
  const row = (await q(
    `SELECT id FROM claw_skills
     WHERE skill_name = $1 AND user_id = $2 AND status IN ('active', 'probation') AND deleted_at IS NULL
     ORDER BY version DESC LIMIT 1`,
    [skillName, userId]
  )).rows[0];
  return row?.id ?? null;
}

/** A refusal thrown out of a transaction so that what it wrote is rolled back. */
class SkillRefusal extends Error {
  constructor(readonly refusal: SkillWriteRefused) { super(refusal.message); }
}

/**
 * Run `body` in the caller's transaction (under a savepoint, so a refusal undoes only this write) or in its own.
 * A `SkillRefusal` thrown by `body` comes back as its refusal, with nothing written.
 */
async function writeSkillTx<T>(query: Querier | undefined, body: (q: Querier) => Promise<T>): Promise<T | SkillWriteRefused> {
  try {
    if (!query) return await inTransaction(body);
    await query("SAVEPOINT skill_write");
    try {
      const out = await body(query);
      await query("RELEASE SAVEPOINT skill_write");
      return out;
    } catch (err) {
      await query("ROLLBACK TO SAVEPOINT skill_write");
      throw err;
    }
  } catch (err) {
    if (err instanceof SkillRefusal) return err.refusal;
    throw err;
  }
}

type FileAction = "add" | "update" | "remove" | "upsert";

/** One file write on a skill row, under the user's lock: whether it changed anything. Throws a SkillRefusal for anything it refuses. */
async function writeSkillFileRow(q: Querier, userId: string, skillId: number, input: SkillFileInput, action: FileAction): Promise<boolean> {
  const exists = (await q(
    "SELECT id, content, is_binary FROM claw_skill_files WHERE skill_id = $1 AND file_path = $2",
    [skillId, input.file_path]
  )).rows[0];
  if (action === "remove") {
    if (!exists) throw new SkillRefusal({ ok: false, error: "not_found", message: `file '${input.file_path}' not found` });
    await q("DELETE FROM claw_skill_files WHERE id = $1", [exists.id]);
    return true;
  }
  if (action === "add" && exists) {
    throw new SkillRefusal({ ok: false, error: "invalid", message: `file '${input.file_path}' already exists; use update_skill_file` });
  }
  if (action === "update" && !exists) {
    throw new SkillRefusal({ ok: false, error: "not_found", message: `file '${input.file_path}' not found` });
  }
  if (exists && exists.content === input.content && !!exists.is_binary === !!input.is_binary) return false;
  const sizeBytes = Buffer.byteLength(input.content, "utf8");
  const capErr = await validateFileWrite(q, skillId, input.file_path, sizeBytes, !!exists);
  if (capErr) throw new SkillRefusal(capErr);
  if (exists) {
    await q(
      `UPDATE claw_skill_files
       SET content = $1, is_binary = $2, size_bytes = $3, updated_at = NOW()
       WHERE id = $4`,
      [input.content, !!input.is_binary, sizeBytes, exists.id]
    );
  } else {
    await q(
      `INSERT INTO claw_skill_files (skill_id, user_id, file_path, content, is_binary, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [skillId, userId, input.file_path, input.content, !!input.is_binary, sizeBytes]
    );
  }
  return true;
}

/** A file add, update or remove on the user's visible skill, checked, audited, and the skill's fingerprint kept. */
async function mutateSkillFile(
  userId: string,
  skillName: string,
  input: SkillFileInput,
  action: Exclude<FileAction, "upsert">,
  opts: SkillFileWriteOptions,
): Promise<{ ok: boolean; error?: string; refusal?: SkillWriteRefusal }> {
  const actor = opts.actor ?? "api";
  const path = validateSubFilePath(input.file_path);
  const pre: SkillWriteRefused | null = action !== "remove" ? checkFileInput(input, opts)
    : path.ok ? null : { ok: false, error: "invalid", message: path.error || "invalid file_path" };
  if (pre) {
    if (pre.error === "secret" || pre.error === "injection") await recordRefusal(userId, skillName, actor, opts.sessionId, pre);
    return { ok: false, error: pre.message, refusal: pre.error };
  }
  const out = await writeSkillTx(opts.query, async (q) => {
    await lockUserSkills(q, userId);
    const skillId = await findVisibleSkillId(skillName, userId, q);
    if (!skillId) throw new SkillRefusal({ ok: false, error: "not_found", message: `skill '${skillName}' not found` });
    // The same file again (a redelivered completion): nothing to write, nothing to record.
    if (!(await writeSkillFileRow(q, userId, skillId, input, action))) return { ok: true as const };
    await refreshContentSha(q, skillId);
    const version = (await q("SELECT version FROM claw_skills WHERE id = $1", [skillId])).rows[0]?.version ?? null;
    await recordSkillEvent(q, {
      userId, skillName, version, op: "update", actor, sessionId: opts.sessionId,
      detail: { file_path: input.file_path, file_action: action },
    });
    return { ok: true as const };
  });
  if (out.ok) return { ok: true };
  if (out.error === "too_large" || out.error === "too_many_files") await recordRefusal(userId, skillName, actor, opts.sessionId, out);
  return { ok: false, error: out.message, refusal: out.error };
}

export async function addSkillFile(
  userId: string,
  skillName: string,
  input: SkillFileInput,
  opts: SkillFileWriteOptions = {},
): Promise<{ ok: boolean; error?: string; refusal?: SkillWriteRefusal }> {
  return mutateSkillFile(userId, skillName, input, "add", opts);
}

export async function updateSkillFile(
  userId: string,
  skillName: string,
  input: SkillFileInput,
  opts: SkillFileWriteOptions = {},
): Promise<{ ok: boolean; error?: string; refusal?: SkillWriteRefusal }> {
  return mutateSkillFile(userId, skillName, input, "update", opts);
}

export async function removeSkillFile(
  userId: string,
  skillName: string,
  filePath: string,
  opts: SkillFileWriteOptions = {},
): Promise<{ ok: boolean; error?: string; refusal?: SkillWriteRefusal }> {
  return mutateSkillFile(userId, skillName, { file_path: filePath, content: "" }, "remove", opts);
}

// ===== A user's save: every check, one transaction, audited =====

export interface UserSkillInput {
  name: string;
  description?: string;
  content: string;
  /** Supporting files to write with it: each added, or replaced when the skill has it. Files not named are kept. */
  files?: Array<{ path: string; content: string; is_binary?: boolean }>;
}

export interface UserSkillSaveContext {
  origin: SkillOrigin;
  actor: SkillActor;
  sessionId?: string | null;
  /** The user saw the instruction-like text and confirmed it (a confirmation card). Never for `origin: "import"`. */
  allowInjection?: boolean;
  /** A transaction to write in (see SaveSkillOptions.query); the save is a savepoint in it. */
  query?: Querier;
}

/**
 * Save a skill a user asked for, from any path (the skill routes, the save_skill tool, a confirmed draft): the name
 * rule for a new name, the size limits, no secret, no instruction hijack, room for a new skill. SKILL.md, the files
 * and the audit event are written together or not at all; a refusal writes only its own audit event, and never what
 * it refused.
 */
export async function saveUserSkill(userId: string, input: UserSkillInput, ctx: UserSkillSaveContext): Promise<SaveSkillResult> {
  const name = typeof input.name === "string" ? input.name : "";
  const refuse = async (r: SkillWriteRefused): Promise<SkillWriteRefused> => {
    await recordRefusal(userId, name, ctx.actor, ctx.sessionId, r);
    return r;
  };
  const description = typeof input.description === "string" ? input.description.trim() : "";
  const content = typeof input.content === "string" ? input.content : "";
  const files = Array.isArray(input.files) ? input.files : [];
  if (!name) return refuse({ ok: false, error: "invalid_name", message: "skill_name required" });
  if (!content.trim()) return refuse({ ok: false, error: "invalid", message: "content required" });
  const known = (await (ctx.query ?? db.query)(
    "SELECT 1 FROM claw_skills WHERE user_id = $1 AND skill_name = $2 LIMIT 1", [userId, name],
  )).rows.length > 0;
  if (!known && !USER_SKILL_NAME_RE.test(name)) {
    return refuse({ ok: false, error: "invalid_name", message: "skill_name must be kebab-case: lowercase letters, digits and '-', starting with a letter or digit, at most 64 characters" });
  }
  if ([...content].length > SKILL_MD_MAX_CHARS) {
    return refuse({ ok: false, error: "too_large", message: `SKILL.md is too long (max ${SKILL_MD_MAX_CHARS} characters)` });
  }
  if ([...description].length > SKILL_DESCRIPTION_MAX_CHARS) {
    return refuse({ ok: false, error: "too_large", message: `description is too long (max ${SKILL_DESCRIPTION_MAX_CHARS} characters)` });
  }
  if (files.length > SKILL_FILES_MAX) {
    return refuse({ ok: false, error: "too_many_files", message: `too many sub-files: ${files.length} > ${SKILL_FILES_MAX}` });
  }
  for (const f of files) {
    const bad = checkFileInput({ file_path: f.path, content: f.content, is_binary: f.is_binary }, { origin: ctx.origin, allowInjection: ctx.allowInjection });
    if (bad) return refuse(bad);
  }
  const scanned = scanSkillParts(
    [{ file: "description", text: description }, { file: "SKILL.md", text: content }],
    { origin: ctx.origin, allowInjection: ctx.allowInjection },
  );
  if (scanned) return refuse(scanned);

  const out = await writeSkillTx(ctx.query, async (q) => {
    const saved = await saveSkill(name, userId, content, "manual", ctx.sessionId ?? undefined, description, { query: q, origin: ctx.origin });
    if (!saved.ok) throw new SkillRefusal(saved);
    let changed = saved.changed;
    for (const f of files) {
      if (await writeSkillFileRow(q, userId, saved.id, { file_path: f.path, content: f.content, is_binary: f.is_binary }, "upsert")) changed = true;
    }
    // SKILL.md and the files it already has, together: a longer SKILL.md alone can pass the total.
    const over = await skillCapacityProblem(q, saved.id);
    if (over) throw new SkillRefusal(over);
    if (!changed) return saved;
    if (files.length) await refreshContentSha(q, saved.id);
    await recordSkillEvent(q, {
      userId, skillName: name, version: saved.version, op: saved.created ? "create" : "update", actor: ctx.actor,
      sessionId: ctx.sessionId, detail: { origin: ctx.origin, files: files.map((f) => f.path) },
    });
    return { ...saved, changed };
  });
  if (!out.ok) return refuse(out);
  return out;
}

export async function getSkillFiles(userId: string, skillName: string): Promise<Array<{ file_path: string; size_bytes: number; is_binary: boolean; updated_at: string }>> {
  const skillId = await findVisibleSkillId(skillName, userId);
  if (!skillId) return [];
  const rows = (await db.query(
    `SELECT file_path, size_bytes, is_binary, updated_at FROM claw_skill_files
     WHERE skill_id = $1 ORDER BY file_path`,
    [skillId]
  )).rows;
  return rows;
}

export async function getSkillFile(userId: string, skillName: string, filePath: string): Promise<{ content: string; is_binary: boolean } | null> {
  const skillId = await findVisibleSkillId(skillName, userId);
  if (!skillId) return null;
  const row = (await db.query(
    "SELECT content, is_binary FROM claw_skill_files WHERE skill_id = $1 AND file_path = $2",
    [skillId, filePath]
  )).rows[0];
  return row ? { content: row.content, is_binary: !!row.is_binary } : null;
}

/** Periodic cleanup: orphan rows where parent skill no longer exists. */
export async function cleanupOrphanSkillFiles(): Promise<number> {
  const result = await db.query(`
    DELETE FROM claw_skill_files
    WHERE skill_id NOT IN (SELECT id FROM claw_skills)
  `);
  if (result.rowCount) {
    logger.info({ orphanCount: result.rowCount }, "skill_files.orphan_cleanup");
  }
  return result.rowCount ?? 0;
}

/**
 * B6: Periodic cleanup of claw_skill_patterns.
 * Two policies (both required to keep the table bounded):
 *   1. Promoted patterns older than 90 days (N5) — they've already produced their
 *      skill, the pattern row only exists for audit. 90 days (not 30) because
 *      deleting sooner means if the user redoes the task after 30 days, we'd
 *      pointlessly re-aggregate to 3 occurrences and re-run the LLM only for it
 *      to say "existing skill already covers this". 90 days keeps the dedupe
 *      memory long enough to save redundant LLM calls.
 *   2. Cold patterns: occurrences=1 AND last_seen > 14 days — these never
 *      grew enough to even hint at a recurring workflow; they're dead weight.
 * Stuck claims (promoted_to_skill_id = -1 sentinel from B4 race protection,
 * but the LLM call crashed without the catch firing) get released after 1 hour
 * so future occurrences can retry.
 */
export async function cleanupOldPatterns(): Promise<{ deleted: number; released: number; recycled: number }> {
  const stuck = await db.query(
    `UPDATE claw_skill_patterns SET promoted_to_skill_id = NULL
     WHERE promoted_to_skill_id = -1 AND last_seen_at < NOW() - INTERVAL '1 hour'`
  );

  // Recycle patterns whose promoted skill was demoted/deleted — allow
  // re-promotion after a 7-day cooldown. Reset occurrences so the user
  // needs to re-demonstrate the pattern (prevents promote→demote→promote churn).
  const recycled = await db.query(`
    UPDATE claw_skill_patterns p
    SET promoted_to_skill_id = NULL,
        occurrences = 0,
        example_session_ids = '[]'::jsonb
    WHERE p.promoted_to_skill_id > 0
      AND p.last_seen_at < NOW() - INTERVAL '7 days'
      AND EXISTS (
        SELECT 1 FROM claw_skills s
        WHERE s.id = p.promoted_to_skill_id AND s.deleted_at IS NOT NULL
      )
  `);

  const deleted = await db.query(`
    DELETE FROM claw_skill_patterns
    WHERE (promoted_to_skill_id IS NOT NULL AND promoted_to_skill_id > 0
           AND last_seen_at < NOW() - INTERVAL '90 days')
       OR (occurrences = 1 AND last_seen_at < NOW() - INTERVAL '14 days')
  `);
  const releasedCount = stuck.rowCount ?? 0;
  const deletedCount = deleted.rowCount ?? 0;
  const recycledCount = recycled.rowCount ?? 0;
  if (deletedCount || releasedCount || recycledCount) {
    logger.info({ deleted: deletedCount, released: releasedCount, recycled: recycledCount }, "skill_patterns.cleanup");
  }
  return { deleted: deletedCount, released: releasedCount, recycled: recycledCount };
}

// ===== Skill Statistics (from claw_session_events) =====

/**
 * Get execution stats for a skill, scoped to a specific user.
 *
 * Counts ALL executions where this skill was used, including multi-skill
 * runs (was: only sole-skill). The Phase 3 attribution fix already credits
 * multi-skill runs in feedback recording, so excluding them here is
 * inconsistent — and excludes most real complex tasks.
 *
 * v3.5 #7: optional `version` param — when provided, scopes to executions of
 * exactly that version. Used by maybeEvolveSkill so the LLM doesn't see stale
 * cross-version stats (e.g. v1's failures bleeding into v2's evolution decision).
 */
export async function getSkillStats(skillName: string, userId: string, days = 7, version?: number) {
  const params: (string | number)[] = [userId, skillName];
  let versionFilter = "";
  if (version !== undefined) {
    params.push(version);
    versionFilter = `AND (data->'skills_used'->>$2)::int = $${params.length}`;
  }
  // NOTE: cast `data` to jsonb — some installations have the column typed as `json`
  // (legacy V1 schema), which lacks the `?` and `jsonb_object_keys` operators.
  return (await db.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE (data->>'failed')::boolean IS NOT TRUE) as successes,
      AVG((data->>'turns')::int) as avg_turns,
      AVG(COALESCE((data->>'error_count')::int, 0)) as avg_errors
    FROM claw_session_events
    WHERE event = 'exec_complete'
      AND data->>'user_id' = $1
      AND (data::jsonb)->'skills_used' ? $2
      ${versionFilter}
      AND created_at > NOW() - INTERVAL '${days} days'
  `, params)).rows[0];
}

export async function getSkillStatsForVersion(skillName: string, userId: string, version: number) {
  return (await db.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE (data->>'failed')::boolean IS NOT TRUE) as successes
    FROM claw_session_events
    WHERE event = 'exec_complete'
      AND data->>'user_id' = $1
      AND (data->'skills_used'->>$2)::int = $3
  `, [userId, skillName, version])).rows[0];
}


// ===== Auto Skill Creation prompt (used by the legacy maybeCreateSkill below; not wired into the pipeline) =====

const CREATE_SKILL_PROMPT = `You are a Skill extractor. Analyze the following successfully completed task and decide whether it is worth extracting as a reusable Skill.

## User's original request:
{user_prompt}

## Tool call sequence:
{tool_sequence}

## Final result:
{final_result}

## Existing Skills (avoid duplicates):
{existing_skills}

Criteria:
1. Is the workflow generalizable? (not a one-off special operation)
2. Is it complex enough? (3+ tools coordinated)
3. Does it contain non-obvious tricks or ordering?
4. Does it overlap with an existing Skill?

If worth creating, return:
{
  "should_create": true,
  "skill_name": "kebab-case-name",
  "skill_description": "2-4 sentences: what the skill does, when to use it, when NOT to use it",
  "reason": "why it is worth saving",
  "skill_content": "## Goal\\n...\\n## Steps\\n1. ...\\n## Notes\\n- ..."
}
Otherwise: { "should_create": false, "reason": "..." }`;

// ===== E3: Task pattern aggregation =====
// Replaces single-session-driven auto-create. We hash the (toolSequence, intent prefix)
// of every successful complex task and bump a per-user counter; only after the same
// pattern recurs N>=3 times do we ask the LLM to extract a skill — fed all N trajectories
// at once, so the LLM sees the actual recurring shape, not a single anecdote.

const PATTERN_PROMOTE_THRESHOLD = 3;
/** Quick hash compatible across Node versions (FNV-1a, 32-bit). */
function hashStr(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Q4 (Plan A): Use a small LLM call to extract structured intent tags so that
 * cross-language and synonym-rich prompts collapse into the same bucket.
 *
 * Returns 0-5 lowercase snake_case fields chosen from a fixed schema. On any
 * LLM failure we fall back to the naive "first 5 words" heuristic so pattern
 * recording never blocks on background LLM availability.
 */
/**
 * F3: Closed vocabulary + temperature=0 → stable tags across paraphrases.
 *
 * Old prompt drift case (real evidence from earlier runs):
 *   "help me deploy this python web service to k8s"  → domain=backend
 *   "deploy this python service to kubernetes" → domain=infrastructure
 * → Different pattern_hash → never aggregates → never promotes to skill.
 *
 * Fix:
 *   1. temperature=0 makes the model deterministic per-prompt
 *   2. EVERY field has an explicit closed enum — model picks one from the list
 *      or omits the field; no free-form values that drift between synonyms
 *   3. Explicit "domain" rule: a deploy task is ALWAYS domain=infrastructure
 *      regardless of what's being deployed (a deploy of frontend code is still
 *      an infrastructure operation, not a frontend operation)
 */
const INTENT_VOCAB = {
  action: ["deploy", "analyze", "debug", "create", "fix", "test", "migrate", "configure", "refactor", "review", "monitor", "rollback", "build", "document"],
  // F3-v2: backend_api was being chosen over web_service for "backend service" (CN); collapsed.
  // Use web_service for ANY HTTP-serving thing including REST APIs, websockets, etc.
  // backend logic running headless without HTTP → use library or data_pipeline.
  target: ["web_service", "database", "kubernetes_pod", "kubernetes_cluster", "ci_pipeline", "data_pipeline", "report", "frontend_component", "infrastructure_resource", "library", "documentation"],
  platform: ["k8s", "aws", "azure", "gcp", "local", "docker", "ci", "bare_metal", "edge"],
  technology: ["python", "javascript", "typescript", "react", "vue", "go", "rust", "java", "postgres", "mysql", "redis", "nodejs", "fastapi", "flask", "django"],
  domain: ["infrastructure", "backend", "frontend", "data", "ml", "devops", "security", "observability"],
};

const EXTRACT_INTENT_TAGS_PROMPT = `Classify the user request into a STRICT closed-vocabulary tag set so the same intent expressed in different ways always produces the same tags.

For each field below, you must EITHER pick exactly one value from the listed enum OR omit the field entirely. Do not invent values.

action (verb): ${INTENT_VOCAB.action.join(", ")}
target (object): ${INTENT_VOCAB.target.join(", ")}
platform (where it runs): ${INTENT_VOCAB.platform.join(", ")}
technology (main tech stack): ${INTENT_VOCAB.technology.join(", ")}
domain (which engineering area): ${INTENT_VOCAB.domain.join(", ")}

Critical disambiguation rules (so paraphrases collapse correctly):
- ANY deploy / release / publish / go-live task → action=deploy, domain=infrastructure (regardless of WHAT is deployed)
- ANY "analyze data / run statistics / generate report" → action=analyze, domain=data
- ANY debug / troubleshoot / fix bug → action=debug, domain matches the broken component
- "build" only for compile/CI build, NOT for "build a feature" (use action=create for that)
- ANY HTTP-serving thing (REST API, web app, microservice, backend service, server) → target=web_service. Do NOT distinguish "backend api" from "web service" — they collapse to web_service.

Examples (these ALL must produce identical tags):
- "help me deploy this python web service to k8s" → {"action":"deploy","target":"web_service","platform":"k8s","technology":"python","domain":"infrastructure"}
- "deploy this python service to kubernetes" → {"action":"deploy","target":"web_service","platform":"k8s","technology":"python","domain":"infrastructure"}
- "publish the python flask app to the k8s cluster" → {"action":"deploy","target":"web_service","platform":"k8s","technology":"python","domain":"infrastructure"}

User request:
{user_prompt}

Output ONLY the JSON object (no preamble, no fences). If nothing matches with confidence, return {}.`;

const ALLOWED_INTENT_KEYS = new Set(["action", "target", "platform", "technology", "domain"]);

export async function extractIntentTags(userId: string, userPrompt: string): Promise<Record<string, string>> {
  if (!userPrompt) return {};
  try {
    const tags = await callMemoryLLM<Record<string, string>>(
      userId,
      EXTRACT_INTENT_TAGS_PROMPT,
      { user_prompt: userPrompt.slice(0, 1500) },
      { temperature: 0 },  // F3: deterministic
    );
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(tags || {})) {
      if (!ALLOWED_INTENT_KEYS.has(k) || typeof v !== "string" || !v.trim()) continue;
      const normalized = v.toLowerCase().trim().replace(/\s+/g, "_").slice(0, 64);
      // F3: enforce closed vocab — drop anything outside the enum so the model can't
      // sneak in a synonym that breaks bucket collapsing.
      if (!(INTENT_VOCAB as Record<string, string[]>)[k].includes(normalized)) {
        logger.warn({ key: k, value: normalized, allowed: (INTENT_VOCAB as Record<string, string[]>)[k] }, "intent_tags.value_outside_vocab_dropped");
        continue;
      }
      out[k] = normalized;
    }
    return out;
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "intent_tags.extraction_failed");
    return {};
  }
}

/** Naive fallback hash component when LLM tags are unavailable. */
function naiveIntentFallback(userPrompt: string): string {
  return (userPrompt || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join("_");
}

async function computePatternSignature(
  userId: string,
  toolEvents: any[],
  userPrompt: string,
): Promise<{ hash: string; signature: string; tags: Record<string, string> }> {
  const toolNames = toolEvents.map((e: any) => e.tool || e.data?.tool).filter(Boolean);
  const toolSet = [...new Set(toolNames)].sort().join(",");
  const tags = await extractIntentTags(userId, userPrompt);
  const canonical = Object.keys(tags).length
    ? Object.entries(tags).sort().map(([k, v]) => `${k}=${v}`).join("|")
    : `fallback=${naiveIntentFallback(userPrompt)}`;
  const signature = `tools=[${toolSet}] intent=${canonical}`;
  const hash = hashStr(`${toolSet}|${canonical}`);
  return { hash, signature, tags };
}

/**
 * Record a task pattern occurrence. Promotes pattern → skill once threshold is hit.
 * Pattern with same hash + same user → bump occurrences, append session_id to examples.
 * If new occurrences hit PATTERN_PROMOTE_THRESHOLD and pattern is not yet promoted,
 * trigger promotePatternToSkill in the background.
 */
export async function maybeRecordTaskPattern(sessionId: string, userId: string, event: any): Promise<void> {
  // Same gates as the old maybeCreateSkill — only successful, complex, multi-tool tasks
  if (event.failed) return;
  if ((event.turns as number) < 8) return;
  if ((event.error_count as number) > 5) return;

  const toolEvents = await getSessionToolEvents(sessionId);
  const distinctTools = new Set(toolEvents.map((e: any) => e.tool || e.data?.tool).filter(Boolean));
  if (distinctTools.size < 4) return;

  const { hash, signature } = await computePatternSignature(userId, toolEvents, event.prompt || "");

  // Atomically upsert: bump occurrences, append session id (deduped, capped at 5)
  const row = (await db.query(`
    INSERT INTO claw_skill_patterns (user_id, pattern_hash, signature, example_session_ids)
    VALUES ($1, $2, $3, $4::jsonb)
    ON CONFLICT (user_id, pattern_hash) DO UPDATE
    SET occurrences = claw_skill_patterns.occurrences + 1,
        last_seen_at = NOW(),
        signature = EXCLUDED.signature,
        example_session_ids = (
          SELECT to_jsonb((array_agg(DISTINCT s)))
          FROM (
            SELECT s FROM jsonb_array_elements_text(claw_skill_patterns.example_session_ids) s
            UNION ALL SELECT $5
          ) t
        )
    RETURNING id, occurrences, promoted_to_skill_id, example_session_ids
  `, [userId, hash, signature, JSON.stringify([sessionId]), sessionId])).rows[0];

  logger.info({ userId, hash, occurrences: row.occurrences, promoted: !!row.promoted_to_skill_id }, "skill.pattern_recorded");

  // Trigger promotion when we cross the threshold and haven't promoted before.
  // Run in background so we don't block exec_complete handling.
  if (row.occurrences >= PATTERN_PROMOTE_THRESHOLD && !row.promoted_to_skill_id) {
    setImmediate(() => {
      promotePatternToSkill(userId, row.id).catch(err =>
        logger.error({ err, patternId: row.id }, "skill.pattern_promote_failed"));
    });
  }
}

const PROMOTE_PATTERN_PROMPT = `You are an AI Skills curator. We've observed a recurring task pattern across {occurrences} sessions for the same user.

## Pattern signature
{signature}

## Existing skills (do NOT duplicate)
{existing_skills}

## Sample session trajectories (oldest → newest)
{trajectories}

Decide:
- If these sessions truly share a reusable workflow worth saving as a skill, return:
  { "should_create": true,
    "skill_name": "kebab-case-english-name",
    "skill_description": "2-4 sentences: what it does, when to use, when NOT to use",
    "skill_content": "## Goal\\n...\\n## Steps\\n...\\n## Notes\\n..." }
- If the sessions look superficially similar but the workflows actually diverge,
  or the pattern would just duplicate an existing skill, return:
  { "should_create": false, "reason": "..." }

Output ONLY a single JSON object. The skill content must be in the user's language.`;

/**
 * Promote a recurring task pattern into a skill.
 * Feeds the LLM the full trajectories of multiple sample sessions (E1-style evidence)
 * so it can extract the recurring structure rather than guessing from a single run.
 */
async function promotePatternToSkill(userId: string, patternId: number): Promise<void> {
  // B4: claim the pattern atomically with a sentinel value (-1) BEFORE doing the
  // expensive LLM call. Two concurrent setImmediate(promote) callers race here;
  // only the one whose UPDATE matches `promoted_to_skill_id IS NULL` proceeds.
  // The loser's rowCount is 0 and it bails out — saving an LLM round-trip and
  // preventing duplicate skill creation.
  const claim = await db.query(
    `UPDATE claw_skill_patterns
     SET promoted_to_skill_id = -1
     WHERE id = $1 AND promoted_to_skill_id IS NULL
     RETURNING signature, occurrences, example_session_ids`,
    [patternId]
  );
  if (!claim.rowCount) {
    logger.info({ patternId }, "skill.pattern_promote_already_claimed");
    return;
  }
  const pattern = claim.rows[0];

  const sessionIds: string[] = pattern.example_session_ids || [];
  const sampledIds = sessionIds.slice(0, 3);
  if (sampledIds.length < PATTERN_PROMOTE_THRESHOLD) {
    // Safety: release the claim so a future occurrence can retry
    await db.query(
      "UPDATE claw_skill_patterns SET promoted_to_skill_id = NULL WHERE id = $1 AND promoted_to_skill_id = -1",
      [patternId]
    );
    return;
  }

  // Build trajectories for each sample
  const trajectories: string[] = [];
  for (let i = 0; i < sampledIds.length; i++) {
    const sid = sampledIds[i];
    const toolEvents = await getSessionToolEvents(sid);
    if (!toolEvents.length) continue;
    const completeRow = (await db.query(
      `SELECT data FROM claw_session_events
       WHERE session_id = $1 AND event = 'exec_complete'
       ORDER BY created_at DESC LIMIT 1`,
      [sid]
    )).rows[0];
    const data = completeRow?.data || {};
    const prompt = (data.prompt || "").slice(0, 500);
    const finalText = (data.final_text || "").slice(0, 500);
    trajectories.push(
      `### Session ${i + 1} (id=${sid})\n` +
      `User asked: ${prompt}\n` +
      `Tool sequence: ${formatToolSequence(toolEvents).slice(0, 1500)}\n` +
      `Final outcome: ${finalText}`
    );
  }
  // B4: helper to release the claim sentinel on every early-return path so a
  // future occurrence can retry promotion (otherwise the pattern would be stuck
  // in "claimed but never linked" state and never promote).
  const releaseClaim = async () => {
    await db.query(
      "UPDATE claw_skill_patterns SET promoted_to_skill_id = NULL WHERE id = $1 AND promoted_to_skill_id = -1",
      [patternId]
    ).catch(() => {});
  };

  if (trajectories.length < PATTERN_PROMOTE_THRESHOLD) {
    await releaseClaim();
    return;
  }

  const existingSkills = await getUserSkillNames(userId);

  let result;
  try {
    result = await callMemoryLLM<{
      should_create: boolean;
      skill_name?: string;
      skill_description?: string;
      skill_content?: string;
      reason?: string;
    }>(userId, PROMOTE_PATTERN_PROMPT, {
      occurrences: String(pattern.occurrences),
      signature: pattern.signature,
      existing_skills: existingSkills.join(", ") || "(none)",
      trajectories: trajectories.join("\n\n---\n\n"),
    });
  } catch (err) {
    await releaseClaim();
    throw err;
  }

  if (!result.should_create || !result.skill_name || !result.skill_content) {
    logger.info({ patternId, reason: result.reason }, "skill.pattern_promote_skipped");
    await releaseClaim();
    return;
  }

  const blocked = autoSkillBlocked(result.skill_content, SKILL_MD_MAX_CHARS)
    ?? autoSkillBlocked(result.skill_description || "", SKILL_DESCRIPTION_MAX_CHARS);
  if (blocked) {
    logger.warn({ reason: blocked }, "skill.pattern_promote_blocked");
    await releaseClaim();
    return;
  }

  // N4: refuse to collide with an existing active/probation skill of the same name.
  // LLM was given existing_skills and told not to duplicate, but as a safety net we
  // explicitly check. Without this, saveSkill's in-place Case 1 would silently
  // overwrite the user's (possibly manually authored) existing skill with this
  // LLM-generated content — a data-loss scenario that the 'existing_skills' prompt
  // hint alone cannot guarantee against.
  const nameCollision = await db.query(
    `SELECT id, source FROM claw_skills
     WHERE skill_name = $1 AND user_id = $2
       AND status IN ('active', 'probation') AND deleted_at IS NULL`,
    [result.skill_name, userId]
  );
  if (nameCollision.rowCount) {
    logger.warn(
      { patternId, skillName: result.skill_name, userId, existingSource: nameCollision.rows[0].source },
      "skill.pattern_promote_name_collision"
    );
    await releaseClaim();
    return;
  }

  // Save as 'auto-pattern' source → starts in 'probation'. A user with no room keeps every skill they have.
  // createOnly: the collision check above ran before the lock; a skill of this name created since is not overwritten.
  const saved = await inTransaction(async (q) => {
    const r = await saveSkill(
      result.skill_name!, userId,
      result.skill_content!, "auto-pattern",
      sampledIds[sampledIds.length - 1],
      result.skill_description || "",
      { origin: "auto", createOnly: true, query: q },
    );
    if (r.ok) {
      await recordSkillEvent(q, {
        userId, skillName: result.skill_name!, version: r.version, op: "create", actor: "auto",
        detail: { origin: "auto", pattern_id: patternId },
      });
    }
    return r;
  });
  if (!saved.ok) {
    logger.info({ patternId, userId, reason: saved.error }, "skill.pattern_promote_refused");
    await releaseClaim();
    return;
  }

  // Find the new skill row and link it back to the pattern
  const skillRow = (await db.query(
    "SELECT id FROM claw_skills WHERE skill_name = $1 AND user_id = $2 AND deleted_at IS NULL ORDER BY version DESC LIMIT 1",
    [result.skill_name, userId]
  )).rows[0];
  if (skillRow) {
    await db.query("UPDATE claw_skill_patterns SET promoted_to_skill_id = $1 WHERE id = $2", [skillRow.id, patternId]);
  }

  logger.info({ patternId, skillName: result.skill_name, userId }, "skill.pattern_promoted");
}

// ===== Legacy maybeCreateSkill (kept for backward compat / manual use; not wired into pipeline) =====

export async function maybeCreateSkill(sessionId: string, userId: string, event: any): Promise<void> {
  if (event.failed) return;
  if ((event.turns as number) < 8) return;
  if ((event.error_count as number) > 5) return;

  const toolEvents = await getSessionToolEvents(sessionId);
  const toolTypes = new Set(toolEvents.map((e: any) => e.tool || e.data?.tool));
  if (toolTypes.size < 4) return;

  const existingSkills = await getUserSkillNames(userId);

  try {
    const result = await callMemoryLLM<{
      should_create: boolean;
      skill_name?: string;
      skill_description?: string;
      reason?: string;
      skill_content?: string;
    }>(userId, CREATE_SKILL_PROMPT, {
      user_prompt: (event.prompt as string || "").slice(0, 2000),
      tool_sequence: formatToolSequence(toolEvents),
      final_result: (event.final_text as string || "").slice(0, 2000),
      existing_skills: existingSkills.join(", ") || "(none)",
    });

    if (result.should_create && result.skill_content && result.skill_name) {
      const blocked = autoSkillBlocked(result.skill_content, SKILL_MD_MAX_CHARS)
        ?? autoSkillBlocked(result.skill_description || "", SKILL_DESCRIPTION_MAX_CHARS);
      if (blocked) { logger.warn({ reason: blocked }, "skill.create_blocked"); return; }

      // Delegate to saveSkill so soft-deleted rows are revived correctly; a full user is refused, never evicted.
      const saved = await inTransaction(async (q) => {
        const r = await saveSkill(
          result.skill_name!, userId,
          result.skill_content!, "auto",
          sessionId, result.skill_description || "",
          { origin: "auto", createOnly: true, query: q },
        );
        if (r.ok) {
          await recordSkillEvent(q, {
            userId, skillName: result.skill_name!, version: r.version, op: "create", actor: "auto", sessionId, detail: { origin: "auto" },
          });
        }
        return r;
      });
      if (!saved.ok) { logger.info({ userId, reason: saved.error }, "skill.create_refused"); return; }
      // Set change_reason separately (saveSkill doesn't accept it)
      await db.query(
        `UPDATE claw_skills SET change_reason = $1 WHERE skill_name = $2 AND user_id = $3 AND deleted_at IS NULL`,
        [result.reason, result.skill_name, userId]
      );

      logger.info({ skillName: result.skill_name, userId, reason: result.reason }, "skill.auto_created");
    }
  } catch (err) {
    logger.error({ err, sessionId, userId }, "skill.creation_failed");
  }
}

// ===== Skill Evolution (maybeEvolveSkill) =====

/**
 * Decide if this skill needs evolution.
 * Uses stats SCOPED to the current active version to avoid re-triggering
 * on stale failures from a previous version that already evolved.
 */
async function shouldEvolveSkill(skillName: string, userId: string, currentVersion: number): Promise<boolean> {
  // Multi-skill runs are admitted (not just sole-skill) since Phase 3 already
  // attributes feedback to them; threshold raised 5 -> 8 to offset the
  // noisier signal from shared attribution.
  const stats = (await db.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE (data->>'failed')::boolean IS NOT TRUE) as successes,
      AVG((data->>'turns')::int) as avg_turns,
      AVG(COALESCE((data->>'error_count')::int, 0)) as avg_errors
    FROM claw_session_events
    WHERE event = 'exec_complete'
      AND data->>'user_id' = $1
      AND (data->'skills_used'->>$2)::int = $3
      AND created_at > NOW() - INTERVAL '7 days'
  `, [userId, skillName, currentVersion])).rows[0];

  if (parseInt(stats.total) < 8) return false;
  const failRate = (parseInt(stats.total) - parseInt(stats.successes)) / parseInt(stats.total);
  return failRate > 0.3 || parseFloat(stats.avg_turns) > 20 || parseFloat(stats.avg_errors) > 3;
}

/**
 * Evolve prompt: BATCH-style. The LLM plans a coordinated set of mutations
 * that, applied together, would let every bad case in the evidence pass.
 * Inspired by SkillClaw + Hermes multi-file skills.
 *
 * Why batch instead of single-action:
 *   A single bad case often needs both a SKILL.md tweak AND a new script file.
 *   Forcing one-action-per-iteration wastes evolution cycles and leaves the
 *   skill in a half-fixed state until the next 5+ feedback runs accumulate.
 *
 * E1 (evidence-based): good + bad case trajectories included.
 * E2 (multi-file):    mutations can touch SKILL.md, description, and sub-files.
 * E3 (probation):     handled outside this prompt (probation skills skip evolve).
 *
 * Bias toward minimal change: when in doubt, return an empty mutations list.
 */
const EVOLVE_SKILL_PROMPT = `You are a Skill improvement analyzer for an AI agent system.

## Current Skill: {skill_name}
{skill_content}

## Sub-files attached to this skill
{sub_files}

## Last 7 days aggregate statistics
{stats}

## Sample successful runs (good cases — what currently works)
{good_cases}

## Sample problematic runs (bad cases — what currently fails or struggles)
{bad_cases}

## Existing skill names (avoid duplicates if creating a new one)
{existing_skills}

## Your task

Plan a coordinated batch of mutations that, applied together, would let EVERY bad case in the evidence succeed without breaking the good cases. Use as few mutations as the evidence justifies — minimum change is best.

Return a single JSON object:

{
  "reason": "What the bad cases share, and why this batch fixes them.",
  "mutations": [ ... 0 or more mutations ... ]
}

If evidence is too weak/ambiguous, or the skill is already working, return mutations: [].

## Mutation types (use any combination)

- { "type": "optimize_description", "new_description": "...", "reason": "..." }
- { "type": "improve_skill",        "revised_content": "full revised SKILL.md body", "reason": "..." }
- { "type": "improve_file",         "file_path": "scripts/x.sh", "new_content": "...", "reason": "..." }
- { "type": "add_file",             "file_path": "templates/y.yaml", "content": "...", "reason": "..." }
- { "type": "delete_file",          "file_path": "references/old.md", "reason": "..." }
- { "type": "create_new_skill",     "skill_name": "kebab-case-name", "skill_description": "what/when/when NOT", "skill_content": "## Goal\\n..." }

## Hard constraints

- Each mutation must be independently justified by evidence
- Conservative editing: tighten existing sections, do not impose new templates
- Do not delete environment-specific facts (endpoints, ports, payloads, filenames)
- Do not add generic agent-runtime advice (retry logic, rate limits) unless the environment specifically requires it
- A failure may be the agent's fault, not the skill's — do not bloat skill with agent-level workarounds
- delete_file: refuse if SKILL.md mentions that file_path
- improve_file / add_file: file_path must start with references/, templates/, scripts/, or assets/
- create_new_skill MUST be the only mutation in the batch (it spawns a sibling skill, mixing it with edits to the current skill creates confusion)
- Two mutations cannot target the same file_path; pick one (improve, delete, or add)
- Output ONLY the JSON object, no preamble, no markdown fences.`;

/**
 * Batch verifier prompt: final quality gate before publishing an evolved skill.
 * Inspired by SkillClaw's skill_verifier; batched into a single LLM call so
 * a 4-mutation batch costs 1 verify call instead of 4 (4x faster + 4x cheaper).
 *
 * Since applyEvolveBatch is all-or-nothing anyway (any one rejection kills
 * the whole batch), there is no semantic loss from batching the verifier.
 */
const VERIFY_BATCH_PROMPT = `You are the final quality gate for a coordinated batch of evolved Skill mutations.

The batch is all-or-nothing: if you reject any single mutation, the entire
batch is discarded. Be lenient on minor wording but strict on safety/grounding.

## Mutations to verify
{mutations}

Score EACH mutation on 4 dimensions (0.0 to 1.0):

1. grounded_in_evidence — Is the change supported by the reason and not speculative?
2. preserves_existing_value — Does it keep useful environment facts (APIs, ports, paths)?
3. specificity_and_reusability — Specific and reusable, not generic agent advice?
4. safe_to_publish — Coherent and safe to apply automatically?

Reject any mutation that is:
- Speculative or weakly supported
- Removes useful instructions/endpoints/ports without justification
- Mostly generic best practices instead of environment-specific knowledge

Return EXACTLY one JSON object whose results array is the SAME LENGTH AND ORDER
as the mutations above:

{
  "results": [
    {
      "decision": "accept" | "reject",
      "score": 0.0-1.0,
      "reason": "short explanation",
      "checks": {
        "grounded_in_evidence": 0.0-1.0,
        "preserves_existing_value": 0.0-1.0,
        "specificity_and_reusability": 0.0-1.0,
        "safe_to_publish": 0.0-1.0
      }
    }
  ]
}`;

const VERIFIER_MIN_SCORE = 0.75;

interface VerifierResult {
  decision: "accept" | "reject";
  score: number;
  reason: string;
  checks: Record<string, number>;
}

interface VerifierInput {
  action: string;
  originalContent: string;
  candidateContent: string;
  reason: string;
}

/**
 * Verify N mutations in one LLM call. Returns null on LLM error / shape mismatch
 * — caller treats null as batch reject (safer default).
 */
async function verifyMutationBatch(
  userId: string,
  inputs: VerifierInput[],
): Promise<VerifierResult[] | null> {
  if (!inputs.length) return [];
  const rendered = inputs.map((v, i) => (
    `### Mutation ${i + 1} — action: ${v.action}\n` +
    `Original:\n${(v.originalContent || "(none)").slice(0, 4000)}\n` +
    `Candidate:\n${v.candidateContent.slice(0, 4000)}\n` +
    `Reason: ${v.reason}`
  )).join("\n\n");

  try {
    const result = await callMemoryLLM<{ results: VerifierResult[] }>(
      userId,
      VERIFY_BATCH_PROMPT,
      { mutations: rendered },
    );
    const arr = result.results;
    if (!Array.isArray(arr) || arr.length !== inputs.length) {
      logger.warn({ expected: inputs.length, got: Array.isArray(arr) ? arr.length : "not-array" },
        "skill.verifier_batch_shape_mismatch");
      return null;
    }
    return arr.map((r) => {
      const score = typeof r.score === "number" ? Math.max(0, Math.min(1, r.score)) : 0;
      const accepted = r.decision === "accept" && score >= VERIFIER_MIN_SCORE;
      return {
        decision: accepted ? "accept" : "reject",
        score,
        reason: r.reason || "",
        checks: r.checks || {},
      };
    });
  } catch (err) {
    logger.warn({ err }, "skill.verifier_batch_failed");
    return null;
  }
}

// ===== Evolve decision: BATCH of mutations (Q3) =====
// LLM plans a coordinated set of mutations that, applied together, would let
// every bad case in the evidence pass. We validate + verify each mutation
// independently, then apply the entire batch in a single DB transaction
// (all-or-nothing). Empty mutations[] = skip.

type Mutation =
  | { type: "optimize_description"; new_description: string; reason?: string }
  | { type: "improve_skill"; revised_content: string; reason?: string }
  | { type: "improve_file"; file_path: string; new_content: string; reason?: string }
  | { type: "add_file"; file_path: string; content: string; reason?: string }
  | { type: "delete_file"; file_path: string; reason?: string }
  | {
      type: "create_new_skill";
      skill_name: string;
      skill_description?: string;
      skill_content: string;
      reason?: string;
    };

interface EvolveDecision {
  reason?: string;
  mutations: Mutation[];
}

/**
 * E1: Pull good+bad case trajectories for the LLM evolve prompt.
 * Sole-skill executions only (so attribution is clean).
 *
 * "Good" = clean success (failed=false, low turns, low errors)
 * "Bad" = failed OR high turns/errors
 */
async function getEvolveEvidence(
  skillName: string,
  userId: string,
  currentVersion: number,
  goodCount: number = EVOLVE_EVIDENCE_GOOD_COUNT,
  badCount: number = EVOLVE_EVIDENCE_BAD_COUNT,
): Promise<{ good: string; bad: string }> {
  // Candidate filter: skill on current version, last 14 days. NO sole-skill
  // restriction anymore — multi-skill trajectories are admitted because
  // shouldEvolveSkill counts them too. To keep evidence as clean as possible,
  // ORDER BY sorts sole-skill runs first (count of skills_used keys ASC) so
  // LIMIT picks them preferentially; multi-skill runs only fill the
  // remaining slots if there aren't enough sole-skill samples.
  const baseFilter = `
    event = 'exec_complete'
    AND data->>'user_id' = $1
    AND (data->'skills_used'->>$2)::int = $3
    AND created_at > NOW() - INTERVAL '14 days'
  `;
  const soleSkillRank = `(SELECT count(*) FROM jsonb_object_keys((data::jsonb)->'skills_used'))`;
  const goodRows = (await db.query(
    `SELECT session_id, data FROM claw_session_events
     WHERE ${baseFilter}
       AND (data->>'failed')::boolean IS NOT TRUE
       AND COALESCE((data->>'error_count')::int, 0) <= 1
     ORDER BY ${soleSkillRank} ASC, (data->>'turns')::int ASC NULLS LAST LIMIT $4`,
    [userId, skillName, currentVersion, goodCount]
  )).rows;
  const badRows = (await db.query(
    `SELECT session_id, data FROM claw_session_events
     WHERE ${baseFilter}
       AND ((data->>'failed')::boolean = TRUE
            OR COALESCE((data->>'error_count')::int, 0) >= 3
            OR COALESCE((data->>'turns')::int, 0) >= 20)
     ORDER BY ${soleSkillRank} ASC,
              ((data->>'failed')::boolean)::int DESC,
              COALESCE((data->>'error_count')::int, 0) DESC LIMIT $4`,
    [userId, skillName, currentVersion, badCount]
  )).rows;

  const renderCase = async (row: any, label: string): Promise<string> => {
    const data = row.data || {};
    const toolEvents = await getSessionToolEvents(row.session_id);
    const prompt = (data.prompt || "").slice(0, 400);
    const finalText = (data.final_text || "").slice(0, 400);
    return `### ${label} — session ${row.session_id} (turns=${data.turns}, errors=${data.error_count}, failed=${data.failed})\n` +
           `User asked: ${prompt}\n` +
           `Tool sequence: ${formatToolSequence(toolEvents).slice(0, 1200)}\n` +
           `Outcome: ${finalText}`;
  };

  const goodTexts = await Promise.all(goodRows.map((r, i) => renderCase(r, `Good ${i + 1}`)));
  const badTexts = await Promise.all(badRows.map((r, i) => renderCase(r, `Bad ${i + 1}`)));
  return {
    good: goodTexts.join("\n\n") || "(no clean successes in window)",
    bad: badTexts.join("\n\n") || "(no clear failures in window)",
  };
}

/** Render sub-files list for the evolve prompt. */
async function renderSubFilesForPrompt(skillId: number): Promise<string> {
  const rows = (await db.query(
    "SELECT file_path, size_bytes, content FROM claw_skill_files WHERE skill_id = $1 ORDER BY file_path",
    [skillId]
  )).rows;
  if (!rows.length) return "(none)";
  return rows.map((r: any) => {
    const preview = (r.content || "").slice(0, 600);
    return `- ${r.file_path} (${r.size_bytes} bytes)\n\`\`\`\n${preview}\n\`\`\``;
  }).join("\n");
}

export async function maybeEvolveSkill(sessionId: string, userId: string, event: any): Promise<void> {
  const skillsUsed = (event.skills_used as Record<string, number>) || {};

  // Inline-only skills (no sub-files) never appear in skills_used because
  // their content is injected into the prompt, not written to the sandbox.
  // Credit them from selected_skills so evolution can still track them.
  // Skills WITH sub-files are only credited if the agent actually read them
  // (present in skills_used) — this avoids evolving irrelevant skills.
  const selectedSkills: string[] = Array.isArray(event.selected_skills) ? event.selected_skills : [];
  const candidateNames = new Set(Object.keys(skillsUsed));
  const untracked = selectedSkills.filter(n => !candidateNames.has(n));
  if (untracked.length) {
    const subfileRows = (await db.query(
      `SELECT DISTINCT s.skill_name FROM claw_skills s
       JOIN claw_skill_files f ON f.skill_id = s.id
       WHERE s.user_id = $1 AND s.skill_name = ANY($2)
         AND s.deleted_at IS NULL AND s.status = 'active'`,
      [userId, untracked]
    )).rows;
    const hasSubfiles = new Set(subfileRows.map((r: any) => r.skill_name));
    for (const name of untracked) {
      if (!hasSubfiles.has(name)) candidateNames.add(name);
    }
  }

  for (const skillName of candidateNames) {
    // E4: probation skills are excluded from evolution. They're still gathering signal —
    // evolving on partial data leads to whiplash (improve, demote, improve again).
    const activeSkill = (await db.query(
      "SELECT id, version, change_reason FROM claw_skills WHERE skill_name = $1 AND user_id = $2 AND status = 'active' AND deleted_at IS NULL",
      [skillName, userId]
    )).rows[0];
    if (!activeSkill) continue;

    if (!(await shouldEvolveSkill(skillName, userId, activeSkill.version))) continue;

    const currentContent = await getActiveSkillContent(skillName, userId);
    if (!currentContent) continue;

    // v3.5 #7: scope stats to the active version so the LLM doesn't see stale data
    // from a prior version that already evolved away from the failures.
    const stats = await getSkillStats(skillName, userId, 7, activeSkill.version);
    const evidence = await getEvolveEvidence(skillName, userId, activeSkill.version);
    const subFiles = await renderSubFilesForPrompt(activeSkill.id);
    const existingSkillNames = await getUserSkillNames(userId);

    try {
      const decision = await callMemoryLLM<EvolveDecision>(userId, EVOLVE_SKILL_PROMPT, {
        skill_name: skillName,
        skill_content: currentContent,
        sub_files: subFiles,
        stats: JSON.stringify(stats),
        good_cases: evidence.good,
        bad_cases: evidence.bad,
        existing_skills: existingSkillNames.filter(n => n !== skillName).join(", ") || "(none)",
      });

      await applyEvolveBatch(sessionId, userId, skillName, currentContent, activeSkill.id, decision);
    } catch (err) {
      logger.error({ err, skillName, sessionId }, "skill.evolution_failed");
    }
  }
}

/**
 * Validate + verify a single mutation in isolation. Returns null if the mutation
 * is acceptable, or an error string to surface as the rejection reason.
 *
 * "previousByPath" carries baseline content for sub-files we've already fetched
 * during the validate pass so the apply pass can write history without re-querying.
 */
interface MutationPlan {
  mutation: Mutation;
  verifier: VerifierResult;
  previousContent: string | null; // for improve_skill / improve_file / delete_file
}

interface MutationValidation {
  mutation: Mutation;
  previousContent: string | null;
  verifierInput: VerifierInput;
}

/**
 * Pure (no LLM) validation pass: shape checks, path/size limits, safety scan,
 * and baseline content lookup for sub-file edits. Returns the data needed by
 * the batch verifier — verifier itself is a separate call so N mutations
 * cost 1 LLM round-trip instead of N.
 */
async function validateMutation(
  m: Mutation,
  userId: string,
  skillName: string,
  currentContent: string,
): Promise<{ ok: true; validation: MutationValidation } | { ok: false; error: string }> {
  if (m.type === "optimize_description") {
    if (!m.new_description) return { ok: false, error: "optimize_description missing new_description" };
    const blocked = autoSkillBlocked(m.new_description, SKILL_DESCRIPTION_MAX_CHARS);
    if (blocked) return { ok: false, error: `safety scan blocked: ${blocked}` };
    return { ok: true, validation: {
      mutation: m, previousContent: null,
      verifierInput: { action: "optimize_description", originalContent: "", candidateContent: m.new_description, reason: m.reason || "" },
    }};
  }
  if (m.type === "improve_skill") {
    if (!m.revised_content) return { ok: false, error: "improve_skill missing revised_content" };
    const blocked = autoSkillBlocked(m.revised_content, SKILL_MD_MAX_CHARS);
    if (blocked) return { ok: false, error: `safety scan blocked: ${blocked}` };
    return { ok: true, validation: {
      mutation: m, previousContent: currentContent,
      verifierInput: { action: "improve_skill", originalContent: currentContent, candidateContent: m.revised_content, reason: m.reason || "" },
    }};
  }
  if (m.type === "improve_file") {
    const pc = validateSubFilePath(m.file_path);
    if (!pc.ok) return { ok: false, error: `improve_file path: ${pc.error}` };
    if (m.new_content === undefined) return { ok: false, error: "improve_file missing new_content" };
    if (Buffer.byteLength(m.new_content, "utf8") > SKILL_FILE_MAX_BYTES) return { ok: false, error: "improve_file too large" };
    const blocked = autoSkillBlocked(m.new_content, SKILL_FILE_MAX_BYTES);
    if (blocked) return { ok: false, error: `safety scan blocked: ${blocked}` };
    const existing = await getSkillFile(userId, skillName, m.file_path);
    if (!existing) return { ok: false, error: `improve_file: '${m.file_path}' not found` };
    return { ok: true, validation: {
      mutation: m, previousContent: existing.content,
      verifierInput: { action: "improve_file", originalContent: existing.content, candidateContent: m.new_content, reason: m.reason || "" },
    }};
  }
  if (m.type === "add_file") {
    const pc = validateSubFilePath(m.file_path);
    if (!pc.ok) return { ok: false, error: `add_file path: ${pc.error}` };
    if (!m.content) return { ok: false, error: "add_file missing content" };
    if (Buffer.byteLength(m.content, "utf8") > SKILL_FILE_MAX_BYTES) {
      return { ok: false, error: `add_file too large (${Buffer.byteLength(m.content, "utf8")} > ${SKILL_FILE_MAX_BYTES})` };
    }
    const blocked = autoSkillBlocked(m.content, SKILL_FILE_MAX_BYTES);
    if (blocked) return { ok: false, error: `safety scan blocked: ${blocked}` };
    const existing = await getSkillFile(userId, skillName, m.file_path);
    if (existing) return { ok: false, error: `add_file: '${m.file_path}' already exists; use improve_file` };
    return { ok: true, validation: {
      mutation: m, previousContent: null,
      verifierInput: { action: "add_file", originalContent: "", candidateContent: m.content, reason: m.reason || "" },
    }};
  }
  if (m.type === "delete_file") {
    const pc = validateSubFilePath(m.file_path);
    if (!pc.ok) return { ok: false, error: `delete_file path: ${pc.error}` };
    if (currentContent.includes(m.file_path)) {
      return { ok: false, error: `delete_file: '${m.file_path}' is referenced by SKILL.md` };
    }
    const existing = await getSkillFile(userId, skillName, m.file_path);
    if (!existing) return { ok: false, error: `delete_file: '${m.file_path}' not found` };
    return { ok: true, validation: {
      mutation: m, previousContent: existing.content,
      verifierInput: { action: "delete_file", originalContent: existing.content, candidateContent: "(file to be deleted)", reason: m.reason || "" },
    }};
  }
  if (m.type === "create_new_skill") {
    if (!m.skill_name || !m.skill_content) return { ok: false, error: "create_new_skill missing skill_name/skill_content" };
    if (m.skill_name === skillName) return { ok: false, error: "create_new_skill: cannot reuse parent skill name" };
    const blocked = autoSkillBlocked(m.skill_content, SKILL_MD_MAX_CHARS)
      ?? autoSkillBlocked(m.skill_description || "", SKILL_DESCRIPTION_MAX_CHARS);
    if (blocked) return { ok: false, error: `safety scan blocked: ${blocked}` };
    return { ok: true, validation: {
      mutation: m, previousContent: null,
      verifierInput: { action: "create_new_skill", originalContent: "", candidateContent: m.skill_content, reason: m.reason || "" },
    }};
  }
  return { ok: false, error: `unknown mutation type: ${(m as any).type}` };
}

/**
 * Apply a coordinated batch of mutations atomically. Validate + verify all
 * mutations first; only if every mutation passes does any DB write happen.
 *
 * All writes share a single BEGIN/COMMIT so the skill is never left in a
 * half-mutated state. On any error during apply, ROLLBACK reverts everything.
 */
async function applyEvolveBatch(
  sessionId: string,
  userId: string,
  skillName: string,
  currentContent: string,
  activeId: number,
  decision: EvolveDecision,
): Promise<void> {
  const mutations = decision.mutations || [];
  if (!mutations.length) {
    logger.info({ skillName, reason: decision.reason }, "skill.evolution_skipped");
    return;
  }

  // Cross-mutation sanity (Q3 safety):
  // - Two mutations cannot target the same file_path
  // - create_new_skill must be the only mutation
  const filePaths = new Set<string>();
  let hasCreateNew = false;
  for (const m of mutations) {
    if (m.type === "create_new_skill") hasCreateNew = true;
    if ("file_path" in m && m.file_path) {
      if (filePaths.has(m.file_path)) {
        logger.warn({ skillName, file: m.file_path }, "skill.evolution_duplicate_file_target");
        return;
      }
      filePaths.add(m.file_path);
    }
  }
  if (hasCreateNew && mutations.length > 1) {
    logger.warn({ skillName }, "skill.evolution_create_new_must_be_alone");
    return;
  }

  // Cumulative size check: simulate adds/deletes against current sub-file totals.
  let cumulativeDelta = 0;
  for (const m of mutations) {
    if (m.type === "add_file") cumulativeDelta += Buffer.byteLength(m.content, "utf8");
    if (m.type === "delete_file") {
      const ex = await getSkillFile(userId, skillName, m.file_path);
      if (ex) cumulativeDelta -= Buffer.byteLength(ex.content, "utf8");
    }
    if (m.type === "improve_file") {
      const ex = await getSkillFile(userId, skillName, m.file_path);
      if (ex) cumulativeDelta += (Buffer.byteLength(m.new_content, "utf8") - Buffer.byteLength(ex.content, "utf8"));
    }
  }
  if (cumulativeDelta > 0) {
    const totalRow = (await db.query(
      `SELECT COALESCE(SUM(size_bytes), 0) AS total FROM claw_skill_files WHERE skill_id = $1`,
      [activeId]
    )).rows[0];
    const mainSize = Buffer.byteLength(currentContent, "utf8");
    if (mainSize + Number(totalRow.total) + cumulativeDelta > SKILL_TOTAL_MAX_BYTES) {
      logger.warn({ skillName, cumulativeDelta }, "skill.evolution_batch_exceeds_capacity");
      return;
    }
  }

  // === Validate pass (no LLM, just data checks + baseline gathering) ===
  const validations: MutationValidation[] = [];
  for (let i = 0; i < mutations.length; i++) {
    const r = await validateMutation(mutations[i], userId, skillName, currentContent);
    if (!r.ok) {
      logger.warn({ skillName, idx: i, err: r.error }, "skill.evolution_batch_rejected_validate");
      return; // all-or-nothing: any reject kills the batch
    }
    validations.push(r.validation);
  }

  // === Single-call batch verifier (1 LLM call for N mutations) ===
  const verifierResults = await verifyMutationBatch(userId, validations.map(v => v.verifierInput));
  if (!verifierResults) {
    logger.warn({ skillName, mutations: mutations.length }, "skill.evolution_batch_rejected_verifier_unavailable");
    return;
  }
  const plans: MutationPlan[] = [];
  for (let i = 0; i < verifierResults.length; i++) {
    const r = verifierResults[i];
    if (r.decision === "reject") {
      logger.warn({ skillName, idx: i, score: r.score, reason: r.reason }, "skill.evolution_batch_rejected_verifier");
      return; // all-or-nothing
    }
    plans.push({
      mutation: validations[i].mutation,
      verifier: r,
      previousContent: validations[i].previousContent,
    });
  }

  // Special case: create_new_skill is a sibling skill row insert.
  // It doesn't modify the parent's claw_skills row, so we handle it outside the
  // parent-row transaction (validation already passed above).
  if (plans.length === 1 && plans[0].mutation.type === "create_new_skill") {
    const m = plans[0].mutation as Extract<Mutation, { type: "create_new_skill" }>;
    // A user with no room keeps every skill they have: the sibling is not created.
    const spawned = await inTransaction(async (q) => {
      await lockUserSkills(q, userId);
      const count = Number((await q(
        "SELECT COUNT(DISTINCT skill_name) AS n FROM claw_skills WHERE user_id = $1 AND deleted_at IS NULL", [userId],
      )).rows[0].n);
      if (count >= USER_SKILL_MAX || !(await hasProbationRoom(userId, q))) return false;
      const row = (await q(`
        INSERT INTO claw_skills (skill_name, user_id, version, content, description, source, status, change_reason, source_session, analysis, origin)
        VALUES ($1, $2, 1, $3, $4, 'auto', 'probation', $5, $6, $7, 'auto')
        ON CONFLICT (skill_name, user_id, version) DO NOTHING
        RETURNING id
      `, [
        m.skill_name, userId, m.skill_content, m.skill_description || "",
        m.reason || "Spawned from evolution", sessionId,
        JSON.stringify({ spawned_from: skillName, verifier: plans[0].verifier }),
      ])).rows[0];
      if (row) {
        await refreshContentSha(q, row.id);
        await recordSkillEvent(q, {
          userId, skillName: m.skill_name, version: 1, op: "create", actor: "auto", sessionId,
          detail: { origin: "auto", spawned_from: skillName },
        });
      }
      return true;
    });
    if (!spawned) {
      logger.info({ newSkill: m.skill_name, parentSkill: skillName, userId }, "skill.spawn_refused_full");
      return;
    }
    logger.info({ newSkill: m.skill_name, parentSkill: skillName }, "skill.spawned_from_evolution");
    return;
  }

  // === Apply pass: single DB transaction (all-or-nothing) ===
  const client = await db.pool.connect();
  let mutationVersionsApplied = 0;
  try {
    await client.query("BEGIN");
    // Under the user's skill lock, as every other write: the limit check before COMMIT holds only if no other write
    // to the skill can commit in between.
    await lockUserSkills((text, params) => client.query(text, params), userId);
    let bumpVersion = false;
    const changeReasons: string[] = [];

    for (const plan of plans) {
      const m = plan.mutation;
      switch (m.type) {
        case "optimize_description":
          await client.query(
            "UPDATE claw_skills SET description = $1 WHERE id = $2",
            [m.new_description, activeId]
          );
          changeReasons.push(`[desc] ${(m.reason || "").slice(0, 200)}`);
          break;
        case "improve_skill":
          await client.query(
            `UPDATE claw_skills SET content = $1, source = 'evolved', source_session = $2,
                                    last_accessed = NOW() WHERE id = $3`,
            [m.revised_content, sessionId, activeId]
          );
          bumpVersion = true;
          changeReasons.push(`[skill] ${(m.reason || "").slice(0, 200)}`);
          break;
        case "improve_file": {
          const sizeBytes = Buffer.byteLength(m.new_content, "utf8");
          await client.query(
            `UPDATE claw_skill_files SET content = $1, size_bytes = $2, updated_at = NOW()
             WHERE skill_id = $3 AND file_path = $4`,
            [m.new_content, sizeBytes, activeId, m.file_path]
          );
          changeReasons.push(`[file ${m.file_path}] ${(m.reason || "").slice(0, 150)}`);
          break;
        }
        case "add_file": {
          const sizeBytes = Buffer.byteLength(m.content, "utf8");
          await client.query(
            `INSERT INTO claw_skill_files (skill_id, user_id, file_path, content, is_binary, size_bytes)
             VALUES ($1, $2, $3, $4, false, $5)`,
            [activeId, userId, m.file_path, m.content, sizeBytes]
          );
          changeReasons.push(`[+${m.file_path}] ${(m.reason || "").slice(0, 150)}`);
          break;
        }
        case "delete_file":
          await client.query(
            "DELETE FROM claw_skill_files WHERE skill_id = $1 AND file_path = $2",
            [activeId, m.file_path]
          );
          changeReasons.push(`[-${m.file_path}] ${(m.reason || "").slice(0, 150)}`);
          break;
      }
      mutationVersionsApplied++;
    }

    // Append a single batch entry to analysis.history, recording every mutation's
    // previousContent so manualRollback can reverse the whole batch in one step.
    const batchEntry = {
      action: "batch",
      reason: decision.reason || "evolved batch",
      applied_at: new Date().toISOString(),
      mutations: plans.map((p) => ({
        type: p.mutation.type,
        ...("file_path" in p.mutation ? { file_path: (p.mutation as any).file_path } : {}),
        previous_content: p.previousContent,
        verifier_score: p.verifier.score,
      })),
    };
    await client.query(`
      UPDATE claw_skills
      SET analysis = jsonb_set(
        jsonb_set(COALESCE(analysis, '{}'::jsonb), '{latest}', $1::jsonb, true),
        '{history}',
        COALESCE(analysis->'history', '[]'::jsonb) || $1::jsonb,
        true
      )
      WHERE id = $2
    `, [JSON.stringify(batchEntry), activeId]);

    // Bump version once per batch if any improve_skill happened
    const combinedReason = changeReasons.join(" | ").slice(0, 500);
    if (bumpVersion) {
      await client.query(
        `UPDATE claw_skills SET version = version + 1, change_reason = $1 WHERE id = $2`,
        [combinedReason, activeId]
      );
    } else {
      await client.query(
        `UPDATE claw_skills SET change_reason = $1 WHERE id = $2`,
        [combinedReason, activeId]
      );
    }

    const tq: Querier = (text, params) => client.query(text, params);
    // The batch as applied, against the per-skill limits: a batch that would leave the skill over them is rolled back.
    const over = await skillCapacityProblem(tq, activeId);
    if (over) throw new Error(`evolution batch refused: ${over.message}`);
    await refreshContentSha(tq, activeId);
    const applied = (await tq("SELECT version FROM claw_skills WHERE id = $1", [activeId])).rows[0];
    await recordSkillEvent(tq, {
      userId, skillName, version: applied?.version ?? null, op: "update", actor: "auto", sessionId,
      detail: { origin: "auto", mutations: mutations.length },
    });
    await client.query("COMMIT");
    logger.info(
      { skillName, mutations: plans.length, applied: mutationVersionsApplied, bumpVersion },
      "skill.evolution_batch_applied",
    );
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error(
      { err: (err as Error)?.message, skillName, applied: mutationVersionsApplied },
      "skill.evolution_batch_rolled_back",
    );
  } finally {
    client.release();
  }
}


// ===== Auto Rollback =====
// NOTE: With in-place evolution (Phase A), there is no archived "previous version" row to revert to.
// Bad evolutions are now handled by Phase B's effectiveness tracking + eviction.
// Old getSkillStatsSince / getSkillStatsForVersion remain for stats queries / future use.

// ===== Manual Rollback =====
// v3.0: With in-place evolution, we restore from the most recent analysis.history entry
// that contains a previous_content_snippet. Legacy multi-version skills fall back to
// the old "restore archived v-1 row" path.

/** Undo the latest change to a skill (`manualRollbackInner`), then keep its fingerprint and audit trail. */
export async function manualRollback(skillName: string, userId: string, actor: SkillActor = "api"): Promise<boolean> {
  const done = await manualRollbackInner(skillName, userId);
  if (!done) return false;
  const row = (await db.query(
    `SELECT id, version FROM claw_skills WHERE skill_name = $1 AND user_id = $2 AND status IN ('active', 'probation')
       AND deleted_at IS NULL ORDER BY version DESC LIMIT 1`,
    [skillName, userId],
  )).rows[0];
  if (row) await refreshContentSha(db.query, row.id);
  await recordSkillEvent(db.query, { userId, skillName, version: row?.version ?? null, op: "rollback", actor })
    .catch((err) => logger.warn({ err: (err as Error)?.message, skillName }, "skill.rollback_audit_failed"));
  return true;
}

async function manualRollbackInner(skillName: string, userId: string): Promise<boolean> {
  const current = (await db.query(
    `SELECT id, version, content, description, analysis
     FROM claw_skills
     WHERE skill_name = $1 AND user_id = $2 AND status = 'active' AND deleted_at IS NULL
     ORDER BY version DESC LIMIT 1`,
    [skillName, userId]
  )).rows[0];
  if (!current) return false;

  // v3.5 #4: previously this returned false when version<=1, blocking rollback for
  // skills whose only mutations were file-level / description-level (which don't
  // bump version). Now we let the history walk decide — if no rollback-able entry
  // exists (history empty or all consumed), the search below returns false.

  // Legacy path: archived v-1 row still exists (pre-Phase-A skills).
  // Only meaningful when version > 1 — single-version skills can't have a prior archived row.
  if (current.version > 1) {
    const legacyPrev = (await db.query(
      "SELECT id FROM claw_skills WHERE skill_name = $1 AND user_id = $2 AND version = $3 AND deleted_at IS NULL",
      [skillName, userId, current.version - 1]
    )).rows[0];
    if (legacyPrev) {
      await db.query(
        "UPDATE claw_skills SET status = 'rolled_back' WHERE skill_name = $1 AND user_id = $2 AND version = $3",
        [skillName, userId, current.version]
      );
      await db.query(
        "UPDATE claw_skills SET status = 'active' WHERE skill_name = $1 AND user_id = $2 AND version = $3",
        [skillName, userId, current.version - 1]
      );
      logger.info({ skillName, mode: "legacy", rolledBackFrom: current.version }, "skill.manual_rollback");
      return true;
    }
  }

  // v3.0/v3.2 in-place path: walk analysis.history backward, restore the most recent
  // mutation step. Supports stack-style rollback across heterogeneous actions:
  //   - "batch" (v3.2): undo every nested mutation in reverse order, atomically
  //   - "improve_skill" / "improve_file" / "add_file" / "delete_file" / "optimize_description"
  //     (v3.0 single-action history; still readable for rollback compat)
  const history = current.analysis?.history;
  if (!Array.isArray(history) || !history.length) {
    logger.warn({ skillName }, "skill.manual_rollback_no_history");
    return false;
  }
  // N3: history is append-only; rolled-back entries are marked with a
  // paired `rollback_marker` entry appended after the rollback succeeds.
  // To find the next entry to undo, walk history in reverse and pair each
  // rollback_marker with the most recent preceding ROLLBACKABLE entry.
  // This makes manualRollback strictly idempotent: calling it twice in a row
  // no longer re-undoes the same entry.
  const ROLLBACKABLE = ["batch", "improve_skill", "improve_file", "add_file", "delete_file", "optimize_description"];
  let skipCount = 0;
  let last: any = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const h: any = history[i];
    if (h?.action === "rollback_marker") {
      skipCount++;
      continue;
    }
    if (h?.action && ROLLBACKABLE.includes(h.action)) {
      if (skipCount > 0) { skipCount--; continue; }
      last = h;
      break;
    }
  }
  if (!last) {
    logger.info({ skillName }, "skill.manual_rollback_nothing_to_undo");
    return false;
  }

  // Batch rollback: walk mutations in REVERSE so we undo last-applied first.
  // Each batch sees the parent claw_skills row at most once for content/version,
  // so we wrap the whole undo in a single transaction for atomicity.
  if (last.action === "batch") {
    const muts: any[] = Array.isArray(last.mutations) ? last.mutations : [];
    const client = await db.pool.connect();
    let undoneCount = 0;
    try {
      await client.query("BEGIN");
      await lockUserSkills((text, params) => client.query(text, params), userId);
      let needVersionDecrement = false;
      for (const m of [...muts].reverse()) {
        if (m.type === "improve_skill" && m.previous_content) {
          await client.query("UPDATE claw_skills SET content = $1 WHERE id = $2", [m.previous_content, current.id]);
          needVersionDecrement = true;
        } else if (m.type === "optimize_description" && m.previous_content !== undefined) {
          // Note: v3.2 batch records previous_content=null for desc; this is best-effort
        } else if (m.type === "improve_file" && m.file_path && m.previous_content) {
          await client.query(
            `UPDATE claw_skill_files SET content = $1, size_bytes = $2, updated_at = NOW()
             WHERE skill_id = $3 AND file_path = $4`,
            [m.previous_content, Buffer.byteLength(m.previous_content, "utf8"), current.id, m.file_path]
          );
        } else if (m.type === "add_file" && m.file_path) {
          await client.query(
            "DELETE FROM claw_skill_files WHERE skill_id = $1 AND file_path = $2",
            [current.id, m.file_path]
          );
        } else if (m.type === "delete_file" && m.file_path && m.previous_content) {
          await client.query(
            `INSERT INTO claw_skill_files (skill_id, user_id, file_path, content, is_binary, size_bytes)
             VALUES ($1, $2, $3, $4, false, $5) ON CONFLICT DO NOTHING`,
            [current.id, userId, m.file_path, m.previous_content, Buffer.byteLength(m.previous_content, "utf8")]
          );
        }
        undoneCount++;
      }
      // N3: append rollback_marker so this history entry is considered
      // "consumed"; a future manualRollback will skip it and find the next-older
      // ROLLBACKABLE entry instead of redoing the same undo.
      const marker = {
        action: "rollback_marker",
        rolled_back_action: "batch",
        mutations_count: muts.length,
        applied_at: new Date().toISOString(),
      };
      if (needVersionDecrement) {
        await client.query(
          `UPDATE claw_skills SET version = GREATEST(1, version - 1),
             change_reason = $1,
             analysis = jsonb_set(
               jsonb_set(analysis, '{latest}', $2::jsonb, true),
               '{history}',
               COALESCE(analysis->'history','[]'::jsonb) || $3::jsonb,
               true)
           WHERE id = $4`,
          [
            `[manual rollback] reverted batch (${undoneCount} mutations)`,
            JSON.stringify({ action: "rollback", rolled_back_batch: muts.length, applied_at: new Date().toISOString() }),
            JSON.stringify(marker),
            current.id,
          ]
        );
      } else {
        await client.query(
          `UPDATE claw_skills SET change_reason = $1,
             analysis = jsonb_set(
               jsonb_set(analysis, '{latest}', $2::jsonb, true),
               '{history}',
               COALESCE(analysis->'history','[]'::jsonb) || $3::jsonb,
               true)
           WHERE id = $4`,
          [
            `[manual rollback] reverted batch (${undoneCount} mutations)`,
            JSON.stringify({ action: "rollback", rolled_back_batch: muts.length, applied_at: new Date().toISOString() }),
            JSON.stringify(marker),
            current.id,
          ]
        );
      }
      await client.query("COMMIT");
      logger.info({ skillName, undone: undoneCount, mode: "batch" }, "skill.manual_rollback");
      return true;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      logger.error({ err: (err as Error)?.message, skillName }, "skill.manual_rollback_failed");
      return false;
    } finally {
      client.release();
    }
  }

  if (last.action === "improve_skill") {
    const restored = last.previous_content || last.previous_content_snippet;
    if (!restored) return false;
    // GREATEST guards against decrementing below 1 (defense in depth: should never
    // happen because improve_skill always bumps version, but if history was
    // hand-edited or migrated from a different lineage we don't want negative versions)
    await db.query(
      `UPDATE claw_skills
       SET content = $1, version = GREATEST(1, version - 1),
           change_reason = $2,
           analysis = jsonb_set(analysis, '{latest}', $3::jsonb, true)
       WHERE id = $4`,
      [restored, `[manual rollback] restored to pre-v${current.version} SKILL.md`,
       JSON.stringify({ action: "rollback", rolled_back_from: current.version, applied_at: new Date().toISOString() }),
       current.id]
    );
  } else if (last.action === "improve_file") {
    if (!last.file_path || !last.previous_content) return false;
    await updateSkillFile(userId, skillName, { file_path: last.file_path, content: last.previous_content });
    await db.query(
      `UPDATE claw_skills SET change_reason = $1,
         analysis = jsonb_set(analysis, '{latest}', $2::jsonb, true)
       WHERE id = $3`,
      [`[manual rollback] restored ${last.file_path}`,
       JSON.stringify({ action: "rollback", file_path: last.file_path, applied_at: new Date().toISOString() }),
       current.id]
    );
  } else if (last.action === "add_file") {
    if (!last.file_path) return false;
    await removeSkillFile(userId, skillName, last.file_path);
    await db.query(
      `UPDATE claw_skills SET change_reason = $1,
         analysis = jsonb_set(analysis, '{latest}', $2::jsonb, true)
       WHERE id = $3`,
      [`[manual rollback] removed added file ${last.file_path}`,
       JSON.stringify({ action: "rollback", file_path: last.file_path, applied_at: new Date().toISOString() }),
       current.id]
    );
  } else if (last.action === "delete_file") {
    if (!last.file_path || !last.previous_content) return false;
    await addSkillFile(userId, skillName, { file_path: last.file_path, content: last.previous_content });
    await db.query(
      `UPDATE claw_skills SET change_reason = $1,
         analysis = jsonb_set(analysis, '{latest}', $2::jsonb, true)
       WHERE id = $3`,
      [`[manual rollback] restored deleted file ${last.file_path}`,
       JSON.stringify({ action: "rollback", file_path: last.file_path, applied_at: new Date().toISOString() }),
       current.id]
    );
  }

  // N3: mark this history entry as consumed for idempotent repeat calls.
  const marker = {
    action: "rollback_marker",
    rolled_back_action: last.action,
    file_path: last.file_path,
    applied_at: new Date().toISOString(),
  };
  await db.query(
    `UPDATE claw_skills SET analysis = jsonb_set(
       analysis, '{history}',
       COALESCE(analysis->'history','[]'::jsonb) || $1::jsonb, true)
     WHERE id = $2`,
    [JSON.stringify(marker), current.id]
  );

  logger.info({ skillName, mode: "in_place", action: last.action }, "skill.manual_rollback");
  return true;
}

// ===== Delete Skill (all versions) =====

export async function deleteSkill(skillName: string, userId: string, actor: SkillActor = "api"): Promise<number> {
  return inTransaction(async (q) => {
    const result = await q(
      "UPDATE claw_skills SET deleted_at = NOW() WHERE skill_name = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING version",
      [skillName, userId]
    );
    const n = result.rowCount ?? 0;
    if (n) {
      const version = Math.max(...result.rows.map((r: any) => Number(r.version)));
      await recordSkillEvent(q, { userId, skillName, version, op: "delete", actor });
    }
    return n;
  });
}

/** Drafts nobody confirmed within SKILL_DRAFT_TTL_HOURS are deleted. */
export async function cleanupExpiredSkillDrafts(): Promise<number> {
  const result = await db.query(
    "DELETE FROM claw_skill_drafts WHERE created_at < NOW() - make_interval(hours => $1::int)",
    [SKILL_DRAFT_TTL_HOURS],
  );
  if (result.rowCount) logger.info({ deleted: result.rowCount }, "skill_drafts.expired_cleanup");
  return result.rowCount ?? 0;
}

// ===== Helpers =====

async function getSessionToolEvents(sessionId: string): Promise<any[]> {
  const lastCompleteId = (await db.query(
    "SELECT id FROM claw_session_events WHERE session_id = $1 AND event = 'exec_complete' ORDER BY id DESC LIMIT 1 OFFSET 1",
    [sessionId]
  )).rows[0]?.id || 0;

  const events = (await db.query(
    "SELECT data FROM claw_session_events WHERE session_id = $1 AND id > $2 AND (data->>'type' = 'toolUsed') ORDER BY id",
    [sessionId, lastCompleteId]
  )).rows.map((r: any) => r.data);

  return events;
}

function formatToolSequence(events: any[]): string {
  return events
    // A call whose tool answered an error ends with "error" (Brain's agent loop): it is part of the sequence, marked failed.
    .filter((e: any) => e.status === "start" || e.status === "success" || e.status === "error")
    .map((e: any) => `${e.status === "start" ? "→" : e.status === "error" ? "✗" : "✓"} ${e.tool}`)
    .join("\n")
    .slice(0, 3000);
}
