// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a GitHub review test stands on: a real PostgreSQL engine (PGlite) with the
 * review tables, a fake GitHub, a stand-in for the identity provider's resolve call,
 * and the service wired to all three. The acting user is `u-bob` (GitHub login
 * `bob`); the requester is `u-alice`.
 */
import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { IdentityCredentialRefusedError, IdentityUnavailableError, type ResolveCredentialRequest, type ResolvedCredential } from "@claw/utils";
import { GithubReview, type ReviewActor } from "../../src/github-review/service.js";
import { readGithubReviewSettings, type GithubReviewSettings } from "../../src/github-review/settings.js";
import { GITHUB_REVIEW_SCHEMA_SQL, type Queryable } from "../../src/github-review/store.js";
import { FakeGithub, HEAD } from "./fake-github.js";

export const TOKEN = "gho_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
export const REQUESTER_TOKEN = "gho_Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";
export const SECRET = "s".repeat(40);
export const PR = "AMD-AGI/demo#7";

export interface ReviewEnv {
  pg: PGlite;
  db: Queryable;
  gh: FakeGithub;
  service: GithubReview;
  settings: GithubReviewSettings;
  /** Every resolve the service made. */
  resolved: ResolveCredentialRequest[];
  /** Every wait the service asked for, in ms; none of them takes any time. */
  sleeps: number[];
  /** Runs when the service waits, so a test can change what GitHub says while it does. */
  onSleep: (ms: number) => void;
  /** Replace what the identity provider answers; it is told who is asked about (`userId`) and for whom (`requesterUserId`). */
  identity: { answer: (req: ResolveCredentialRequest) => Promise<ResolvedCredential> };
  actor: ReviewActor;
  sql(text: string, params?: unknown[]): Promise<Record<string, any>[]>;
  /** A copy of the settings with some environment changed, applied to the same service. */
  configure(env: Record<string, string>): void;
  close(): Promise<void>;
}

/** The acting user (`bob`) has bound GitHub and lets others act for them, which most tests need; a test for the switch being off says `delegation: false`. */
export function credential(over: Partial<ResolvedCredential> = {}): ResolvedCredential {
  return { token: TOKEN, providerLogin: "bob", kind: "oauth", scopes: ["public_repo"], delegation: true, expiresAt: null, ...over };
}

/**
 * What the identity provider answers: `bob`'s credential for the acting user's id, and for anyone else
 * (the requester, when only their login is wanted) `carol`, a different person from the pull request's author `alice`.
 */
export function directory(over: Partial<ResolvedCredential> = {}, requester: Partial<ResolvedCredential> = {}): (req: ResolveCredentialRequest) => Promise<ResolvedCredential> {
  return async (req) => (req.userId === "u-bob" ? credential(over) : credential({ token: REQUESTER_TOKEN, providerLogin: "carol", ...requester }));
}

/** One engine per test file: starting one costs more than the tests that use it, so the tables are made again for each test instead. */
let shared: PGlite | null = null;

export async function closeShared(): Promise<void> {
  const pg = shared;
  shared = null;
  await pg?.close();
}

/**
 * What the review instructions ask of the session before an approval or a merge of `head`, seeded as the service reads it back
 * (store.ts `headReviewFacts`): it read that head with `gh_pr_get` on `path`, and, unless `secondPass` is false, a sub-agent of it that used
 * a tool finished after that read.
 */
export async function reviewedHead(
  e: Pick<ReviewEnv, "sql" | "actor">, o: { head?: string; path?: "sandbox" | "api_diff"; secondPass?: boolean; pr?: string } = {},
): Promise<void> {
  const [repo, pr] = (o.pr ?? PR).split("#");
  await e.sql(
    `INSERT INTO claw_github_audit (requester_user_id, actor_user_id, session_id, tool, repo, pr, head_sha, result, detail, review_path, at)
     VALUES ($1, $2, $3, 'gh_pr_get', $4, $5, $6, 'ok', 'ok', $7, NOW() - INTERVAL '1 minute')`,
    [e.actor.requesterUserId, e.actor.actorUserId, e.actor.sessionId, repo, Number(pr), o.head ?? HEAD, o.path ?? "sandbox"],
  );
  if (o.secondPass !== false) await subAgentEnded(e, { head: o.head });
}

/**
 * One sub-agent of the session as the event consumer stores Brain's events of it: its `subagentStart` with the prompt it was given (the
 * second pass of the review instructions by default, which names the head commit), then its `subagentEnd`.
 */
export async function subAgentEnded(
  e: Pick<ReviewEnv, "sql" | "actor">,
  o: { end?: Record<string, unknown>; prompt?: string; startId?: string; head?: string } = {},
): Promise<void> {
  const id = `sub-${randomUUID().slice(0, 8)}`;
  const prompt = o.prompt ?? `Head commit ${o.head ?? HEAD}. Checkout /workspace/demo, base origin/main, the change in .pr-review/pr.diff. Report only what the first pass missed.`;
  const insert = "INSERT INTO claw_session_events (event_id, session_id, event, data) VALUES ($1, $2, $3, $4::jsonb)";
  await e.sql(insert, [randomUUID(), e.actor.sessionId, "subagentStart", JSON.stringify({ subagent_id: o.startId ?? id, subagent_type: "explore", prompt })]);
  const end = o.end ?? { failed: false, turns: 12, tool_stats: { total_calls: 9, error_calls: 0, by_tool: {} } };
  await e.sql(insert, [randomUUID(), e.actor.sessionId, "subagentEnd", JSON.stringify({ subagent_id: id, subagent_type: "explore", ...end })]);
}

/** An approval this session posted on `head` (default HEAD), as GitHub lists it: the acting user's, with the session's run marker. */
export function ownApproval(sessionId: string, head: string = HEAD, prefix = "claw-review:run"): Record<string, any> {
  const runId = createHash("sha256").update(`${sessionId}:${head}`).digest("hex").slice(0, 12);
  return { id: 880, state: "APPROVED", user: { login: "bob" }, commit_id: head, body: `No blocking findings.\n\n<!-- ${prefix}:${runId}:APPROVE:0123456789ab -->` };
}

export async function reviewEnv(
  env: Record<string, string> = {},
  over: { actor?: Partial<ReviewActor>; cred?: Partial<ResolvedCredential>; reviewed?: boolean; approved?: boolean } = {},
): Promise<ReviewEnv> {
  const pg = (shared ??= new PGlite());
  await pg.exec("DROP TABLE IF EXISTS claw_github_audit, claw_github_confirmations, claw_github_review_settings, claw_github_write_locks, claw_sessions, claw_session_events");
  await pg.exec("CREATE TABLE claw_sessions (session_id TEXT PRIMARY KEY, user_id TEXT, config JSONB DEFAULT '{}'::jsonb, deleted_at TIMESTAMPTZ)");
  // The columns of infra/db.ts that the review reads: a session's sub-agent runs (`subagentEnd`), as the event consumer stores them.
  await pg.exec(`CREATE TABLE claw_session_events (id SERIAL PRIMARY KEY, event_id TEXT NOT NULL, session_id TEXT NOT NULL, UNIQUE (event_id, session_id),
    event TEXT NOT NULL, data JSONB DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT NOW(), deleted_at TIMESTAMPTZ)`);
  for (const sql of GITHUB_REVIEW_SCHEMA_SQL) await pg.exec(sql);
  const db: Queryable = {
    query: async (text, params) => {
      const r = await pg.query(text, params as unknown[] | undefined);
      return { rows: r.rows as unknown[], rowCount: r.affectedRows ?? null };
    },
  };
  const gh = new FakeGithub();
  const resolved: ResolveCredentialRequest[] = [];
  const sleeps: number[] = [];
  const hooks = { onSleep: (_ms: number): void => {} };
  const identity = { answer: directory(over.cred) };
  let current = readGithubReviewSettings({ CLAW_GITHUB_REVIEW_MCP_SECRET: SECRET, CLAW_GITHUB_WRITES_ENABLED: "true", ...env }, true);
  const service = new GithubReview({
    settings: () => current, db, fetchImpl: gh.fetch,
    sleep: async (ms) => { sleeps.push(ms); hooks.onSleep(ms); },
    resolveCredential: async (req) => { resolved.push(req); return identity.answer(req); },
  });
  const actor: ReviewActor = { sessionId: "s-1", requesterUserId: "u-alice", actorUserId: "u-bob", requesterLabel: "Alice A", ...over.actor };
  const made = {
    pg, db, gh, service, get settings() { return current; }, resolved, sleeps, get onSleep() { return hooks.onSleep; }, set onSleep(f: (ms: number) => void) { hooks.onSleep = f; }, identity, actor,
    sql: async (text, params) => (await pg.query(text, params as unknown[] | undefined)).rows as Record<string, any>[],
    configure(extra) { current = readGithubReviewSettings({ CLAW_GITHUB_REVIEW_MCP_SECRET: SECRET, CLAW_GITHUB_WRITES_ENABLED: "true", ...env, ...extra }, true); },
    close: async () => {},
  } as ReviewEnv;
  // Most tests are about a later gate, so their session has done what the review asks first; a test of these gates says otherwise.
  if (over.reviewed !== false) await reviewedHead(made);
  if (over.approved) gh.reviews.push(ownApproval(actor.sessionId));
  return made;
}

export const unbound = (): Promise<never> => Promise.reject(new IdentityCredentialRefusedError("not_bound", 404));
export const expired = (): Promise<never> => Promise.reject(new IdentityCredentialRefusedError("expired", 410));
export const down = (): Promise<never> => Promise.reject(new IdentityUnavailableError("credential", "http_5xx", 503));

/** The text of one `gh_pr_get` answer's section: the review instructions, or the pull request's own text under `untrusted`. */
function sectionOf(body: Record<string, any>, section: string): string | undefined {
  if (section === "instructions") return body.review_instructions;
  return body.untrusted?.[section] ?? body.untrusted?.text;
}

/**
 * A `gh_pr_get` section whole, as the model is told to read it: from the overview when it is inline there, else page after page from
 * offset 0 along `next_offset`. `pages` counts the paged calls.
 */
export async function readSection(service: GithubReview, actor: ReviewActor, pr: string, section: string, extra: Record<string, unknown> = {}): Promise<{ text: string; pages: number }> {
  const first = (await service.getPr(actor, { pr, ...extra })).body as Record<string, any>;
  if (first.sections?.[section]?.inline) return { text: sectionOf(first, section) as string, pages: 0 };
  let text = "";
  let pages = 0;
  for (let offset: number | null = 0; offset !== null; pages++) {
    const o = await service.getPr(actor, { pr, section, head_sha: first.pull_request?.head_sha ?? first.head_sha, read_id: first.read_id, offset, ...extra });
    if (o.isError) throw new Error(`page refused: ${o.text}`);
    text += sectionOf(o.body as Record<string, any>, section) ?? "";
    offset = (o.body as Record<string, any>).next_offset;
  }
  return { text, pages };
}
