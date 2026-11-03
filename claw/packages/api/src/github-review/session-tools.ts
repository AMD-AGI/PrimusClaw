// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The review tools as a turn's `mcp_servers` entry.
 *
 * Built at dispatch from the session row, for a session that has
 * `config.acting_as` while the feature is on, and for no other. The entry holds a
 * signed token that names the session and its two users; it holds no GitHub
 * credential, which is fetched by the tools themselves, per call. The server name
 * is reserved: whatever a request names `github_review` is replaced.
 */
import type { ReasoningEffort } from "@claw/protocol";
import pino from "pino";
import { CLAW_GITHUB_REVIEW_ENABLED } from "../config.js";
import { loadUserEnvSnapshot } from "../crypto/user-env.js";
import { db } from "../infra/db.js";
import { actingUserOf } from "./acting-as.js";
import { storedActingAs } from "./acting-turns.js";
import { reviewTargetOf } from "./review-target.js";
import { readGithubReviewSettings } from "./settings.js";
import { mintSessionToolToken } from "./token.js";

const logger = pino({ name: "github-review-session" });

export const GITHUB_REVIEW_SERVER_NAME = "github_review";

type McpServers = Record<string, Record<string, unknown>>;

/**
 * Whether the sandbox of a session with this stored config must hold none of its owner's keys. The session is offered the review tools, so
 * its model reads what strangers wrote, and a sandbox's environment is whatever that model can print: the owner's key there would be
 * the owner's account (the platform's sign-in takes a key for a password change). Brain still uses the keys itself, for the model and for
 * SaFE. The same reading of `acting_as` as the tools and the turn gate, and nothing while the feature is off: such a session is then
 * an ordinary one.
 */
export function withholdsSandboxKeys(config: unknown): boolean {
  return CLAW_GITHUB_REVIEW_ENABLED && actingUserOf(config) !== null;
}

/**
 * `withholdsSandboxKeys` for a session that is read from its row now, as the tools are. Not caught: a session that cannot be read is not
 * one whose work is started with its keys in the sandbox. Asks the database nothing while the feature is off. `q` is the connection the
 * caller is on, for one that holds the session's row lock in a transaction and must not borrow a second connection.
 */
export async function sessionWithholdsSandboxKeys(sessionId: string, q: Parameters<typeof storedActingAs>[1] = db): Promise<boolean> {
  if (!CLAW_GITHUB_REVIEW_ENABLED) return false;
  return withholdsSandboxKeys({ acting_as: await storedActingAs(sessionId, q) });
}

/**
 * Whether the requester's long-term memory stays out of this session: their entries and profile are not put in the prompt, `save_memory`
 * is not offered (Brain, on the same mark), and nothing is saved or extracted from the session's conversation. The same sessions that
 * withhold their sandbox's keys, for the same reason: the model of such a session reads what strangers wrote, so memory going in would be
 * quoted into a review comment, and memory going out would be what a stranger's text makes every later session of the requester believe.
 * A session that cannot be read counts as one that withholds: memory is simply not used for it, where `sessionWithholdsSandboxKeys`
 * refuses the work, because a failed read here must not end a turn or a completion.
 */
export async function sessionWithholdsMemory(sessionId: string, q: Parameters<typeof storedActingAs>[1] = db): Promise<boolean> {
  try {
    return await sessionWithholdsSandboxKeys(sessionId, q);
  } catch (err) {
    logger.error({ sessionId, code: (err as { code?: string })?.code ?? "" }, "github_review.memory_gate_unreadable_memory_not_used");
    return true;
  }
}

/**
 * The owner's stored variables (the env vault: personal tokens for GitHub, Hugging Face, W&B and the like) for a turn in this session, or
 * none for a session that withholds its sandbox's keys. The vault is the other half of what a sandbox's environment holds of its owner:
 * the model of such a session reads what strangers wrote and can print whatever the environment holds, so these are not sent either. Not
 * read here, so not frozen on a queued message and not put on a request. What the callers that read it before the session exists, or
 * carry what was read earlier, do about it is listed in `test/github-review-acting-user-env.test.ts` (E9); Brain ignores `user_env`
 * under the mark as well.
 */
export async function loadUserEnvForSession(
  q: Parameters<typeof loadUserEnvSnapshot>[0] & Parameters<typeof storedActingAs>[1],
  userId: string,
  sessionId: string,
  log?: Parameters<typeof loadUserEnvSnapshot>[2],
): Promise<Record<string, string>> {
  if (await sessionWithholdsSandboxKeys(sessionId, q)) return {};
  return await loadUserEnvSnapshot(q, userId, log);
}

/** The reasoning effort a turn of a session that acts as a user runs at (`CLAW_GITHUB_REVIEW_EFFORT`), as fields of its request. */
export function actingSessionEffort(): { effort?: ReasoningEffort } {
  const effort = readGithubReviewSettings().reviewEffort;
  return effort ? { effort } : {};
}

/**
 * Marks a turn that is built here for a session that acts as a user (`withhold_sandbox_keys`, protocol), and takes the owner's stored
 * variables off it: whichever way they reached the task (a queued message that was frozen with them before the mark applied), a session
 * that withholds its sandbox's keys is sent none. The same turn is run at the review's reasoning effort: it is a review.
 */
export async function applySandboxKeyPolicyToTask(task: Record<string, unknown>, sessionId: string): Promise<void> {
  if (!(await sessionWithholdsSandboxKeys(sessionId))) return;
  task.withhold_sandbox_keys = true;
  delete task.user_env;
  Object.assign(task, actingSessionEffort());
}

export async function githubReviewMcpServers(sessionId: string): Promise<McpServers> {
  if (!CLAW_GITHUB_REVIEW_ENABLED) return {};
  const settings = readGithubReviewSettings();
  try {
    const rows = (await db.query(
      "SELECT user_id, config FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
      [sessionId],
    )).rows as Array<{ user_id: string | null; config: Record<string, unknown> | null }>;
    const row = rows[0];
    if (!row?.user_id) return {};
    const actingUser = actingUserOf(row.config);
    if (actingUser === null) return {};
    // A bound pull request that cannot be read is not an unbound session: the tools are not offered rather than offered without the binding.
    if (!reviewTargetOf(row.config).ok) {
      logger.error({ sessionId }, "github_review.review_target_unreadable_tools_not_offered");
      return {};
    }
    if (!settings.mcpSecret) {
      logger.error({ sessionId }, "github_review.no_secret_tools_not_offered");
      return {};
    }
    const token = mintSessionToolToken(
      { sessionId, requesterUserId: row.user_id, actorUserId: actingUser }, settings.mcpSecret, settings.tokenTtlSeconds,
    );
    return { [GITHUB_REVIEW_SERVER_NAME]: { type: "http", url: settings.mcpUrl, token } };
  } catch (err) {
    // A turn does not depend on them: the model is simply not offered the tools.
    logger.error({ sessionId, code: (err as { code?: string })?.code ?? "" }, "github_review.read_failed");
    return {};
  }
}
