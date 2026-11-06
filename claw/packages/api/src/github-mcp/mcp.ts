// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * GitHub as an MCP server hosted by the API, for every session whose owner keeps a GitHub token in their
 * env vault (`GH_TOKEN`, the same token the sandbox's `gh` and `git` use).
 *
 *  - At dispatch (`githubMcpServers`), a turn of such a session is given a `github` server entry: a signed
 *    token that names the session and its owner, and the policy `requires_approval: true` with the read
 *    tools in `auto_approve`, so every write waits for the user and a tool added later is held until it is
 *    listed. The entry carries no GitHub credential and is built here, never from a request: the server
 *    name is reserved and replaces whatever a request names `github`.
 *  - On every call (`POST /v1/internal/github/mcp`), the token is checked, the session row is read again
 *    (still there, same owner, not acting as somebody else), and the owner's token is read from the vault
 *    for that one request. Whose token is used comes from the signed session, never from a tool argument.
 *
 * A session that acts as another user (`config.acting_as`) gets nothing here: its model reads what
 * strangers wrote, and it is sent none of its owner's stored variables (github-review/session-tools.ts).
 *
 * Nothing is registered or offered unless `CLAW_GITHUB_MCP_ENABLED` is on.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import pino from "pino";
import { GITHUB_MCP_SERVER } from "@claw/protocol";
import { decryptUserEnvValue } from "../crypto/user-env.js";
import { db as defaultDb } from "../infra/db.js";
import { actingUserOf } from "../github-review/acting-as.js";
import { GithubClient } from "../github-review/github.js";
import { MIN_MCP_SECRET_LENGTH } from "../github-review/settings.js";
import type { Queryable } from "../github-review/store.js";
import { mintSessionToolToken, verifySessionToolToken } from "../github-review/token.js";
import {
  GITHUB_MCP_PATH, GITHUB_MCP_TOKEN_TTL_SECONDS, GITHUB_TOKEN_ENV_NAME, readGithubMcpSettings, type GithubMcpSettings,
} from "./settings.js";
import { buildGithubToolServer, githubWebHost, READ_TOOLS } from "./tools.js";

const logger = pino({ name: "github-mcp" });

export const GITHUB_MCP_SERVER_NAME = GITHUB_MCP_SERVER;
const PURPOSE = "claw-github-mcp" as const;

type McpServers = Record<string, Record<string, unknown>>;

/** The owner's GitHub token from their env vault, or null when they keep none. */
export async function loadGithubToken(q: Queryable, userId: string): Promise<string | null> {
  const row = (await q.query(
    "SELECT key_value_enc FROM claw_user_env_vars WHERE user_id = $1 AND key_name = $2", [userId, GITHUB_TOKEN_ENV_NAME],
  )).rows[0] as { key_value_enc?: string } | undefined;
  if (!row?.key_value_enc) return null;
  const token = decryptUserEnvValue(row.key_value_enc).trim();
  return token || null;
}

async function sessionRow(q: Queryable, sessionId: string): Promise<{ user_id: string | null; config: Record<string, unknown> | null } | undefined> {
  return (await q.query(
    "SELECT user_id, config FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL", [sessionId],
  )).rows[0] as { user_id: string | null; config: Record<string, unknown> | null } | undefined;
}

export interface GithubMcpDeps {
  settings?: () => GithubMcpSettings;
  db?: Queryable;
}

/** The turn's `github` server entry, or nothing. Never throws: a turn does not depend on it. */
export async function githubMcpServers(sessionId: string, deps: GithubMcpDeps = {}): Promise<McpServers> {
  const s = (deps.settings ?? (() => readGithubMcpSettings()))();
  if (!s.enabled) return {};
  if (s.secret.length < MIN_MCP_SECRET_LENGTH) {
    logger.error({ sessionId }, "github_mcp.no_secret_tools_not_offered");
    return {};
  }
  const q = deps.db ?? defaultDb;
  try {
    const row = await sessionRow(q, sessionId);
    if (!row?.user_id || actingUserOf(row.config) !== null) return {};
    const kept = (await q.query(
      "SELECT 1 FROM claw_user_env_vars WHERE user_id = $1 AND key_name = $2", [row.user_id, GITHUB_TOKEN_ENV_NAME],
    )).rows.length > 0;
    if (!kept) return {};
    const token = mintSessionToolToken(
      { sessionId, requesterUserId: row.user_id, actorUserId: row.user_id }, s.secret, GITHUB_MCP_TOKEN_TTL_SECONDS, Date.now(), PURPOSE,
    );
    return {
      [GITHUB_MCP_SERVER_NAME]: { type: "http", url: s.mcpUrl, token, requires_approval: true, auto_approve: [...READ_TOOLS] },
    };
  } catch (err) {
    logger.error({ sessionId, code: (err as { code?: string })?.code ?? "" }, "github_mcp.read_failed");
    return {};
  }
}

function refuse(reply: FastifyReply, status: number, error: string): FastifyReply {
  return reply.status(status).send({ ok: false, error });
}

export interface GithubMcpRouteOptions extends GithubMcpDeps {
  enabled?: boolean;
  loadToken?: (q: Queryable, userId: string) => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

export async function registerGithubMcpRoutes(app: FastifyInstance, opts: GithubMcpRouteOptions = {}): Promise<void> {
  const settings = opts.settings ?? (() => readGithubMcpSettings());
  if (!(opts.enabled ?? settings().enabled)) return;
  const q = opts.db ?? defaultDb;
  const loadToken = opts.loadToken ?? loadGithubToken;

  app.all(GITHUB_MCP_PATH, async (req, reply) => {
    const s = settings();
    const header = String(req.headers.authorization ?? "");
    const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const verdict = verifySessionToolToken(presented, s.secret, Date.now(), PURPOSE);
    if (!verdict.ok) {
      logger.warn({ reason: verdict.reason }, "github_mcp.token_rejected");
      return refuse(reply, 401, "invalid_token");
    }
    const { claims } = verdict;
    let token: string | null;
    try {
      // The token proves what was true when it was minted; the session says what is true now.
      const row = await sessionRow(q, claims.sessionId);
      if (!row || row.user_id !== claims.requesterUserId || claims.actorUserId !== claims.requesterUserId || actingUserOf(row.config) !== null) {
        return refuse(reply, 403, "session_mismatch");
      }
      token = await loadToken(q, claims.requesterUserId);
    } catch (err) {
      logger.error({ code: (err as { code?: string })?.code ?? "", errorClass: (err as Error)?.constructor?.name }, "github_mcp.session_read_failed");
      return refuse(reply, 503, "unavailable");
    }
    if (!token) return refuse(reply, 403, "no_github_token");
    const mcp = buildGithubToolServer({
      gh: new GithubClient({ token, apiUrl: s.apiUrl, fetchImpl: opts.fetchImpl }), fetchImpl: opts.fetchImpl, webHost: githubWebHost(s.apiUrl),
    });
    // Stateless, like the review tools: one server and transport per request.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined as unknown as () => string });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close().catch(() => undefined);
      void mcp.close().catch(() => undefined);
    });
    await mcp.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  logger.info("github_mcp.routes_registered");
}
