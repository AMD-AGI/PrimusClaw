// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which turns are told of the user's personal skills (`request.user_skills`), and keep what they save
 * (`user_skills_enabled`). A personal skill is the user's own instruction, so it goes only where the user is the one
 * talking: never into a turn whose words, or whose reader, may be someone else's.
 */
import pino from "pino";

import { CLAW_USER_SKILLS_ENABLED } from "../config.js";
import { db } from "../infra/db.js";
import { reviewProfileSession, sessionWithholdsSandboxKeys } from "../github-review/session-tools.js";
import { userSkillManifest, type UserSkillManifestEntry } from "../marketplace/skill-service.js";

const logger = pino({ name: "user-skills" });

async function existsOrNoTable(sql: string, params: unknown[]): Promise<boolean> {
  try {
    return (await db.query(sql, params)).rows.length > 0;
  } catch (err: any) {
    // A table that does not exist (the assistant or apps are off on this deployment) holds no such session.
    if (err?.code === "42P01") return false;
    throw err;
  }
}

/**
 * Whether this session's turns are the user's own conversation, the only kind their personal skills serve.
 *
 * Not served, by server-side facts a caller cannot write: a session owned by someone else; one that acts as a user
 * (`withhold_sandbox_keys`: a review on someone's behalf reads what strangers wrote, and its reply is theirs to
 * read); one that runs with the review profile; an assistant's router (it gets the user's skills its own way, not on
 * this field) and an assistant's watcher of a group or a repository (its turns are other people's messages); an
 * application's run; and any session that has carried a non-chat run (an A2A peer's, a task's, a DAG node's). Not
 * served on the caller's word either: `config.memory: "off"`, which is how a client marks a session other people
 * read, a group chat, where a turn may be started by anyone in it. A work item's worker is served: its turns are the
 * user's work, started by their assistant.
 *
 * Fails closed: a question that cannot be answered is a session the skills do not serve.
 */
export async function userSkillsServe(sessionId: string, userId: string): Promise<boolean> {
  if (!CLAW_USER_SKILLS_ENABLED || !userId || !sessionId) return false;
  try {
    const session = (await db.query(
      "SELECT user_id, config->'memory' AS memory FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
      [sessionId],
    )).rows[0] as { user_id: string | null; memory: unknown } | undefined;
    if (!session || session.user_id !== userId) return false;
    if (session.memory === "off" || session.memory === false) return false;
    if (await sessionWithholdsSandboxKeys(sessionId)) return false;
    if (await reviewProfileSession(sessionId)) return false;
    if (await existsOrNoTable("SELECT 1 FROM claw_tasks WHERE session_id = $1 AND origin <> 'chat' LIMIT 1", [sessionId])) return false;
    for (const sql of [
      "SELECT 1 FROM claw_assistants WHERE session_id = $1",
      "SELECT 1 FROM claw_assistant_scopes WHERE session_id = $1",
      "SELECT 1 FROM claw_app_runs WHERE session_id = $1 LIMIT 1",
    ]) {
      if (await existsOrNoTable(sql, [sessionId])) return false;
    }
    return true;
  } catch (err) {
    logger.error({ sessionId, code: (err as { code?: string })?.code ?? "" }, "user_skills.access_unreadable_not_served");
    return false;
  }
}

/** What a turn carries of the user's skills. */
export interface TurnUserSkills {
  /** `user_skills_enabled`: Brain offers the skill-writing tools, and the API keeps what they save. */
  enabled: boolean;
  /** `user_skills`: absent when there is none to list (or the list could not be read). */
  manifest?: UserSkillManifestEntry[];
}

/**
 * What a chat turn of this session carries of the user's skills. A list that cannot be read is left off and logged:
 * the turn runs without it, as it would for a user with no skills, and nothing of the skills' text is logged.
 */
export async function userSkillsForTurn(sessionId: string, userId: string): Promise<TurnUserSkills> {
  if (!(await userSkillsServe(sessionId, userId))) return { enabled: false };
  try {
    const manifest = await userSkillManifest(userId);
    return manifest.length ? { enabled: true, manifest } : { enabled: true };
  } catch (err) {
    logger.error({ sessionId, userId, code: (err as { code?: string })?.code ?? "" }, "user_skills.manifest_failed");
    return { enabled: true };
  }
}

/** Puts `userSkillsForTurn` on a task: both fields set from it, so nothing the task brought widens it. */
export function applyTurnUserSkills(task: Record<string, unknown>, skills: TurnUserSkills): void {
  task.user_skills_enabled = skills.enabled;
  if (skills.manifest?.length) task.user_skills = skills.manifest;
  else delete task.user_skills;
}
