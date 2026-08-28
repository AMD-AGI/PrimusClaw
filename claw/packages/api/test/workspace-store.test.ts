// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The bookkeeping that turns "files under a path" into a thing with an owner.
 *
 * There is no database in these tests, so what they can pin is the shape of
 * the statements and the order they go out in. That is narrower than it
 * sounds: the decisions this module makes are almost entirely expressed as
 * guards inside single statements -- retention starts only when no live
 * reference is left, a writer claim is takeable only when the incumbent has
 * expired -- and a lost guard is the whole bug. Each assertion below names the
 * failure that dropping that clause would cause.
 *
 * Two invariants sit above the details:
 *
 *   1. None of this may fail a conversation. These rows exist to be compared
 *      against reality before anything depends on them, and bookkeeping that
 *      can break a conversation is worse than no bookkeeping. The two
 *      exceptions are both answers given to something about to act: a run
 *      cannot be dispatched without a workspace, and a collector must not be
 *      told "no workspace" when the truth is "could not tell".
 *   2. Acquire and release are symmetric. A reference that is taken and never
 *      released keeps files forever; one released twice starts a retention
 *      countdown under a live run.
 */
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { db } from "../src/infra/db.js";
import {
  acquireRef,
  claimWriter,
  ensureSessionWorkspace,
  isWorkspaceBindingError,
  MIN_IDLE_RELEASE_DAYS,
  releaseRef,
  releaseRefsOfDeletedSessions,
  releaseRefsOfFinishedRuns,
  releaseRefsOfIdleSessions,
  releaseRunUse,
  releaseSessionRefs,
  releaseWriter,
  requireWorkspaceBinding,
  RETENTION_DAYS,
  workspaceState,
} from "../src/workspace/store.js";
import { sessionWorkspacePrefix } from "../src/workspace/prefix.js";

interface SeenQuery { sql: string; params: unknown[] }

const originalQuery = db.query;
after(() => { db.query = originalQuery; });

let seen: SeenQuery[] = [];
beforeEach(() => { seen = []; });

/** Answer each statement by matching on it; anything unmatched comes back empty. */
function stubDb(answers: Array<[RegExp, unknown]> = []): void {
  db.query = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    seen.push({ sql, params });
    for (const [re, rows] of answers) {
      if (re.test(sql)) return { rows: rows as unknown[], rowCount: (rows as unknown[]).length };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
}

function failingDb(): void {
  db.query = (async () => { throw new Error("relation does not exist"); }) as typeof db.query;
}

const WS = {
  workspace_id: "kws_1",
  owner_user_id: "u-1",
  storage_prefix: "users/u-1/sessions/s-1/",
  version: "3",
  writer_run_id: null,
  retention_expires_at: null,
  deleted_at: null,
};

test("the recorded prefix is the path the files already live under", async () => {
  // A row describing a different location than the one in use would be worse
  // than no row: the collector would be given an authoritative-looking pointer
  // at the wrong directory. So the assertion is on what the row is created with,
  // compared against the builder the delete, the file routes and the upload
  // sweeper all call -- not against a literal, which passes just as happily once
  // the two have drifted, and drifting is the only way this row comes to be
  // wrong. What the string itself has to look like is pinned where it matters
  // most, in session-workspace-delete.test.ts.
  stubDb();

  await ensureSessionWorkspace("s-1", "");

  const insert = seen.find((q) => /INSERT INTO claw_workspaces /.test(q.sql));
  assert.ok(insert, "a session with no workspace yet has one created for it");
  assert.deepEqual(
    insert.params.slice(1),
    ["default", sessionWorkspacePrefix("", "s-1")],
    "anonymous uploads land under `default`, and the row has to say the same",
  );
});

test("a session that already has a workspace does not get a second one", async () => {
  stubDb([[/^SELECT w.workspace_id/, [WS]]]);
  const ws = await ensureSessionWorkspace("s-1", "u-1");

  assert.equal(ws?.workspace_id, "kws_1");
  assert.equal(seen.length, 1, "the read is the whole of it when the row exists");
  assert.ok(!seen.some((q) => /^INSERT/.test(q.sql)));
});

test("the first run of a session creates the workspace and references it", async () => {
  // The lookup misses, so this is the creating path. The re-read at the end is
  // what makes the race safe: two dispatches for one session both insert a
  // workspace, one live reference per (kind, id) lets one win, and the loser has
  // to take the winner's id rather than the one it just made.
  let created = false;
  db.query = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    seen.push({ sql, params });
    if (/^SELECT w.workspace_id/.test(sql)) {
      const rows = created ? [WS] : [];
      return { rows, rowCount: rows.length };
    }
    if (/^INSERT INTO claw_workspace_refs/.test(sql)) { created = true; return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 1 };
  }) as typeof db.query;

  const ws = await ensureSessionWorkspace("s-1", "u-1");
  assert.equal(ws?.workspace_id, "kws_1", "the re-read wins over the id we just minted");

  const insert = seen.find((q) => /^INSERT INTO claw_workspaces /.test(q.sql));
  assert.ok(insert, "a workspace row is written");
  assert.match(String(insert?.params[0]), /^kws_/, "ids are prefixed so they cannot be confused with sessions");
  assert.equal(insert?.params[2], "users/u-1/sessions/s-1/");

  const ref = seen.find((q) => /^INSERT INTO claw_workspace_refs/.test(q.sql));
  assert.match(ref?.sql ?? "", /ON CONFLICT DO NOTHING/,
    "the loser of the race must not error; it re-reads instead");
  assert.ok(!/ON CONFLICT \(/.test(ref?.sql ?? ""),
    "the conflict is on the live-reference index, not on the primary key: "
    + "naming the primary key here would let the loser raise instead of yield, "
    + "because the two rows differ in the workspace id each caller minted");
  assert.deepEqual(ref?.params, [insert?.params[0], "s-1"],
    "the reference points at the workspace this call just created");
});

test("the schema, not the primary key, is what stops a session splitting in two", () => {
  // The race is only safe if something makes the second insert conflict. The
  // primary key (workspace_id, ref_kind, ref_id) cannot: each caller mints its
  // own workspace id first, so the two rows differ in the leading column and
  // both inserts succeed. A session then has two workspaces, only one of which
  // `workspaceForSession` returns, and two of its runs take different gate keys
  // over the same directory -- the overlap the gate exists to remove.
  const src = readFileSync(
    fileURLToPath(new URL("../src/infra/db.ts", import.meta.url)),
    "utf-8",
  ).replace(/\s+/g, " ");
  assert.match(
    src,
    /CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_refs_live_ref ON claw_workspace_refs\(ref_kind, ref_id\) WHERE released_at IS NULL/,
    "one live reference per (kind, id)",
  );
  assert.ok(
    !/CREATE UNIQUE INDEX[^;]*uq_workspace_refs_live_ref[^;]*\)\s*\.catch/.test(src),
    "a constraint that fails to be created must not be swallowed like a hint",
  );
});

test("the wider lookup has an index of its own", () => {
  // `includeReleased` asks by (ref_kind, ref_id) with the released rows left
  // in, and the unique index is partial on exactly the opposite condition, so
  // it cannot serve that query at all. The two callers are a session coming
  // back and the collector deciding whether the files may go -- neither is
  // rare, and both would otherwise scan a table that gains a row per session
  // and per run and never loses one.
  const src = readFileSync(
    fileURLToPath(new URL("../src/infra/db.ts", import.meta.url)),
    "utf-8",
  ).replace(/\s+/g, " ");
  const idx = /CREATE INDEX IF NOT EXISTS idx_workspace_refs_ref_any ON claw_workspace_refs\(ref_kind, ref_id\)( WHERE [^`]*)?/.exec(src);
  assert.ok(idx, "the includeReleased lookup is indexed");
  assert.equal(idx?.[1], undefined,
    "and not behind a predicate, which is what made the last one useless here");
});

test("a session coming back takes its own files again, rather than a fresh workspace", async () => {
  // With idle release on, a dormant session's reference is let go and the files
  // start counting down. The path back has to land on the same workspace: the
  // storage prefix is derived from the session, so a second workspace would
  // describe the same directory under a different gate key, which is precisely
  // the overlap the gate exists to remove.
  db.query = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    seen.push({ sql, params });
    if (/^SELECT w.workspace_id/.test(sql)) {
      // params[1] is `includeReleased`: live lookups miss, the wider one hits.
      const rows = params[1] ? [{ ...WS, retention_expires_at: "2026-01-01T00:00:00Z" }] : [];
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 1 };
  }) as typeof db.query;

  const ws = await ensureSessionWorkspace("s-1", "u-1");

  assert.equal(ws?.workspace_id, "kws_1");
  assert.ok(!seen.some((q) => /^INSERT INTO claw_workspaces /.test(q.sql)),
    "the files are already somewhere; naming them twice is the bug");
  assert.ok(seen.some((q) => /ON CONFLICT .* DO UPDATE SET released_at = NULL/.test(q.sql)),
    "the released reference is revived");
  assert.ok(seen.some((q) => /SET retention_expires_at = NULL/.test(q.sql)),
    "and the countdown it started is cancelled, or the files go mid-conversation");
});

test("taking a reference cancels any countdown to collection", async () => {
  stubDb();
  await acquireRef("kws_1", "run", "ktsk_9");

  const [ref, clear] = seen;
  assert.match(ref.sql, /ON CONFLICT .* DO UPDATE SET released_at = NULL/,
    "a run re-referencing a workspace it released must revive the row, not fail");
  assert.match(clear.sql, /SET retention_expires_at = NULL/);
  assert.deepEqual(clear.params, ["kws_1"],
    "leaving a lease set under a live reference lets it expire mid-run");
});

test("retention starts only when the last reference is gone", async () => {
  stubDb();
  await releaseRef("kws_1", "session", "s-1");

  const [release, lease] = seen;
  assert.match(release.sql, /SET released_at = NOW\(\).*released_at IS NULL/,
    "releasing twice must not move the release time forward");
  assert.match(lease.sql, /NOT EXISTS \( SELECT 1 FROM claw_workspace_refs r WHERE r.workspace_id = w.workspace_id AND r.released_at IS NULL \)/,
    "without this guard, one finished run starts the clock on a live session's files");
  assert.match(
    lease.sql,
    /retention_expires_at IS NULL OR w.retention_expires_at > NOW\(\) \+ \(\$2::int \* INTERVAL '1 day'\)/,
    "a countdown may be shortened and never extended: every ordinary caller passes the same "
    + "number, so the deadline it would write is later than the one on the row and nothing "
    + "moves -- a session released and re-adopted cannot push its own collection back",
  );
  assert.equal(lease.params[1], 7, "the default matches the collector's own retention");
});

test("a deleted session's files are let go of with no lease at all", async () => {
  // The lease is the window for second thoughts about files that might still be
  // wanted. A session the user asked to delete has had its S3 copy removed
  // outright by the same cleanup, so a week's lease on the shared-filesystem
  // copy only makes the two disagree by a week. Reaching the row the idle sweep
  // already leased is the case the shortening clause above exists for.
  stubDb();
  await releaseSessionRefs("s-1", { retentionDays: 0 });
  assert.equal(seen.length, 1, "no workspace, so nothing to lease");

  seen = [];
  stubDb([[/^SELECT w.workspace_id/, [WS]]]);
  await releaseSessionRefs("s-1", { retentionDays: 0 });

  const lease = seen.find((q) => /retention_expires_at = NOW\(\) \+/.test(q.sql));
  assert.equal(lease?.params[1], 0);
});

test("the sweep that reclaims a deleted session's reference leases nothing either", async () => {
  // It reaches the same rows as the delete's own release, late: the two writing
  // different deadlines for the same directory would make which of them ran
  // first decide when the files go.
  stubDb([[/^SELECT r.workspace_id, r.ref_id/, [{ workspace_id: "kws_1", ref_id: "s-1" }]]]);
  await releaseRefsOfDeletedSessions(1);

  const lease = seen.find((q) => /retention_expires_at = NOW\(\) \+/.test(q.sql));
  assert.equal(lease?.params[1], 0);
});

test("a finished run releases the write side before its reference", async () => {
  // Order matters: releasing the reference first can leave the workspace with
  // no references and a writer still recorded, which reads as a live writer
  // on files that are counting down to deletion.
  stubDb([[/^SELECT workspace_id FROM claw_workspace_refs/, [{ workspace_id: "kws_1" }]]]);
  await releaseRunUse("ktsk_9");

  const kinds = seen.map((q) => q.sql);
  const writerAt = kinds.findIndex((s) => /SET writer_run_id = NULL/.test(s));
  const refAt = kinds.findIndex((s) => /claw_workspace_refs SET released_at/.test(s));
  assert.ok(writerAt >= 0 && refAt >= 0 && writerAt < refAt);
});

test("a run that never started leaves the version alone", async () => {
  stubDb([[/^SELECT workspace_id FROM claw_workspace_refs/, [{ workspace_id: "kws_1" }]]]);
  await releaseRunUse("ktsk_9", false);

  const writer = seen.find((q) => /SET writer_run_id = NULL/.test(q.sql));
  assert.equal(writer?.params[2], false,
    "a dispatch that failed wrote nothing, so nothing observed the workspace change");
});

test("a run that failed still counts as having changed the workspace", async () => {
  stubDb([[/^SELECT workspace_id FROM claw_workspace_refs/, [{ workspace_id: "kws_1" }]]]);
  await releaseRunUse("ktsk_9");

  const writer = seen.find((q) => /SET writer_run_id = NULL/.test(q.sql));
  assert.equal(writer?.params[2], true, "it may have written half of what it meant to");
});

test("releasing a run nobody recorded touches nothing", async () => {
  stubDb();
  await releaseRunUse("ktsk_unknown");
  assert.equal(seen.length, 1, "the lookup misses and the function stops");
});

test("a run whose row was closed by the sweeper still lets go of the files", async () => {
  // The leak this closes: the completion path releases the reference, and the
  // sweeper closes rows without going through it. A reference left behind is
  // not a small loss -- retention never starts, and the collector keeps a live
  // reference over every other signal it has, so those files stop ageing out.
  stubDb([
    [/^SELECT r.ref_id/, [{ ref_id: "ktsk_9" }]],
    [/^SELECT workspace_id FROM claw_workspace_refs/, [{ workspace_id: "kws_1" }]],
  ]);
  const released = await releaseRefsOfFinishedRuns();

  assert.equal(released, 1);
  const scan = seen[0].sql;
  assert.match(scan, /t.status IN \('completed','failed','cancelled'\)/,
    "a run still going must keep the files it is writing");
  assert.match(scan, /r.released_at IS NULL/,
    "without this the same reference is re-released on every tick");
  assert.match(scan, /r.ref_kind = 'run'/,
    "the session's own reference is released when the session is deleted, not here");
  assert.ok(seen.some((q) => /SET writer_run_id = NULL/.test(q.sql)),
    "the write side goes with the reference, or the version never moves");
});

test("reconciling references cannot fail a tick", async () => {
  failingDb();
  assert.equal(await releaseRefsOfFinishedRuns(), 0,
    "this runs inside the sweeper, and the reapers after it matter more");
});

test("an operator can switch the sweep off, and it stops before the table", async () => {
  // Zero has to mean off without even reading the table, or a deployment that
  // turned this off pays for a scan every tick to learn it has nothing to do.
  stubDb();
  assert.equal(await releaseRefsOfIdleSessions(0), 0);
  assert.equal(await releaseRefsOfIdleSessions(Number.NaN), 0,
    "an unparseable setting reads as off, not as zero days idle");
  assert.equal(seen.length, 0);
});

test("the two dormant sweeps ship differently, because they do different things", async () => {
  // Reclaiming a deleted session's leaked reference is bookkeeping about files
  // the teardown already removed, and the only thing that ever does it -- so it
  // is on by default, because off it would be a fix that reaches no deployment.
  // Releasing a live session's reference ends with that user's files being
  // deleted, so that one may not start happening because someone upgraded.
  stubDb();
  await releaseRefsOfDeletedSessions();
  assert.equal(seen.length, 1, "the leak nothing else reconciles has to be swept by default");
  assert.equal(seen[0].params[2], true, "and only over sessions that are already gone");

  seen = [];
  await releaseRefsOfIdleSessions();
  assert.equal(seen.length, 0,
    "a deployment that never opted in must not begin deleting live sessions' files");
});

test("a session idle past the configured window lets go of its files", async () => {
  stubDb([[/^SELECT r.workspace_id, r.ref_id/, [{ workspace_id: "kws_1", ref_id: "s-1" }]]]);
  const released = await releaseRefsOfIdleSessions(30);

  assert.equal(released, 1);
  const scan = seen[0].sql;
  assert.match(scan, /s.updated_at < NOW\(\) - \(\$1::int \* INTERVAL '1 day'\)/);
  assert.equal(seen[0].params[0], 30, "the window is the operator's, not a constant here");
  assert.equal(seen[0].params[2], false,
    "a live session is the only population this one may touch");
  assert.match(scan, /r.released_at IS NULL/,
    "without this the same reference is re-released on every tick");
  assert.match(scan, /r.ref_kind = 'session'/,
    "a run's reference is released when the run ends, not when the chat goes quiet");
  assert.ok(seen.some((q) => /claw_workspace_refs SET released_at/.test(q.sql)));
  assert.ok(seen.some((q) => /retention_expires_at = NOW\(\) \+/.test(q.sql)),
    "letting go is only useful if it starts the countdown");
});

test("a live-session window shorter than the lease it starts is raised", async () => {
  // The three windows are serial, so the idle number decides the total rather
  // than clearing anything. Below the lease it starts, the lease is the term
  // that governs and the operator's number is not the one in effect -- so the
  // floor is expressed against the lease instead of written out, which is what
  // keeps the two from drifting when the lease is reconfigured.
  stubDb();
  await releaseRefsOfIdleSessions(1);

  assert.equal(seen[0].params[0], MIN_IDLE_RELEASE_DAYS,
    "erring towards keeping files, and towards the number that actually governs");
  assert.equal(MIN_IDLE_RELEASE_DAYS, 2 * RETENTION_DAYS,
    "asserted against the lease rather than against 14, which stops meaning anything"
    + " the moment WORKSPACE_RETENTION_DAYS is changed");
});

test("a deleted session's reference is reclaimed, though its files are long gone", async () => {
  // It used to be the one reference the sweep refused to touch, on the grounds
  // that the teardown had already released it. When the teardown's release does
  // not land -- and it is best-effort, so it need not -- nothing else ever
  // releases it: a deleted session is never dispatched to again, so it cannot
  // reach any of the paths that let go. The workspace then keeps a live
  // reference forever, and a live reference is the strongest keep signal the
  // collector has, so the files of deleted sessions are exactly the ones that
  // are never collected.
  stubDb([[/^SELECT r.workspace_id, r.ref_id/, [{ workspace_id: "kws_1", ref_id: "s-1" }]]]);
  assert.equal(await releaseRefsOfDeletedSessions(1), 1);

  assert.match(seen[0].sql, /\(s.deleted_at IS NOT NULL\) = \$3/,
    "excluding them left the one population whose reference nothing else can release");
  assert.ok(seen.some((q) => /claw_workspace_refs SET released_at/.test(q.sql)));
});

test("releasing dormant sessions cannot fail a tick", async () => {
  failingDb();
  assert.equal(await releaseRefsOfIdleSessions(30), 0);
  assert.equal(await releaseRefsOfDeletedSessions(1), 0);
});

test("the writer claim is takeable only from an incumbent that has expired", async () => {
  stubDb([[/^UPDATE claw_workspaces SET writer_run_id = \$2/, [{ version: "3" }]]]);
  const claim = await claimWriter("kws_1", "ktsk_9");

  assert.deepEqual(claim, { held: true, version: "3" });
  const sql = seen[0].sql;
  assert.match(sql, /writer_run_id IS NULL/, "an unclaimed workspace is free");
  assert.match(sql, /writer_run_id = \$2/, "re-claiming is renewal, not contention");
  assert.match(sql, /writer_expires_at < NOW\(\)/,
    "without expiry takeover, a run whose worker died locks the files until retention");
  assert.equal(seen[0].params[2], 3600);
});

test("a run that loses the claim is told who holds it, and proceeds anyway", async () => {
  // Nothing refuses to run on a lost claim yet. The point of this step is to
  // find out how often two runs really do write one workspace; refusing first
  // and measuring later would turn an unknown frequency into an outage.
  stubDb([[/^SELECT workspace_id, owner_user_id/, [{ ...WS, writer_run_id: "ktsk_other" }]]]);
  const claim = await claimWriter("kws_1", "ktsk_9");

  assert.deepEqual(claim, { held: false, heldBy: "ktsk_other", version: "3" });
});

test("only the holder can release the write side", async () => {
  stubDb();
  await releaseWriter("kws_1", "ktsk_9", true);

  assert.match(seen[0].sql, /WHERE workspace_id = \$1 AND writer_run_id = \$2/,
    "a late finisher must not clear the claim of the run that took over from it");
  assert.match(seen[0].sql, /version = version \+ CASE WHEN \$3 THEN 1 ELSE 0 END/);
});

test("deleting a session releases its runs' references too, or the lease it asks for is not written", async () => {
  // Deleting a session cancels its open runs without touching their workspace
  // references, so the session's own release lands with a run reference still
  // live -- and the lease clause requires that nothing is left, so the zero this
  // caller passes writes nothing. The reconcile sweep then releases that run
  // reference on a later tick with its own default, and the deliberate delete
  // ends up with the seven-day lease its S3 copy was deleted without. Releasing
  // them together is what makes the zero mean anything, and it leaves the
  // reconcile sweep nothing to release afterwards.
  stubDb([
    [/^SELECT w.workspace_id/, [WS]],
    [/^UPDATE claw_workspace_refs r SET released_at/, [{}]],
    [/^UPDATE claw_workspace_refs SET released_at/, [{}]],
  ]);

  await releaseSessionRefs("s-1", { retentionDays: 0 });

  const runs = seen.find((q) => /ref_kind = 'run'/.test(q.sql));
  assert.ok(runs, "the runs of this session hold references of their own");
  assert.match(runs.sql, /EXISTS \( SELECT 1 FROM claw_tasks t WHERE t.task_id = r.ref_id AND t.session_id = \$2 \)/,
    "this session's runs only -- another session's run on the same workspace still uses it");
  assert.deepEqual(runs.params, ["kws_1", "s-1"]);
  const lease = seen.find((q) => /retention_expires_at = NOW\(\) \+/.test(q.sql));
  assert.equal(lease?.params[1], 0, "and the release that follows is the one that writes the lease");
  assert.ok(seen.indexOf(runs) < seen.indexOf(lease!),
    "the run references have to be gone before the statement that tests for them");
});

test("deleting a session releases what it held rather than the files", async () => {
  stubDb([
    [/^SELECT w.workspace_id/, [WS]],
    [/^UPDATE claw_workspace_refs SET released_at/, [{}]],
  ]);
  assert.equal(await releaseSessionRefs("s-1"), "released");

  assert.ok(seen.some((q) => /claw_workspace_refs SET released_at/.test(q.sql)));
  assert.ok(!seen.some((q) => /DELETE/.test(q.sql)),
    "the files outlive the session by the retention period; that is the point of the lease");
});

test("a release the delete could not make is told apart from one it did not need", async () => {
  // The delete is the one caller that can act on the difference, and it is the
  // one caller nothing comes after: a deleted session is never dispatched to
  // again, so it never releases anything again. Answered alike -- as this used
  // to, with the lookup swallowed and releaseRef reporting nothing at all -- the
  // teardown recorded itself complete over a reference that is now the strongest
  // keep signal the collector has.
  failingDb();
  assert.equal(await releaseSessionRefs("s-1"), "failed",
    "an unreadable lookup is not a session that held nothing");

  stubDb();
  assert.equal(await releaseSessionRefs("s-1"), "none_held",
    "and a session with no workspace is not a failed delete");

  stubDb([[/^SELECT w.workspace_id/, [WS]]]);
  assert.equal(await releaseSessionRefs("s-1"), "none_held",
    "nor is a reference the dormant sweep let go of first, which the statement running cannot tell");

  db.query = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    seen.push({ sql, params });
    if (/^SELECT w.workspace_id/.test(sql)) return { rows: [WS], rowCount: 1 };
    throw new Error("terminating connection due to administrator command");
  }) as typeof db.query;
  assert.equal(await releaseSessionRefs("s-1"), "failed",
    "the release itself failing is the case that was invisible");
});

test("the collector is handed evidence, not a verdict", async () => {
  stubDb([
    [/^SELECT w.workspace_id/, [{ ...WS, retention_expires_at: "2026-01-01T00:00:00Z" }]],
    [/^SELECT ref_kind, ref_id/, [{ ref_kind: "session", ref_id: "s-1" }]],
  ]);
  const state = await workspaceState("s-1");

  assert.deepEqual(state?.refs, [{ kind: "session", id: "s-1" }]);
  assert.equal(state?.retention_expires_at, "2026-01-01T00:00:00Z");
  assert.equal(state?.storage_prefix, "users/u-1/sessions/s-1/",
    "the collector can only act on a path it was told, and it has no database");
});

test("a workspace nobody references still answers, with its deadline", async () => {
  // The lease is written when the last reference goes, and this is the only
  // reader of it. Asking the narrow "what does this session reference" question
  // here returned nothing at exactly that moment, so the collector heard "no
  // workspace", fell back to mtime, and the lease was write-only.
  stubDb([
    [/^SELECT w.workspace_id/, [{ ...WS, retention_expires_at: "2026-01-01T00:00:00Z" }]],
  ]);
  const state = await workspaceState("s-1");

  assert.deepEqual(state?.refs, [], "nothing needs these files now");
  assert.equal(state?.retention_expires_at, "2026-01-01T00:00:00Z",
    "and this is the date that decides, instead of the mtime of whatever was touched last");
  assert.equal(seen[0].params[1], true, "the lookup has to see through the released reference");
});

test("a session with no workspace row is absent, not empty", async () => {
  // The difference decides whether the collector may delete: "no row" means
  // this predates workspaces and it should fall back to its own rules, while
  // "a row with no references" means the references really are all gone.
  stubDb();
  assert.equal(await workspaceState("s-old"), null);
});

test("a failed read is not reported as no workspace", async () => {
  // The collector reads "no row" as permission to judge by mtime instead. If a
  // failed read answered the same way, one database outage would hand out that
  // permission for every session at once, and the first cycle afterwards would
  // delete the files of live sessions whose rows exist and say keep. This is the
  // one read here that must raise.
  failingDb();
  await assert.rejects(workspaceState("s-1"));
});

test("no bookkeeping failure reaches the caller", async () => {
  // Every one of these runs on the dispatch path of an ordinary chat message.
  // workspaceState is absent from this list on purpose: its caller is a
  // collector, not a conversation.
  failingDb();
  assert.equal(await ensureSessionWorkspace("s-1", "u-1"), null);
  assert.equal(await claimWriter("kws_1", "ktsk_9"), null);
  await acquireRef("kws_1", "run", "ktsk_9");
  await releaseRef("kws_1", "run", "ktsk_9");
  await releaseWriter("kws_1", "ktsk_9", true);
  await releaseRunUse("ktsk_9");
  await releaseSessionRefs("s-1");
});

test("a run with no workspace is refused rather than dispatched", () => {
  // One of the two places in this module that does not swallow. Everything else
  // here is bookkeeping whose failure costs a log line; this is the gate's input,
  // and a run dispatched without it overlaps runs writing the same directory
  // and loses their files on sync. The refusal has to be loud enough to reach
  // the sender.
  assert.throws(
    () => requireWorkspaceBinding(undefined, { sessionId: "s-1" }),
    /refusing to dispatch/,
  );
  assert.throws(() => requireWorkspaceBinding(null, { sessionId: "s-1" }), /s-1/);
  assert.throws(() => requireWorkspaceBinding("", { sessionId: "s-1" }));
});

test("a bound run passes its id straight through", () => {
  assert.equal(requireWorkspaceBinding("kws_1", { sessionId: "s-1" }), "kws_1");
});

test("the refusal is recognisable without reading its message", () => {
  // The DAG dispatcher retries this one failure and fails every other, so it has
  // to tell them apart. Matching on the wording is how that classification
  // silently inverts the day the wording changes.
  const refusal = (() => {
    try { requireWorkspaceBinding(undefined, { sessionId: "s-1" }); } catch (e) { return e; }
  })();
  assert.ok(isWorkspaceBindingError(refusal));
  assert.ok(!isWorkspaceBindingError(new Error("no responders")));
  assert.ok(!isWorkspaceBindingError(undefined), "an absent error is not a refusal");
});
