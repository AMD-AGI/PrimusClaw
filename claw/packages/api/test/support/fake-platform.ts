// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A fake SaFE that is two things at once, as the real one is: the verifier the
 * auth middleware asks "who is this credential?", and the API a route then calls
 * as that caller. Both are answered from one table, so a test cannot get a route
 * and the middleware to disagree about who a credential belongs to.
 *
 * Credentials: the cookie `Token=tok-<name>` or the key `ak-<name>`, for each
 * name in `accounts`. Anything else is a 401, which is what SaFE says.
 */
import type http from "node:http";
import { sendJson, startFakeUpstream, type FakeUpstream, type SeenRequest } from "./fake-upstream.js";

export interface Account {
  id: string;
  name?: string;
  /** Reported by verification only when set, as SaFE does (`omitempty`). */
  email?: string;
  roles?: string[];
  virtualKey?: string;
  platformKey?: string;
  /** `/api/v1/workspaces` for this caller. */
  workspaces?: unknown;
  /** `/api/v1/clusters` for this caller. */
  clusters?: unknown;
  /** `/api/v1/users/self` for this caller. */
  self?: unknown;
}

export const AUTH_INTERNAL_TOKEN = "internal-token-for-tests";

/** Which account a request presented, from its cookie or `Authorization` header. */
export function accountOf(accounts: Record<string, Account>, headers: http.IncomingHttpHeaders): Account | null {
  const cookie = String(headers.cookie ?? "");
  const fromCookie = /(?:^|;\s*)Token=tok-([A-Za-z0-9_-]+)/.exec(cookie)?.[1];
  const bearer = /^Bearer ak-([A-Za-z0-9_-]+)$/.exec(String(headers.authorization ?? ""))?.[1];
  const name = fromCookie ?? bearer;
  return name !== undefined ? (accounts[name] ?? null) : null;
}

export type DataRoute = (account: Account, req: SeenRequest, res: http.ServerResponse, raw: http.IncomingMessage) => boolean | void;

export async function startFakePlatform(
  accounts: Record<string, Account>,
  /** Overrides for the data endpoints; return true once the response was written. */
  override: DataRoute = () => false,
): Promise<FakeUpstream> {
  return startFakeUpstream((req, res, raw) => {
    const path = req.url.split("?")[0];
    if (req.method === "POST" && path === "/api/v1/auth/verify") {
      if (req.headers["x-internal-token"] !== AUTH_INTERNAL_TOKEN) return sendJson(res, 403, { message: "forbidden" });
      const body = JSON.parse(req.body) as { cookie?: string; apiKey?: string };
      const probe = body.apiKey !== undefined
        ? { authorization: `Bearer ${body.apiKey}` }
        : { cookie: body.cookie ?? "" };
      const account = accountOf(accounts, probe);
      if (!account) return sendJson(res, 401, { message: "invalid credential" });
      return sendJson(res, 200, {
        id: account.id, name: account.name ?? "", ...(account.email !== undefined ? { email: account.email } : {}),
        roles: account.roles ?? ["default"],
        virtualKey: account.virtualKey ?? "", platformKey: account.platformKey ?? "",
      });
    }
    const account = accountOf(accounts, req.headers);
    if (!account) return sendJson(res, 401, { message: "unauthorized" });
    if (override(account, req, res, raw)) return;
    if (req.method === "GET" && path === "/api/v1/workspaces") return sendJson(res, 200, account.workspaces ?? { totalCount: 0, items: [] });
    if (req.method === "GET" && path === "/api/v1/clusters") return sendJson(res, 200, account.clusters ?? { totalCount: 0, items: [] });
    if (req.method === "GET" && path === "/api/v1/users/self") return sendJson(res, 200, account.self ?? { id: account.id, managedWorkspaces: [] });
    return sendJson(res, 404, { message: "no such route" });
  });
}
