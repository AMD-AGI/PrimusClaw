// Tests for the ownership oracle: the reaper asking who still needs a
// workspace instead of guessing from a directory's mtime.
//
// The two failure modes are not symmetric and the tests are weighted
// accordingly. Keeping files nobody wants costs disk. Deleting files somebody
// still references loses a user's work with no undo, and the whole reason for
// the oracle is that mtime got that wrong in both directions: a live session
// idle past retention looked like garbage, and an abandoned one whose files
// were touched by a stray sync looked alive forever.
//
// Coverage:
//   O1  refs present -> keep, however old the directory
//   O2  retention lease still running -> keep
//   O3  retention lease expired -> trash without waiting for mtime
//   O4  unreferenced with no lease -> fall through to the age rule
//   O5  oracle unreachable -> keep (an error decides nothing)
//   O6  session the oracle has never heard of -> fall through to the age rule
//   O7  http client maps 404 to "unknown" and 5xx to "error"
//   O8  http client treats a malformed body as an error, not as "no refs"
//   O9  http client sends the internal token
//   O10 a lock held under the workspace gate key -> keep
//   O11 a KV failure reading that lock -> keep
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyForReap, httpOwnershipOracle } from "../src/workspace/reaper.js";
import type { OwnershipOracle, ReaperOpts, WorkspaceOwnership } from "../src/workspace/reaper.js";
import { makeKv } from "./nats-kv-stub.js";

const UID = "a".repeat(32);
const SID = "b".repeat(36);
const DAY_MS = 24 * 3600 * 1000;

function baseOpts(base: string, overrides: Partial<ReaperOpts> = {}): ReaperOpts {
  return {
    kv: makeKv() as ReaperOpts["kv"],
    kvCkpt: makeKv() as ReaperOpts["kvCkpt"],
    base,
    retentionDays: 7,
    kvGraceMin: 30,
    trashGraceHours: 24,
    maxDeletePerRun: 500,
    dryRun: false,
    ...overrides,
  };
}

/** An oracle with a fixed answer, recording what it was asked. */
function oracleSaying(
  answer: WorkspaceOwnership | "unknown" | "error",
  asked: string[] = [],
): OwnershipOracle {
  return {
    async lookup(sessionId: string) {
      asked.push(sessionId);
      return answer;
    },
  };
}

async function mkSession(base: string, mtimeAgoMs: number): Promise<string> {
  const dir = path.join(base, "users", UID, ".claw", "workspaces", SID);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "marker"), "x");
  const when = new Date(Date.now() - mtimeAgoMs);
  await fs.utimes(dir, when, when);
  return dir;
}

describe("classifyForReap with an ownership oracle", () => {
  let base: string;
  beforeEach(async () => { base = await fs.mkdtemp(path.join(os.tmpdir(), "owner-test-")); });
  afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

  it("O1 keeps a referenced workspace no matter how old the files are", async () => {
    // A month past every mtime threshold. Under the old rule this directory
    // was deleted; the session it belongs to is open in somebody's browser.
    await mkSession(base, 30 * DAY_MS);
    const asked: string[] = [];
    const d = await classifyForReap(baseOpts(base, {
      owner: oracleSaying({
        workspaceId: "kws_1",
        refs: [{ kind: "session", id: SID }],
        retentionExpiresAt: null,
      }, asked),
    }), UID, SID);
    assert.deepEqual(d, { action: "keep", reason: "referenced" });
    assert.deepEqual(asked, [SID], "the oracle is asked about this session, not another");
  });

  it("O2 keeps while the retention lease is still running", async () => {
    await mkSession(base, 30 * DAY_MS);
    const d = await classifyForReap(baseOpts(base, {
      owner: oracleSaying({
        workspaceId: "kws_1",
        refs: [],
        retentionExpiresAt: new Date(Date.now() + 2 * DAY_MS).toISOString(),
      }),
    }), UID, SID);
    assert.deepEqual(d, { action: "keep", reason: "retention_lease" });
  });

  it("O3 trashes on an expired lease without waiting for the mtime rule", async () => {
    // Fresh files -- mtime alone would keep these for another week. The last
    // reference was dropped and the lease has run out, so there is nothing
    // left to wait for.
    await mkSession(base, 60_000);
    const d = await classifyForReap(baseOpts(base, {
      owner: oracleSaying({
        workspaceId: "kws_1",
        refs: [],
        retentionExpiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    }), UID, SID);
    assert.deepEqual(d, { action: "trash", reason: "retention_expired" });
  });

  it("O4 falls through to the age rule when unreferenced with no lease set", async () => {
    // No refs and no deadline means nothing has released a last reference
    // yet -- the row exists but the lifecycle never reached the point that
    // sets a lease. That is not evidence of abandonment.
    await mkSession(base, 3 * DAY_MS);
    const owner = oracleSaying({ workspaceId: "kws_1", refs: [], retentionExpiresAt: null });
    assert.deepEqual(
      await classifyForReap(baseOpts(base, { owner }), UID, SID),
      { action: "keep", reason: "too_young" },
    );
  });

  it("O5 keeps when the oracle cannot be reached", async () => {
    await mkSession(base, 30 * DAY_MS);
    const d = await classifyForReap(baseOpts(base, { owner: oracleSaying("error") }), UID, SID);
    assert.deepEqual(d, { action: "keep", reason: "owner_unreachable" },
      "an API outage must not turn into a mass delete");
  });

  it("O5b keeps when the oracle throws rather than answering", async () => {
    await mkSession(base, 30 * DAY_MS);
    const owner: OwnershipOracle = {
      async lookup() { throw new Error("connect ECONNREFUSED"); },
    };
    const d = await classifyForReap(baseOpts(base, { owner }), UID, SID);
    assert.deepEqual(d, { action: "keep", reason: "owner_unreachable" });
  });

  it("O10 keeps a workspace whose gate lock is held", async () => {
    // The lock is `lock.ws.<workspaceId>` since the gate was rekeyed onto the
    // workspace, and only the oracle knows that id -- a reaper that looks up
    // `lock.<sid>` alone can never see the lock again, which drops one of the
    // three conditions protecting a live run. It matters when a workspace older
    // than retention + grace gets a new message: during a long restore the
    // directory's mtime is still weeks old and no checkpoint has landed yet, so
    // the lock is the only thing standing between that run and a deletion.
    await mkSession(base, 30 * DAY_MS);
    const kv = makeKv(new Map([["lock.ws.kws_1", "brain-2"]]));
    const d = await classifyForReap(baseOpts(base, {
      kv: kv as ReaperOpts["kv"],
      owner: oracleSaying({ workspaceId: "kws_1", refs: [], retentionExpiresAt: null }),
    }), UID, SID);
    assert.deepEqual(d, { action: "keep", reason: "lock_held" });
  });

  it("O11 keeps when the workspace lock cannot be read", async () => {
    await mkSession(base, 30 * DAY_MS);
    const kv = {
      get: async (key: string) => {
        if (key === "lock.ws.kws_1") throw new Error("kv unavailable");
        return null;
      },
      keys: async () => (async function* () { /* nothing alive */ })(),
    };
    const d = await classifyForReap(baseOpts(base, {
      kv: kv as unknown as ReaperOpts["kv"],
      owner: oracleSaying({ workspaceId: "kws_1", refs: [], retentionExpiresAt: null }),
    }), UID, SID);
    assert.deepEqual(d, { action: "keep", reason: "kv_error" },
      "an unreadable lock is not an absent lock");
  });

  it("O6 decides by age for sessions that predate workspace rows", async () => {
    await mkSession(base, 30 * DAY_MS);
    const owner = oracleSaying("unknown");
    assert.deepEqual(
      await classifyForReap(baseOpts(base, { owner }), UID, SID),
      { action: "trash", reason: "expired" },
    );
  });
});

/** Swap global fetch for the duration of one test. */
async function withFetch<T>(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof globalThis.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

describe("httpOwnershipOracle", () => {
  it("O7 reads a workspace, maps 404 to unknown and 5xx to error", async () => {
    const oracle = httpOwnershipOracle("http://api:8080", "tok");

    const found = await withFetch(async () => new Response(JSON.stringify({
      ok: true,
      workspace: {
        workspace_id: "kws_9",
        refs: [{ kind: "run", id: "task_1" }],
        retention_expires_at: null,
      },
    }), { status: 200 }), () => oracle.lookup(SID));
    assert.deepEqual(found, {
      workspaceId: "kws_9",
      refs: [{ kind: "run", id: "task_1" }],
      retentionExpiresAt: null,
    });

    const missing = await withFetch(
      async () => new Response("", { status: 404 }),
      () => oracle.lookup(SID),
    );
    assert.equal(missing, "unknown", "no row is a real answer: decide by age");

    const broken = await withFetch(
      async () => new Response("", { status: 503 }),
      () => oracle.lookup(SID),
    );
    assert.equal(broken, "error", "a failing API is not a claim that nothing is referenced");
  });

  it("O8 treats a body it cannot read as an error", async () => {
    const oracle = httpOwnershipOracle("http://api:8080", "tok");
    // A 200 whose shape is wrong -- a proxy's error page, a truncated body, a
    // future schema change. Reading `refs` off it yields undefined, and the
    // tempting default of "no refs" is the one that deletes files.
    for (const body of ['{"ok":true}', '{"workspace":{}}', "not json at all"]) {
      const verdict = await withFetch(
        async () => new Response(body, { status: 200 }),
        () => oracle.lookup(SID),
      );
      assert.equal(verdict, "error", `body ${body} must not be read as unreferenced`);
    }
  });

  it("O9 sends the internal token and asks about the right session", async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const oracle = httpOwnershipOracle("http://api:8080", "s3cret");
    await withFetch(async (url, init) => {
      seen.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization") ?? undefined,
      });
      return new Response("", { status: 404 });
    }, () => oracle.lookup("sid with spaces"));
    assert.equal(seen[0]?.auth, "Bearer s3cret");
    assert.match(seen[0]?.url ?? "", /\/v1\/internal\/workspaces\/by-session\/sid%20with%20spaces$/);
  });
});
