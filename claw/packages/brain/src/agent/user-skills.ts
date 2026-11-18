// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The user's personal skills in a turn: listed by name and description like the platform's skills, and read when the
 * model uses one (`load_skill`), or when a sandbox command first names one (its scripts run from
 * `.skills/.personal-skills/<name>/`).
 *
 * The API decides which skills a turn may use and says so in `request.user_skills` (name, version, description,
 * invocation, fingerprint, origin; none of the text). The text is the API's to give: `POST /v1/internal/skills/read`
 * with the session, the turn and the fingerprint the turn was told, so a skill changed during the turn is refused
 * rather than mixed. What is fetched is kept for this run only, in a private directory under the run's work root,
 * which the run removes when it ends: nothing of one user's skills outlives the turn on Brain.
 */
import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import type { ExecuteRequest, UserSkillManifestEntry } from "@claw/protocol";

import { apiBase, claimHeaders } from "../clients/run-claim.js";
import { metrics } from "../infra/metrics.js";
import { isSafeRelativePath } from "../sandbox/write.js";
import { createPrivateStagingRoot } from "../tasks/plugin-from-message.js";
import { SKILL_NAME_RE, type DefaultSkill } from "./platform-defaults.js";
import { SKILL_NAME_MAX_CHARS } from "./skill-store.js";

const logger = pino({ name: "user-skills" });

/** A personal skill's description as listed: the API sends at most 300 characters; the list carries at most this many. */
export const PERSONAL_DESCRIPTION_LIST_MAX = 200;
/** Most files of one skill fetched (the API holds at most 20). */
const MAX_FILES = 50;
const READ_TIMEOUT_MS = 15_000;

/**
 * Whether this run uses the user's personal skills at all: the API said so (`user_skills_enabled`) and the run is
 * the user's own. A session that acts as a user, and a router's or observer's turn, never has them whatever the request
 * carries; the API strips them there too, so this is the second of two locks.
 */
export function userSkillsApply(request: ExecuteRequest): boolean {
  return request.user_skills_enabled === true
    && !request.withhold_sandbox_keys
    && request.skip_platform_defaults !== true
    && Array.isArray(request.user_skills);
}

/** What went wrong reading a skill, as the model is told it; `outcome` is what `load_skill` counts it under. */
export class UserSkillUnavailable extends Error {
  constructor(message: string, readonly outcome: "changed" | "not_found" | "failed") { super(message); }
}

/** `request.user_skills`, as skills `load_skill` and the lazy writer can serve. Entries that are not well formed are dropped and logged. */
export function userSkillsOf(
  request: ExecuteRequest,
  workRoot: string,
): DefaultSkill[] {
  if (!userSkillsApply(request)) return [];
  const out: DefaultSkill[] = [];
  const seen = new Set<string>();
  for (const raw of request.user_skills as unknown[]) {
    const e = raw as Partial<UserSkillManifestEntry> | null;
    const name = typeof e?.name === "string" ? e.name : "";
    const sha = typeof e?.content_sha === "string" ? e.content_sha : "";
    const version = typeof e?.version === "number" && Number.isInteger(e.version) && e.version > 0 ? e.version : 0;
    if (!name || name.length > SKILL_NAME_MAX_CHARS || !SKILL_NAME_RE.test(name) || !sha || !version || seen.has(name)) {
      logger.warn({ sessionId: request.session_id, name: name.slice(0, 80) }, "user_skill.manifest_entry_dropped");
      continue;
    }
    seen.add(name);
    const description = typeof e?.description === "string" ? e.description.replace(/\s+/g, " ").trim() : "";
    const skill: DefaultSkill = {
      name,
      toolId: 0,
      description: clip(description || name, PERSONAL_DESCRIPTION_LIST_MAX),
      // Not there yet: staged on first use.
      localDir: path.join(workRoot, "user-skills", "unstaged", name),
      source: "user",
      user: { version, contentSha: sha, imported: e?.origin === "import", manual: e?.invocation === "manual" },
    };
    skill.restage = singleFlight(() => stageUserSkill(request, skill, path.join(workRoot, "user-skills")));
    out.push(skill);
  }
  return out;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** One staging at a time per skill: two reads in one turn wait for the same fetch. A failure is not kept. */
function singleFlight(fn: () => Promise<string>): () => Promise<string> {
  let running: Promise<string> | null = null;
  return () => {
    if (!running) {
      running = fn();
      running.then(() => { running = null; }, () => { running = null; });
    }
    return running;
  };
}

/** Fetch the skill's SKILL.md and every file from the API into a fresh private directory; returns it. */
async function stageUserSkill(request: ExecuteRequest, skill: DefaultSkill, root: string): Promise<string> {
  const u = skill.user!;
  try {
    const doc = await readFromApi(request, skill.name, u.contentSha);
    // A fresh 0700 directory of its own, every ancestor checked (see createPrivateStagingRoot).
    const dir = createPrivateStagingRoot(root);
    fs.writeFileSync(path.join(dir, "SKILL.md"), String(doc.content ?? ""), { mode: 0o600 });
    const files = Array.isArray(doc.files) ? (doc.files as Array<{ path?: unknown }>) : [];
    for (const f of files.slice(0, MAX_FILES)) {
      const rel = typeof f?.path === "string" ? f.path : "";
      if (!rel || rel === "SKILL.md" || !isSafeRelativePath(rel)) continue;
      const file = await readFromApi(request, skill.name, u.contentSha, rel);
      const target = path.join(dir, ...rel.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const content = String(file.content ?? "");
      fs.writeFileSync(target, file.is_binary === true ? Buffer.from(content, "base64") : content, { mode: 0o600 });
    }
    metrics.onUserSkillStaged("fetched");
    return dir;
  } catch (err) {
    const outcome = err instanceof UserSkillUnavailable ? err.outcome : "failed";
    metrics.onUserSkillStaged(outcome);
    // The name and the outcome only: never what the skill says.
    logger.warn({ sessionId: request.session_id, name: skill.name, outcome }, "user_skill.stage_failed");
    throw err instanceof UserSkillUnavailable ? err : new UserSkillUnavailable("it could not be read just now; try again", "failed");
  }
}

async function readFromApi(
  request: ExecuteRequest, name: string, contentSha: string, file?: string,
): Promise<Record<string, unknown>> {
  const base = apiBase();
  if (!base || !request.message_id) throw new UserSkillUnavailable("personal skills cannot be read from this run", "failed");
  let resp: Response;
  try {
    resp = await fetch(`${base}/v1/internal/skills/read`, {
      method: "POST",
      headers: claimHeaders(),
      body: JSON.stringify({
        session_id: request.session_id, message_id: request.message_id, name, content_sha: contentSha,
        ...(file !== undefined ? { path: file } : {}),
      }),
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch {
    throw new UserSkillUnavailable("the skill service could not be reached; try again", "failed");
  }
  const body = await resp.json().catch(() => null) as Record<string, unknown> | null;
  if (resp.ok && body?.ok === true) return body;
  const error = typeof body?.error === "string" ? body.error : "";
  if (resp.status === 409 && error === "changed") {
    throw new UserSkillUnavailable("the user changed it after this message was sent; its new version is used from their next message", "changed");
  }
  if (resp.status === 404) throw new UserSkillUnavailable("it no longer exists or is turned off", "not_found");
  throw new UserSkillUnavailable("personal skills are not available in this conversation", "failed");
}
