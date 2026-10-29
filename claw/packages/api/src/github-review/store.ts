// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The two tables behind GitHub pull request review, created only while
 * `CLAW_GITHUB_REVIEW_ENABLED` is on:
 *
 *  - `claw_github_confirmations`: a merge held for the acting user. One row per
 *    (session, repository, pull request, head commit) while pending, single use,
 *    bound to the head commit it was asked about.
 *  - `claw_github_audit`: one row per tool call, written before the call does
 *    anything and finished after. Neither table holds a credential: not the GitHub
 *    token and not the session token. The audit table has no foreign key on
 *    purpose: it outlives the sessions it describes.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";

/** Anything that can run a statement: the pool, a client, or a test's database. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
}

export const GITHUB_REVIEW_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS claw_github_confirmations (
      confirmation_id   UUID PRIMARY KEY,
      session_id        TEXT NOT NULL,
      requester_user_id TEXT NOT NULL,
      actor_user_id     TEXT NOT NULL,
      repo              TEXT NOT NULL,
      pr                INTEGER NOT NULL,
      head_sha          TEXT NOT NULL,
      title             TEXT NOT NULL DEFAULT '',
      author            TEXT NOT NULL DEFAULT '',
      reasons           JSONB NOT NULL DEFAULT '[]'::jsonb,
      checks            JSONB NOT NULL DEFAULT '{}'::jsonb,
      status            TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'merging', 'merged', 'denied', 'stale', 'expired', 'refused')),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at        TIMESTAMPTZ NOT NULL,
      decided_at        TIMESTAMPTZ,
      decided_by        TEXT,
      result            JSONB
    )`,
  // One pending row per head commit, so asking twice shows the person one card.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_github_confirmations_pending
      ON claw_github_confirmations(session_id, repo, pr, head_sha) WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_github_confirmations_session ON claw_github_confirmations(session_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_github_confirmations_actor ON claw_github_confirmations(actor_user_id, status)`,
  `CREATE TABLE IF NOT EXISTS claw_github_audit (
      id                  BIGSERIAL PRIMARY KEY,
      at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      requester_user_id   TEXT NOT NULL,
      actor_user_id       TEXT NOT NULL,
      session_id          TEXT NOT NULL,
      repo                TEXT NOT NULL DEFAULT '',
      pr                  INTEGER,
      head_sha            TEXT NOT NULL DEFAULT '',
      tool                TEXT NOT NULL,
      arguments           JSONB NOT NULL DEFAULT '{}'::jsonb,
      github_requests     INTEGER NOT NULL DEFAULT 0,
      github_request_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,
      github_status       INTEGER,
      risk_reasons        JSONB NOT NULL DEFAULT '[]'::jsonb,
      confirmation_id     UUID,
      dry_run             BOOLEAN NOT NULL DEFAULT FALSE,
      write               BOOLEAN NOT NULL DEFAULT FALSE,
      result              TEXT NOT NULL DEFAULT 'started',
      detail              TEXT NOT NULL DEFAULT '',
      review_path         TEXT,
      review_path_reason  TEXT
    )`,
  `CREATE INDEX IF NOT EXISTS idx_github_audit_actor ON claw_github_audit(actor_user_id, at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_github_audit_session ON claw_github_audit(session_id)`,
];

export async function ensureGithubReviewSchema(client: pg.PoolClient): Promise<void> {
  for (const sql of GITHUB_REVIEW_SCHEMA_SQL) await client.query(sql);
}

// ---------------------------------------------------------------- audit

export interface AuditStart {
  requesterUserId: string;
  actorUserId: string;
  sessionId: string;
  tool: string;
  /** A short summary of the arguments, never their full text and never a credential. */
  args: Record<string, unknown>;
}

export interface AuditFinish {
  repo?: string;
  pr?: number;
  headSha?: string;
  githubRequests: number;
  githubRequestIds: string[];
  githubStatus?: number;
  riskReasons?: string[];
  confirmationId?: string;
  dryRun: boolean;
  write: boolean;
  result: string;
  detail?: string;
  /** `api_diff` or `sandbox`, with why; set by the call that chose it. */
  reviewPath?: string;
  reviewPathReason?: string;
}

export async function auditStart(db: Queryable, a: AuditStart): Promise<number> {
  const r = await db.query(
    `INSERT INTO claw_github_audit (requester_user_id, actor_user_id, session_id, tool, arguments)
     VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
    [a.requesterUserId, a.actorUserId, a.sessionId, a.tool, JSON.stringify(a.args)],
  );
  return Number((r.rows[0] as { id: string | number }).id);
}

export async function auditFinish(db: Queryable, id: number, f: AuditFinish): Promise<void> {
  await db.query(
    `UPDATE claw_github_audit
        SET repo = COALESCE($2, repo), pr = COALESCE($3, pr), head_sha = COALESCE($4, head_sha),
            github_requests = $5, github_request_ids = $6::jsonb, github_status = $7,
            risk_reasons = $8::jsonb, confirmation_id = $9, dry_run = $10, write = $11,
            result = $12, detail = $13, review_path = $14, review_path_reason = $15
      WHERE id = $1`,
    [
      id, f.repo ?? null, f.pr ?? null, f.headSha ?? null, f.githubRequests, JSON.stringify(f.githubRequestIds.slice(-20)),
      f.githubStatus ?? null, JSON.stringify(f.riskReasons ?? []), f.confirmationId ?? null, f.dryRun, f.write,
      f.result, (f.detail ?? "").slice(0, 500), f.reviewPath ?? null, f.reviewPathReason ?? null,
    ],
  );
}

/** What this session has already asked of GitHub. */
export async function sessionRequestCount(db: Queryable, sessionId: string): Promise<number> {
  const r = await db.query("SELECT COALESCE(SUM(github_requests), 0)::int AS n FROM claw_github_audit WHERE session_id = $1", [sessionId]);
  return Number((r.rows[0] as { n: number }).n);
}

/**
 * Mark a call's audit row as a write on this head commit, before the write is
 * counted against the limits and before it is made. The row then counts for as long
 * as the call is in flight, and stays counted if the call dies before it can finish
 * the row; a call that ends without writing says so when it finishes the row.
 */
export async function reserveWrite(db: Queryable, id: number, headSha: string): Promise<void> {
  await db.query("UPDATE claw_github_audit SET write = TRUE, head_sha = $2 WHERE id = $1", [id, headSha]);
}

/**
 * Reviews written in the last window, by one acting user's token (`actorUserId`) or
 * by all of them (null). A review is a (session, head commit) pair that wrote, so a
 * review and the merge that follows it count once. A call in flight counts (see
 * {@link reserveWrite}), the asking call's own row included, and so does a call that
 * sent a write and was then refused (a merge that approved and found the merge state
 * not clean): the `write` flag is what says something was sent, not how the call ended.
 * `pairPresent` says whether the pair being asked about is already among them in a
 * row other than `pair.selfId`, so that the second half of a review is never refused
 * for the first half.
 */
export async function recentWrites(
  db: Queryable, actorUserId: string | null, sinceMs: number, pair?: { sessionId: string; headSha: string; selfId?: number },
): Promise<{ count: number; pairPresent: boolean }> {
  const r = await db.query(
    `SELECT COUNT(DISTINCT session_id || ':' || head_sha)::int AS n,
            COALESCE(BOOL_OR(session_id = $3 AND head_sha = $4 AND ($5::bigint IS NULL OR id <> $5)), FALSE) AS present
       FROM claw_github_audit
      WHERE write AND NOT dry_run
        AND at > NOW() - ($2::bigint * INTERVAL '1 millisecond')
        AND ($1::text IS NULL OR actor_user_id = $1)`,
    [actorUserId, sinceMs, pair?.sessionId ?? null, pair?.headSha ?? null, pair?.selfId ?? null],
  );
  const row = r.rows[0] as { n: number; present: boolean };
  return { count: Number(row.n), pairPresent: row.present === true };
}

// ---------------------------------------------------------- confirmations

export type ConfirmationStatus = "pending" | "merging" | "merged" | "denied" | "stale" | "expired" | "refused";

export interface Confirmation {
  id: string;
  sessionId: string;
  requesterUserId: string;
  actorUserId: string;
  repo: string;
  pr: number;
  headSha: string;
  title: string;
  author: string;
  reasons: string[];
  checks: Record<string, unknown>;
  status: ConfirmationStatus;
  createdAt: string;
  expiresAt: string;
}

function toConfirmation(row: Record<string, unknown>): Confirmation {
  const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
  return {
    id: String(row.confirmation_id),
    sessionId: String(row.session_id),
    requesterUserId: String(row.requester_user_id),
    actorUserId: String(row.actor_user_id),
    repo: String(row.repo),
    pr: Number(row.pr),
    headSha: String(row.head_sha),
    title: String(row.title ?? ""),
    author: String(row.author ?? ""),
    reasons: Array.isArray(row.reasons) ? (row.reasons as string[]) : [],
    checks: (row.checks && typeof row.checks === "object" ? row.checks : {}) as Record<string, unknown>,
    status: row.status as ConfirmationStatus,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
  };
}

export interface NewConfirmation {
  sessionId: string;
  requesterUserId: string;
  actorUserId: string;
  repo: string;
  pr: number;
  headSha: string;
  title: string;
  author: string;
  reasons: string[];
  checks: Record<string, unknown>;
  ttlSeconds: number;
}

/** The pending confirmation for this head commit, made if there is none. */
export async function openConfirmation(db: Queryable, c: NewConfirmation): Promise<Confirmation> {
  const existing = await db.query(
    `SELECT * FROM claw_github_confirmations
      WHERE session_id = $1 AND repo = $2 AND pr = $3 AND head_sha = $4 AND status = 'pending' AND expires_at > NOW()`,
    [c.sessionId, c.repo, c.pr, c.headSha],
  );
  if (existing.rows[0]) return toConfirmation(existing.rows[0] as Record<string, unknown>);
  // A pending row that ran out is closed first, or the unique index would refuse the new one.
  await db.query(
    `UPDATE claw_github_confirmations SET status = 'expired'
      WHERE session_id = $1 AND repo = $2 AND pr = $3 AND head_sha = $4 AND status = 'pending' AND expires_at <= NOW()`,
    [c.sessionId, c.repo, c.pr, c.headSha],
  );
  const inserted = await db.query(
    `INSERT INTO claw_github_confirmations
       (confirmation_id, session_id, requester_user_id, actor_user_id, repo, pr, head_sha, title, author, reasons, checks, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, NOW() + ($12::bigint * INTERVAL '1 second'))
     ON CONFLICT DO NOTHING RETURNING *`,
    [
      randomUUID(), c.sessionId, c.requesterUserId, c.actorUserId, c.repo, c.pr, c.headSha,
      c.title.slice(0, 300), c.author.slice(0, 100), JSON.stringify(c.reasons), JSON.stringify(c.checks), c.ttlSeconds,
    ],
  );
  if (inserted.rows[0]) return toConfirmation(inserted.rows[0] as Record<string, unknown>);
  // Lost a race with a concurrent identical call: theirs is the one.
  const raced = await db.query(
    `SELECT * FROM claw_github_confirmations
      WHERE session_id = $1 AND repo = $2 AND pr = $3 AND head_sha = $4 AND status = 'pending'`,
    [c.sessionId, c.repo, c.pr, c.headSha],
  );
  return toConfirmation(raced.rows[0] as Record<string, unknown>);
}

/** Confirmations still waiting for this acting user. */
export async function countPendingConfirmations(db: Queryable, actorUserId: string): Promise<number> {
  const r = await db.query(
    "SELECT COUNT(*)::int AS n FROM claw_github_confirmations WHERE actor_user_id = $1 AND status = 'pending' AND expires_at > NOW()",
    [actorUserId],
  );
  return Number((r.rows[0] as { n: number }).n);
}

export async function getConfirmation(db: Queryable, id: string): Promise<Confirmation | null> {
  const r = await db.query("SELECT * FROM claw_github_confirmations WHERE confirmation_id = $1", [id]);
  return r.rows[0] ? toConfirmation(r.rows[0] as Record<string, unknown>) : null;
}

/**
 * Confirmations a caller may see: those of the sessions they own and those that
 * ask them. Pending ones that have run out are closed on the way, so nobody is
 * shown a card that can no longer be answered.
 */
export async function listConfirmations(
  db: Queryable, callerUserId: string, filter: { sessionId?: string; status?: ConfirmationStatus },
): Promise<Confirmation[]> {
  await db.query(
    `UPDATE claw_github_confirmations SET status = 'expired'
      WHERE status = 'pending' AND expires_at <= NOW() AND (requester_user_id = $1 OR actor_user_id = $1)`,
    [callerUserId],
  );
  const r = await db.query(
    `SELECT * FROM claw_github_confirmations
      WHERE (requester_user_id = $1 OR actor_user_id = $1)
        AND ($2::text IS NULL OR session_id = $2)
        AND ($3::text IS NULL OR status = $3)
      ORDER BY created_at DESC LIMIT 50`,
    [callerUserId, filter.sessionId ?? null, filter.status ?? null],
  );
  return r.rows.map((row) => toConfirmation(row as Record<string, unknown>));
}

export type ClaimResult =
  | { ok: true; confirmation: Confirmation }
  | { ok: false; reason: "not_found" | "not_pending" | "expired" };

/**
 * Take a pending confirmation for deciding, once. The conditional update is the
 * single-use guarantee: of two clicks, one gets the row.
 */
export async function claimConfirmation(db: Queryable, id: string, deciderUserId: string): Promise<ClaimResult> {
  const claimed = await db.query(
    `UPDATE claw_github_confirmations
        SET status = 'merging', decided_at = NOW(), decided_by = $2
      WHERE confirmation_id = $1 AND status = 'pending' AND expires_at > NOW() RETURNING *`,
    [id, deciderUserId],
  );
  if (claimed.rows[0]) return { ok: true, confirmation: toConfirmation(claimed.rows[0] as Record<string, unknown>) };
  const row = await getConfirmation(db, id);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status === "pending") {
    await db.query("UPDATE claw_github_confirmations SET status = 'expired' WHERE confirmation_id = $1 AND status = 'pending'", [id]);
    return { ok: false, reason: "expired" };
  }
  return { ok: false, reason: row.status === "expired" ? "expired" : "not_pending" };
}

/**
 * Give a claimed confirmation back to the acting user, still pending, because the
 * decision could not be carried out for a reason that will pass (a limit, a rate
 * limit, the identity service being down). False when it can no longer be answered:
 * it ran out, or another pending one for the same commit was asked in the meantime.
 */
export async function reopenConfirmation(db: Queryable, id: string): Promise<boolean> {
  try {
    const r = await db.query(
      `UPDATE claw_github_confirmations
          SET status = 'pending', decided_at = NULL, decided_by = NULL
        WHERE confirmation_id = $1 AND status = 'merging' AND expires_at > NOW() RETURNING confirmation_id`,
      [id],
    );
    return r.rows.length > 0;
  } catch (err) {
    // The unique index on pending rows: a newer confirmation for this commit stands. Anything else is not for this function to hide.
    if ((err as { code?: string })?.code === "23505") return false;
    throw err;
  }
}

export async function finishConfirmation(
  db: Queryable, id: string, status: Exclude<ConfirmationStatus, "pending" | "merging">, deciderUserId: string, result: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `UPDATE claw_github_confirmations
        SET status = $2, decided_at = COALESCE(decided_at, NOW()), decided_by = COALESCE(decided_by, $3), result = $4::jsonb
      WHERE confirmation_id = $1 AND status IN ('pending', 'merging')`,
    [id, status, deciderUserId, JSON.stringify(result)],
  );
}
