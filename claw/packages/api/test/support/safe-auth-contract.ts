// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The SaFE-mode authentication contract: what a caller becomes on the request (`getUser`) and what `GET /v1/me`
 * answers, for every credential SaFE verifies, against a fake SaFE that answers the way SaFE's apiserver does.
 *
 * The expected values are not written by hand and not derived from the code under test: they were recorded by running
 * this harness against the claw-v0.5.8 tree (CLAW_SAFE_CONTRACT_RECORD, see below) and are kept in
 * `fixtures/safe-auth-contract-v0.5.8.json`. A change that alters any field a SaFE-mode caller had in 0.5.8 fails here.
 *
 * The fake follows SaFE's `/api/v1/auth/verify` handler where Claw depends on it, including the part an
 * always-present email in a fake hides:
 *   - an `ak-` key and a default-type session cookie carry no email of their own; SaFE fills it in from the user record
 *     only when the request asks for the virtual key (`includeVirtualKey`), and only then looks up a virtual key;
 *   - an SSO session cookie carries the email of the SSO token;
 *   - an identity provider's access token (external mode) carries the identity's email, backfilled from the record;
 *   - the platform key is answered only when `includePlatformKey` is asked;
 *   - `preferredName` is backfilled from the record; `type`, `exp`, `noAccess` and `apiKeyId` are answered as SaFE does.
 * The data routes `/v1/me` reads answer with SaFE's views: `/api/v1/users/self` is the full `UserResponseItem`.
 */
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sendJson, startFakeUpstream, type FakeUpstream } from "./fake-upstream.js";

export const CONTRACT_INTERNAL_TOKEN = "internal-token-for-contract-tests";

/** A user record as SaFE's `/api/v1/users/self` shows it (apiserver view `UserResponseItem`), plus what the fake needs. */
interface FakeUser {
  /** The `UserResponseItem`, field for field. */
  self: Record<string, unknown> & { id: string; name: string; email: string; roles: string[]; type: string };
  /** The ak- keys of this user, with the id SaFE's key table gives each. */
  apiKeys: Record<string, number>;
  /** Session cookies (`Token=`) and the user type each was issued for. */
  cookies: Record<string, "default" | "sso">;
  /** Identity provider access tokens that SaFE's external mode resolves to this user. */
  accessTokens: string[];
  /** Email of the SSO token, for the user's SSO cookies. */
  ssoEmail?: string;
  platformKey: string;
  /** The LiteLLM virtual key SaFE finds by the user's email. */
  virtualKey: string;
}

const WORKSPACES = {
  totalCount: 3,
  items: [
    {
      workspaceId: "ws-train", workspaceName: "Train", clusterId: "c-main", flavorId: "f-mi300", userId: "u-admin",
      scopes: ["Train", "Infer"], isDefault: false, currentNodeCount: 4, phase: "Running", gpuProduct: "MI300X",
      managers: [{ id: "u-admin", name: "admin" }], creationTime: "2026-08-01T00:00:00",
    },
    {
      workspaceId: "ws-sandbox", workspaceName: "Sandbox", clusterId: "c-main", flavorId: "f-mi300", userId: "u-admin",
      scopes: ["Sandbox"], isDefault: true, currentNodeCount: 2, phase: "Running", gpuProduct: "MI300X",
      managers: [{ id: "u-sso-1d2e", name: "sso.user" }], creationTime: "2026-08-02T00:00:00",
    },
    {
      workspaceId: "ws-cpu", workspaceName: "CPU", clusterId: "c-cpu", scopes: ["Sandbox"], isDefault: false,
      currentNodeCount: 1, phase: "Running", creationTime: "2026-08-03T00:00:00",
    },
  ],
};
const CLUSTERS = {
  totalCount: 2,
  items: [
    { clusterId: "c-main", phase: "Ready", isProtected: true, userId: "u-admin", creationTime: "2026-07-01T00:00:00" },
    { clusterId: "c-cpu", phase: "Creating", isProtected: false, userId: "u-admin", creationTime: "2026-07-02T00:00:00" },
  ],
};

const USERS: FakeUser[] = [
  {
    // An ordinary user with an email on the record: what an ak- key or a default cookie reaches.
    self: {
      id: "u-3c9e1f0a", name: "eval-bot", email: "eval-bot@example.invalid", preferredName: "Eval Bot", type: "default",
      roles: ["default"], workspaces: [{ id: "ws-train", name: "Train" }, { id: "ws-sandbox", name: "Sandbox" }],
      managedWorkspaces: [], creationTime: "2026-09-01T08:00:00", restrictedType: 0,
      avatarUrl: "https://avatars.example.invalid/eval-bot.png",
    },
    apiKeys: { "ak-evalbot": 41, "ak-evalbot-download": 44 },
    cookies: { "tok-evalbot": "default" },
    accessTokens: ["idt-evalbot"],
    platformKey: "ak-platform-evalbot",
    virtualKey: "vk-virtual-evalbot",
  },
  {
    // An SSO user, admin of the platform and of a workspace.
    self: {
      id: "u-sso-1d2e", name: "sso.user", email: "sso.user@example.invalid", preferredName: "SSO User", type: "sso",
      roles: ["default", "system-admin"],
      workspaces: [{ id: "ws-sandbox", name: "Sandbox" }, { id: "ws-cpu", name: "CPU" }],
      managedWorkspaces: [{ id: "ws-sandbox", name: "Sandbox" }], creationTime: "2026-09-02T08:00:00", restrictedType: 0,
    },
    apiKeys: { "ak-ssouser": 42 },
    cookies: { "sso-ssouser": "sso" },
    accessTokens: [],
    ssoEmail: "sso.user@example.invalid",
    platformKey: "ak-platform-ssouser",
    virtualKey: "vk-virtual-ssouser",
  },
  {
    // A frozen account with no email and no roles: nothing may be invented for it.
    self: {
      id: "u-noemail-77", name: "no-email", email: "", type: "default", roles: [], workspaces: [], managedWorkspaces: null,
      creationTime: "2026-09-03T08:00:00", restrictedType: 1,
    },
    apiKeys: { "ak-noemail": 43 },
    cookies: { "tok-noemail": "default" },
    accessTokens: [],
    platformKey: "ak-platform-noemail",
    virtualKey: "vk-virtual-noemail",
  },
];

type VerifyRequest = {
  cookie?: string; authorization?: string; apiKey?: string; userType?: string;
  includePlatformKey?: boolean; includeVirtualKey?: boolean;
};

/** SaFE's verify answer for `req`, or the status it refuses with. */
function verifyAnswer(req: VerifyRequest): { status: number; body: unknown } {
  let user: FakeUser | undefined;
  let type = "";
  let email = "";
  let apiKeyId = 0;
  let exp = 0;
  if (req.cookie) {
    const token = /(?:^|;\s*)Token=([^;]+)/.exec(req.cookie)?.[1] ?? "";
    user = USERS.find((u) => token in u.cookies);
    if (!user) return { status: 401, body: { code: 401, message: "invalid token" } };
    type = /(?:^|;\s*)userType=([^;]+)/.exec(req.cookie)?.[1] ?? "default";
    if (type !== user.cookies[token]) return { status: 401, body: { code: 401, message: "invalid token" } };
    exp = 1800000000;
    // A default token carries id, expiry and name; an SSO token carries the identity's email too.
    if (type === "sso") email = user.ssoEmail ?? "";
  } else {
    const bearer = /^Bearer (\S+)$/.exec(req.authorization ?? "")?.[1];
    const key = req.apiKey ?? (bearer?.startsWith("ak-") ? bearer : undefined);
    if (key !== undefined) {
      user = USERS.find((u) => key in u.apiKeys);
      if (!user) return { status: 401, body: { code: 401, message: "invalid api key" } };
      type = "apikey";
      apiKeyId = user.apiKeys[key];
    } else if (bearer !== undefined) {
      // External mode: the identity's email, backfilled from the record when the identity has none.
      user = USERS.find((u) => u.accessTokens.includes(bearer));
      if (!user) return { status: 401, body: { code: 401, message: "invalid token" } };
      type = user.self.type;
      exp = 1800000300;
      email = user.self.email;
    } else {
      return { status: 400, body: { code: 400, message: "cookie, apiKey, or authorization is required" } };
    }
  }
  const resp: Record<string, unknown> = {
    id: user.self.id,
    name: user.self.name,
    ...(email ? { email } : {}),
    ...(user.self.preferredName ? { preferredName: user.self.preferredName } : {}),
    exp,
    type,
    roles: user.self.roles,
    noAccess: user.self.restrictedType === 1,
    ...(apiKeyId ? { apiKeyId } : {}),
  };
  if (req.includePlatformKey) resp.platformKey = user.platformKey;
  if (req.includeVirtualKey) {
    // SaFE: "If email is missing (e.g., API key auth), try to fetch from User CR", then the virtual key by email.
    if (!resp.email && user.self.email) resp.email = user.self.email;
    if (resp.email) resp.virtualKey = user.virtualKey;
  }
  return { status: 200, body: { code: 0, data: resp } };
}

/** The user a data-route request presents (`Cookie: Token=` or `Authorization: Bearer ak-`), as SaFE's middleware finds it. */
function presenter(headers: Record<string, unknown>): FakeUser | undefined {
  const token = /(?:^|;\s*)Token=([^;]+)/.exec(String(headers.cookie ?? ""))?.[1];
  if (token !== undefined) return USERS.find((u) => token in u.cookies);
  const key = /^Bearer (ak-\S+)$/.exec(String(headers.authorization ?? ""))?.[1];
  return key === undefined ? undefined : USERS.find((u) => key in u.apiKeys || u.platformKey === key);
}

export async function startContractSafe(): Promise<FakeUpstream> {
  return startFakeUpstream((req, res) => {
    const path = req.url.split("?")[0];
    if (req.method === "POST" && path === "/api/v1/auth/verify") {
      if (req.headers["x-internal-token"] !== CONTRACT_INTERNAL_TOKEN) return sendJson(res, 403, { code: 403, message: "forbidden" });
      const answer = verifyAnswer(JSON.parse(req.body) as VerifyRequest);
      return sendJson(res, answer.status, answer.body);
    }
    const user = presenter(req.headers);
    if (!user) return sendJson(res, 401, { code: 401, message: "unauthorized" });
    if (req.method === "GET" && path === "/api/v1/users/self") return sendJson(res, 200, user.self);
    const visible = new Set(((user.self.workspaces as { id: string }[] | null) ?? []).map((w) => w.id));
    if (req.method === "GET" && path === "/api/v1/workspaces") {
      const items = WORKSPACES.items.filter((w) => visible.has(w.workspaceId));
      return sendJson(res, 200, { totalCount: items.length, items });
    }
    if (req.method === "GET" && path === "/api/v1/clusters") return sendJson(res, 200, CLUSTERS);
    return sendJson(res, 404, { code: 404, message: "no such route" });
  });
}

/** One credential presented the way a client presents it. */
export interface ContractCase {
  name: string;
  headers: Record<string, string>;
  /** Present for the download-URL key, which only a file-download route takes. */
  query?: string;
}

export const CONTRACT_CASES: readonly ContractCase[] = [
  { name: "bearer ak- key, user with email", headers: { authorization: "Bearer ak-evalbot" } },
  { name: "x-api-key ak- key, user with email", headers: { "x-api-key": "ak-ssouser" } },
  { name: "download-URL ak- key, user with email", headers: {}, query: "token=ak-evalbot-download" },
  { name: "default session cookie, user with email", headers: { cookie: "Token=tok-evalbot; userType=default" } },
  { name: "sso session cookie", headers: { cookie: "Token=sso-ssouser; userType=sso" } },
  { name: "bearer ak- key, user without email", headers: { authorization: "Bearer ak-noemail" } },
  { name: "default session cookie, user without email", headers: { cookie: "Token=tok-noemail; userType=default" } },
];

/** What one case produced: the verify requests Claw sent, the request user, and the `/v1/me` answer. */
export interface ContractOutcome {
  verifyRequests: unknown[];
  user: { status: number; body: unknown };
  me: { status: number; body: unknown };
}

/** What `SafeClient` itself answers for each of its three verify methods, and what it sent. */
export interface ClientOutcome {
  verifyRequests: unknown[];
  user: unknown;
}

export interface ContractRecord {
  cases: Record<string, ContractOutcome>;
  client: Record<string, ClientOutcome>;
}

/**
 * Runs every case against a fresh app and SaFE. The caller has set the environment (SaFE deploy mode,
 * `CLAW_AUTH_PROVIDER` unset, `LLM_KEY_SOURCE`) before this module's first import of `src`.
 */
export async function runContract(): Promise<ContractRecord> {
  const safe = await startContractSafe();
  process.env.SAFE_API_URL = safe.url;
  process.env.AUTH_INTERNAL_TOKEN = CONTRACT_INTERNAL_TOKEN;
  let app: FastifyInstance | undefined;
  try {
    const { authMiddleware, getUser } = await import("../../src/auth/middleware.js");
    const { registerMeRoutes } = await import("../../src/routes/me.js");
    const { SafeClient } = await import("../../src/auth/safe-client.js");
    app = Fastify();
    await app.register(cookie);
    app.addHook("preHandler", authMiddleware);
    await registerMeRoutes(app);
    // A file-download path, so the download-URL key is accepted, that answers with the request user.
    app.get("/v1/sessions/:id/files/*", async (req) => getUser(req));
    await app.ready();

    const verifyBodies = (from: number) => safe.seen.slice(from)
      .filter((r) => r.method === "POST" && r.url.split("?")[0] === "/api/v1/auth/verify")
      .map((r) => JSON.parse(r.body) as unknown);

    const cases: Record<string, ContractOutcome> = {};
    for (const c of CONTRACT_CASES) {
      const from = safe.seen.length;
      const probe = await app.inject({
        method: "GET", url: `/v1/sessions/s-1/files/report.txt${c.query ? `?${c.query}` : ""}`, headers: c.headers,
      });
      const me = c.query ? undefined : await app.inject({ method: "GET", url: "/v1/me", headers: c.headers });
      cases[c.name] = {
        verifyRequests: verifyBodies(from),
        user: { status: probe.statusCode, body: probe.json() },
        me: me ? { status: me.statusCode, body: me.json() } : { status: 0, body: null },
      };
    }

    const client: Record<string, ClientOutcome> = {};
    const calls: [string, (c: InstanceType<typeof SafeClient>) => Promise<unknown>][] = [
      ["verifyApiKey", (c) => c.verifyApiKey("ak-evalbot")],
      ["verifyCookie default", (c) => c.verifyCookie("tok-evalbot", "default")],
      ["verifyCookie sso", (c) => c.verifyCookie("sso-ssouser", "sso")],
      ["verifyAccessToken", (c) => c.verifyAccessToken("idt-evalbot")],
    ];
    for (const [name, call] of calls) {
      const from = safe.seen.length;
      const user = await call(new SafeClient(safe.url));
      client[name] = { verifyRequests: verifyBodies(from), user };
    }
    return { cases, client };
  } finally {
    await app?.close();
    await safe.close();
  }
}

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "safe-auth-contract-v0.5.8.json");

/**
 * The 0.5.8 outcome for `mode`. With CLAW_SAFE_CONTRACT_RECORD set to a directory, `record` is written there as
 * `<mode>.json` instead and returned: that is how the fixture was made, from the claw-v0.5.8 tree, and how it is
 * remade (copy this file and the two tests into a claw-v0.5.8 checkout, run them, merge the two files into the fixture).
 */
export function expectedOrRecord(mode: string, record: ContractRecord): ContractRecord {
  const dir = process.env.CLAW_SAFE_CONTRACT_RECORD;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${mode}.json`), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  }
  const all = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, ContractRecord>;
  const expected = all[mode];
  if (!expected) throw new Error(`no recorded 0.5.8 outcome for ${mode} in ${FIXTURE}`);
  return expected;
}
