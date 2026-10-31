// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a GitHub review test stands on: a real PostgreSQL engine (PGlite) with the
 * review tables, a fake GitHub, a stand-in for the identity provider's resolve call,
 * and the service wired to all three. The acting user is `u-bob` (GitHub login
 * `bob`); the requester is `u-alice`.
 */
import { PGlite } from "@electric-sql/pglite";
import { IdentityCredentialRefusedError, IdentityUnavailableError, type ResolveCredentialRequest, type ResolvedCredential } from "@claw/utils";
import { GithubReview, type ReviewActor } from "../../src/github-review/service.js";
import { readGithubReviewSettings, type GithubReviewSettings } from "../../src/github-review/settings.js";
import { GITHUB_REVIEW_SCHEMA_SQL, type Queryable } from "../../src/github-review/store.js";
import { FakeGithub } from "./fake-github.js";

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

export async function reviewEnv(env: Record<string, string> = {}, over: { actor?: Partial<ReviewActor>; cred?: Partial<ResolvedCredential> } = {}): Promise<ReviewEnv> {
  const pg = (shared ??= new PGlite());
  await pg.exec("DROP TABLE IF EXISTS claw_github_audit, claw_github_confirmations, claw_sessions");
  await pg.exec("CREATE TABLE claw_sessions (session_id TEXT PRIMARY KEY, user_id TEXT, config JSONB DEFAULT '{}'::jsonb, deleted_at TIMESTAMPTZ)");
  for (const sql of GITHUB_REVIEW_SCHEMA_SQL) await pg.exec(sql);
  const db: Queryable = {
    query: async (text, params) => {
      const r = await pg.query(text, params as unknown[] | undefined);
      return { rows: r.rows as unknown[], rowCount: r.affectedRows ?? null };
    },
  };
  const gh = new FakeGithub();
  const resolved: ResolveCredentialRequest[] = [];
  const identity = { answer: directory(over.cred) };
  let current = readGithubReviewSettings({ CLAW_GITHUB_REVIEW_MCP_SECRET: SECRET, CLAW_GITHUB_WRITES_ENABLED: "true", ...env }, true);
  const service = new GithubReview({
    settings: () => current, db, fetchImpl: gh.fetch,
    resolveCredential: async (req) => { resolved.push(req); return identity.answer(req); },
  });
  const actor: ReviewActor = { sessionId: "s-1", requesterUserId: "u-alice", actorUserId: "u-bob", requesterLabel: "Alice A", ...over.actor };
  return {
    pg, db, gh, service, get settings() { return current; }, resolved, identity, actor,
    sql: async (text, params) => (await pg.query(text, params as unknown[] | undefined)).rows as Record<string, any>[],
    configure(extra) { current = readGithubReviewSettings({ CLAW_GITHUB_REVIEW_MCP_SECRET: SECRET, CLAW_GITHUB_WRITES_ENABLED: "true", ...env, ...extra }, true); },
    close: async () => {},
  } as ReviewEnv;
}

export const unbound = (): Promise<never> => Promise.reject(new IdentityCredentialRefusedError("not_bound", 404));
export const expired = (): Promise<never> => Promise.reject(new IdentityCredentialRefusedError("expired", 410));
export const down = (): Promise<never> => Promise.reject(new IdentityUnavailableError("credential", "http_5xx", 503));
