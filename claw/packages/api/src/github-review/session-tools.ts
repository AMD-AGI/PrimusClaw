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
import pino from "pino";
import { CLAW_GITHUB_REVIEW_ENABLED } from "../config.js";
import { db } from "../infra/db.js";
import { actingUserOf } from "./acting-as.js";
import { storedActingAs } from "./acting-turns.js";
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
 * one whose work is started with its keys in the sandbox. Asks the database nothing while the feature is off.
 */
export async function sessionWithholdsSandboxKeys(sessionId: string): Promise<boolean> {
  if (!CLAW_GITHUB_REVIEW_ENABLED) return false;
  return withholdsSandboxKeys({ acting_as: await storedActingAs(sessionId) });
}

/** Marks a turn that is built here for a session that acts as a user (`withhold_sandbox_keys`, protocol). */
export async function applySandboxKeyPolicyToTask(task: Record<string, unknown>, sessionId: string): Promise<void> {
  if (await sessionWithholdsSandboxKeys(sessionId)) task.withhold_sandbox_keys = true;
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
