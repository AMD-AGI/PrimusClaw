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
import { parseActingAs } from "./acting-as.js";
import { readGithubReviewSettings } from "./settings.js";
import { mintSessionToolToken } from "./token.js";

const logger = pino({ name: "github-review-session" });

export const GITHUB_REVIEW_SERVER_NAME = "github_review";

type McpServers = Record<string, Record<string, unknown>>;

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
    const acting = parseActingAs(row.config?.acting_as);
    if (!acting.ok || acting.actingAs === null) return {};
    if (!settings.mcpSecret) {
      logger.error({ sessionId }, "github_review.no_secret_tools_not_offered");
      return {};
    }
    const token = mintSessionToolToken(
      { sessionId, requesterUserId: row.user_id, actorUserId: acting.actingAs }, settings.mcpSecret, settings.tokenTtlSeconds,
    );
    return { [GITHUB_REVIEW_SERVER_NAME]: { type: "http", url: settings.mcpUrl, token } };
  } catch (err) {
    // A turn does not depend on them: the model is simply not offered the tools.
    logger.error({ sessionId, code: (err as { code?: string })?.code ?? "" }, "github_review.read_failed");
    return {};
  }
}
