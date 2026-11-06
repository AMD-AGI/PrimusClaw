// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * GitHub as an MCP server hosted by the API, for every session whose owner keeps a GitHub token in their
 * env vault (`GH_TOKEN`, the same token the sandbox's `gh` and `git` use), and, with
 * `CLAW_GITHUB_MCP_BINDING_ENABLED` on, for an owner who keeps none but bound a GitHub account at the identity provider
 * (`/github bind` in Teams, the binding GitHub review uses). The vault comes first: a `GH_TOKEN` is the owner's own choice.
 *
 *  - At dispatch (`githubMcpServers`), a turn of such a session is given a `github` server entry: a signed
 *    token that names the session and its owner, and the policy `requires_approval: true` with the read
 *    tools in `auto_approve`, so every write waits for the user and a tool added later is held until it is
 *    listed. The entry carries no GitHub credential and is built here, never from a request: the server
 *    name is reserved and replaces whatever a request names `github`.
 *  - On every call (`POST /v1/internal/github/mcp`), the token is checked, the session row is read again
 *    (still there, same owner, not acting as somebody else), and the owner's token is read from the vault, or their
 *    binding from the identity provider, for that one request. Whose token is used comes from the signed session, never
 *    from a tool argument. A binding is never kept here: it is asked for again on every request, as GitHub review asks.
 *  - A call made with a binding is written to GitHub review's audit log (`claw_github_audit`) before it runs and finished
 *    after; one that cannot be written down is not made. Writes still wait for the user, whichever token it is.
 *  - `GET /v1/github/connection` tells the signed-in user which of the two their GitHub tools would use, if either, so a
 *    channel can offer to connect GitHub before a question that needs it is answered without.
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
import {
  IdentityCredentialRefusedError, IdentityUnavailableError, type ResolveCredentialRequest, type ResolvedCredential,
} from "@claw/utils";
import { identityClient } from "../auth/identity.js";
import { getUser } from "../auth/middleware.js";
import { decryptUserEnvValue } from "../crypto/user-env.js";
import { db as defaultDb } from "../infra/db.js";
import { actingUserOf } from "../github-review/acting-as.js";
import { GithubClient } from "../github-review/github.js";
import { summarise } from "../github-review/service.js";
import { GITHUB_PROVIDER, MIN_MCP_SECRET_LENGTH } from "../github-review/settings.js";
import { GITHUB_MCP_AUDIT_TOOL_PREFIX, auditFinish, auditStart, type Queryable } from "../github-review/store.js";
import { mintSessionToolToken, verifySessionToolToken } from "../github-review/token.js";
import {
  GITHUB_MCP_PATH, GITHUB_MCP_TOKEN_TTL_SECONDS, GITHUB_TOKEN_ENV_NAME, readGithubMcpSettings, type GithubMcpSettings,
} from "./settings.js";
import { buildGithubToolServer, githubWebHost, READ_TOOLS, type GithubToolCallHook } from "./tools.js";

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

/** Where the token of a call comes from: the owner's env vault, or the GitHub account they bound at the identity provider. */
export type GithubTokenSource = "env" | "binding";
/** Why there is none: no `GH_TOKEN` and the binding is off or absent (`none`), or the binding has run out (`expired`). */
export type GithubTokenMissing = "none" | "expired";
export type GithubCredential =
  | { token: string; source: GithubTokenSource; login: string }
  | { token: null; missing: GithubTokenMissing };

/** How a binding is read: the identity provider's resolve call (`IdentityClient.resolveExternalCredential`). */
export type ResolveBinding = (req: ResolveCredentialRequest) => Promise<ResolvedCredential>;

const defaultResolveBinding: ResolveBinding = (req) => {
  const client = identityClient();
  if (!client) throw new IdentityUnavailableError("credential", "not_configured");
  return client.resolveExternalCredential(req);
};

/**
 * The owner's GitHub token for one use, in two levels: `GH_TOKEN` from their env vault; else, with `binding` on, the GitHub account
 * they bound at the identity provider, for themselves (`requesterUserId` is the owner) and named by `purpose` in its audit trail. A
 * binding the provider says has run out, or whose `expiresAt` has passed, is `expired`. Throws when the identity provider cannot be
 * asked or answers something that is not about this user: that is unknown, never "not bound".
 */
export async function resolveGithubToken(
  q: Queryable, userId: string, opts: { binding: boolean; purpose: string; resolve?: ResolveBinding; now?: () => number },
): Promise<GithubCredential> {
  const kept = await loadGithubToken(q, userId);
  if (kept) return { token: kept, source: "env", login: "" };
  if (!opts.binding) return { token: null, missing: "none" };
  let cred: ResolvedCredential;
  try {
    cred = await (opts.resolve ?? defaultResolveBinding)({ userId, provider: GITHUB_PROVIDER, requesterUserId: userId, purpose: opts.purpose });
  } catch (err) {
    if (err instanceof IdentityCredentialRefusedError && err.code === "not_bound") return { token: null, missing: "none" };
    if (err instanceof IdentityCredentialRefusedError && err.code === "expired") return { token: null, missing: "expired" };
    throw err;
  }
  if (cred.expiresAt !== null && cred.expiresAt <= (opts.now ?? Date.now)()) return { token: null, missing: "expired" };
  return { token: cred.token, source: "binding", login: cred.providerLogin };
}

const PURPOSE_PREFIX = "github_mcp";

/** What a call is, for the identity provider's audit trail: `github_mcp:<tool>` for a tool call, `github_mcp` for the rest of the protocol. */
function purposeOf(body: unknown): string {
  const m = body && typeof body === "object" && !Array.isArray(body) ? body as { method?: unknown; params?: { name?: unknown } } : {};
  const name = m.method === "tools/call" ? m.params?.name : undefined;
  return typeof name === "string" && /^[a-z_]{1,64}$/.test(name) ? `${PURPOSE_PREFIX}:${name}` : PURPOSE_PREFIX;
}

/**
 * Each call made with a binding, written to GitHub review's audit log before it runs and finished after (as the review tools write
 * theirs): who, which session, which tool, its arguments summarised (never a body's text), what GitHub was asked and how it ended.
 * A call whose row cannot be written is not made. Its tool name (`github_mcp.<tool>`) keeps it out of every count of reviews and of a
 * review session's request budget (`REVIEW_ROWS_ONLY`).
 */
function bindingAudit(q: Queryable, claims: { sessionId: string; requesterUserId: string; actorUserId: string }, gh: GithubClient): GithubToolCallHook {
  return async (tool, args) => {
    let id: number;
    try {
      id = await auditStart(q, { requesterUserId: claims.requesterUserId, actorUserId: claims.actorUserId, sessionId: claims.sessionId, tool: `${GITHUB_MCP_AUDIT_TOOL_PREFIX}${tool}`, args: summarise(args) });
    } catch (err) {
      logger.error({ tool, code: (err as { code?: string })?.code ?? "" }, "github_mcp.audit_unavailable");
      return null;
    }
    return async (result) => {
      try {
        await auditFinish(q, id, {
          repo: typeof args.repo === "string" ? args.repo.slice(0, 200) : undefined,
          pr: typeof args.number === "number" && Number.isInteger(args.number) ? args.number : undefined,
          githubRequests: gh.requests, githubRequestIds: gh.requestIds, githubStatus: gh.lastStatus || undefined,
          dryRun: false, write: !(READ_TOOLS as readonly string[]).includes(tool),
          result: result.isError ? "refused" : "ok", detail: result.isError ? result.text : "",
        });
      } catch {
        // The row was written before the call; one that is not finished stays 'started', which reads as unfinished.
      }
    };
  };
}

async function sessionRow(q: Queryable, sessionId: string): Promise<{ user_id: string | null; config: Record<string, unknown> | null } | undefined> {
  return (await q.query(
    "SELECT user_id, config FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL", [sessionId],
  )).rows[0] as { user_id: string | null; config: Record<string, unknown> | null } | undefined;
}

export interface GithubMcpDeps {
  settings?: () => GithubMcpSettings;
  db?: Queryable;
  /** How a binding is read; the process's identity client by default. */
  resolveBinding?: ResolveBinding;
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
    // No GH_TOKEN: the binding, when it is on, asked for now (and not kept) only to know whether there is one that works.
    if (!kept && !(s.binding && (await resolveGithubToken(q, row.user_id, { binding: true, purpose: `${PURPOSE_PREFIX}:offer`, resolve: deps.resolveBinding })).token !== null)) {
      return {};
    }
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
  fetchImpl?: typeof fetch;
}

export async function registerGithubMcpRoutes(app: FastifyInstance, opts: GithubMcpRouteOptions = {}): Promise<void> {
  const settings = opts.settings ?? (() => readGithubMcpSettings());
  if (!(opts.enabled ?? settings().enabled)) return;
  const q = opts.db ?? defaultDb;

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
    let cred: GithubCredential;
    try {
      // The token proves what was true when it was minted; the session says what is true now.
      const row = await sessionRow(q, claims.sessionId);
      if (!row || row.user_id !== claims.requesterUserId || claims.actorUserId !== claims.requesterUserId || actingUserOf(row.config) !== null) {
        return refuse(reply, 403, "session_mismatch");
      }
      cred = await resolveGithubToken(q, claims.requesterUserId, { binding: s.binding, purpose: purposeOf(req.body), resolve: opts.resolveBinding });
    } catch (err) {
      logger.error({ code: (err as { code?: string })?.code ?? "", errorClass: (err as Error)?.constructor?.name }, "github_mcp.session_read_failed");
      return refuse(reply, 503, "unavailable");
    }
    if (cred.token === null) return refuse(reply, 403, cred.missing === "expired" ? "github_binding_expired" : "no_github_token");
    const gh = new GithubClient({ token: cred.token, apiUrl: s.apiUrl, fetchImpl: opts.fetchImpl });
    const mcp = buildGithubToolServer({
      gh, fetchImpl: opts.fetchImpl, webHost: githubWebHost(s.apiUrl), onCall: cred.source === "binding" ? bindingAudit(q, claims, gh) : undefined,
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

  // The signed-in user's own answer (there is no user in the path): which token their GitHub tools would use now, if any, and
  // whether a binding counts here at all. A channel reads it to offer `/github bind` before a question that needs GitHub; it never
  // carries a credential.
  app.get("/v1/github/connection", async (req, reply) => {
    const user = getUser(req);
    if (!user) return refuse(reply, 401, "authentication required");
    const s = settings();
    let cred: GithubCredential;
    try {
      cred = await resolveGithubToken(q, user.userId, { binding: s.binding, purpose: `${PURPOSE_PREFIX}:connection`, resolve: opts.resolveBinding });
    } catch (err) {
      logger.warn({ errorClass: (err as Error)?.constructor?.name }, "github_mcp.connection_unknown");
      return refuse(reply, 503, "unavailable");
    }
    const data = cred.token === null
      ? { reads_with: null, login: "", missing: cred.missing, binding_reads: s.binding }
      : { reads_with: cred.source, login: cred.login, missing: null, binding_reads: s.binding };
    return { ok: true, data };
  });

  logger.info("github_mcp.routes_registered");
}
