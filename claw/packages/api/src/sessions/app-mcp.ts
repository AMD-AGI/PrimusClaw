// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The session's hosted-application MCP, as a turn's `mcp_servers` carries it
 * (hosting design 5.8, items 3 and 4).
 *
 * The config is built here, at dispatch, from the record in
 * `claw_session_app_mcp` and the run's sealed MCP token; the record has no
 * credential. `token` is what Brain sends as `Authorization: Bearer`:
 *
 *  - Router auth on: the `<SAFE_API_KEY>` placeholder, which Brain expands to the
 *    session owner's platform key, the identity it already has through the Router.
 *  - Router auth off: the MCP token.
 *
 * The Router strips `Authorization` before forwarding, so the application is
 * always checked on the header its manifest names (`mcp.token_header`), which
 * carries the MCP token in both cases.
 */
import pino from "pino";
import { APP_RUNS_ENABLED, SANDBOX_ROUTER_AUTH_ENABLED } from "../config.js";
import { db } from "../infra/db.js";
import { openAppRunSecret } from "../crypto/app-run-secrets.js";
import { githubReviewMcpServers } from "../github-review/session-tools.js";

const logger = pino({ name: "session-app-mcp" });

/** Read at dispatch, so a test can flip it; the environment sets it at boot. */
export const appMcpSettings = { routerAuth: SANDBOX_ROUTER_AUTH_ENABLED };

export const SAFE_API_KEY_PLACEHOLDER = "<SAFE_API_KEY>";

type McpServers = Record<string, Record<string, unknown>>;

export interface AppMcpRow {
  name: string;
  url: string;
  sandbox_session_id: string;
  app_task_id: string;
  mcp_token_enc: string;
  token_header: string | null;
}

/** One server's config. Pure: the caller has opened the token. */
export function appMcpServerConfig(
  row: Pick<AppMcpRow, "url" | "sandbox_session_id" | "token_header">,
  mcpToken: string,
  routerAuth: boolean,
): Record<string, unknown> {
  return {
    type: "http",
    url: row.url,
    token: routerAuth ? SAFE_API_KEY_PLACEHOLDER : mcpToken,
    headers: { [row.token_header as string]: mcpToken, "x-session-id": row.sandbox_session_id },
  };
}

/** The application's servers at the lowest priority: whatever the request names wins on a clash. */
export function mergeAppMcpServers(
  appServers: McpServers, requested: McpServers | undefined,
): McpServers | undefined {
  if (Object.keys(appServers).length === 0) return requested;
  return { ...appServers, ...(requested ?? {}) };
}

/** The session's live application MCP servers. Never throws: a turn does not depend on them. */
export async function sessionAppMcpServers(
  sessionId: string,
  routerAuth: boolean = appMcpSettings.routerAuth,
): Promise<McpServers> {
  if (!APP_RUNS_ENABLED) return {};
  let rows: AppMcpRow[];
  try {
    // A record of an ended run is not served even if its removal has not landed.
    rows = (await db.query(
      `SELECT m.name, m.url, m.sandbox_session_id, m.app_task_id, r.mcp_token_enc,
              r.manifest->'mcp'->>'token_header' AS token_header
         FROM claw_session_app_mcp m JOIN claw_app_runs r ON r.task_id = m.app_task_id
        WHERE m.session_id = $1 AND r.state <> 'ended'`,
      [sessionId],
    )).rows as AppMcpRow[];
  } catch (err) {
    logger.error({ sessionId, code: (err as { code?: string })?.code ?? "" }, "session_app_mcp.read_failed");
    return {};
  }
  const out: McpServers = {};
  for (const row of rows) {
    if (!row.token_header) continue;
    try {
      const token = openAppRunSecret(row.mcp_token_enc, row.app_task_id, "mcp_token");
      out[row.name] = appMcpServerConfig(row, token, routerAuth);
    } catch (err) {
      // Not the error's text: a failed open must not name a value.
      logger.error({ sessionId, taskId: row.app_task_id, errorClass: (err as Error)?.constructor?.name }, "session_app_mcp.token_open_failed");
    }
  }
  return out;
}

/**
 * Put the session's live application servers into a turn that is built here, on
 * the wire (the fat branch). A turn that is parked and claimed later is resolved
 * when it is claimed instead (`tasks/run-claim.ts`), so that nothing sealed on the
 * row holds the MCP token and a stale record is never offered.
 *
 * The GitHub review tools (see `github-review/session-tools.ts`) ride the same
 * path for the same reason, a session that has `config.acting_as` only, under a
 * reserved server name that a request cannot replace.
 */
export async function applyAppMcpToTask(task: Record<string, unknown>, sessionId: string): Promise<void> {
  const merged = mergeAppMcpServers(
    await sessionAppMcpServers(sessionId),
    task.mcp_servers as McpServers | undefined,
  );
  if (merged !== undefined) task.mcp_servers = merged;
  const review = await githubReviewMcpServers(sessionId);
  if (Object.keys(review).length > 0) {
    task.mcp_servers = { ...((task.mcp_servers as McpServers | undefined) ?? {}), ...review };
  }
}
