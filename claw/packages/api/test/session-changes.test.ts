// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `GET /v1/sessions/:id/changes`, end to end on this machine: the real route and the
 * real service, a PGlite session table, the real MCP client talking to a Hands
 * stand-in that RUNS the `bash` tool, and real git repositories as the work trees.
 * So the shell scripts, git's own output, the parsers and the HTTP answer are all
 * the production ones; only the sandbox is a directory.
 *
 *   C1 the summary: every work tree under the root, depth <= 2, files / status / +/-, branch, head
 *   C2 the numbers are git's: totals equal `git diff --numstat HEAD` (+ untracked lines) run directly
 *   C3 odd names: spaces, non-ASCII, a newline, quotes, shell text, a name that looks like an option
 *   C4 owner isolation: another user's session and a missing one are the same 404
 *   C5 a sandbox that is not running is 409 and NOTHING is started to look at it
 *   C6 limits: 200 files, 20 repositories, 64 KB of patch
 *   C7 the patch form, and secrets masked in it
 *   C8 injection: nothing the caller sends reaches git unless the listing produced it
 *   C9 read-only: asking changes nothing in the repositories
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Fastify, { type FastifyInstance } from "fastify";

process.env.CLAW_DEPLOY_MODE = "kubernetes";

const { registerSessionRoutes } = await import("../src/routes/sessions.js");
const { changesPorts } = await import("../src/sessions/changes-service.js");
const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
const { startHarness, seedSession } = await import("./scenario-harness.js");
const { startHandsBashStub } = await import("./support/hands-bash-stub.js");
type Harness = Awaited<ReturnType<typeof startHarness>>;
type Stub = Awaited<ReturnType<typeof startHandsBashStub>>;

const OWNER = { userId: "u-1", userName: "u-1", roles: ["default"], platformKey: "pk", virtualKey: "vk" };
const OTHER = { userId: "u-2", userName: "u-2", roles: ["default"], platformKey: "pk2", virtualKey: "vk2" };
const ADMIN = { userId: "adm", userName: "adm", roles: ["system-admin"], platformKey: "pk3", virtualKey: "vk3" };

let h: Harness;
let stub: Stub;
let world: string;
let home: string;
let root: string;
const original = { ...changesPorts };
const originalDispatch = { ...sessionDispatchPorts };
let target: { url: string; token: string } | null;
let published = 0;
let dispatched = 0;

function gitEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] });
const write = (p: string, text: string | Buffer) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

before(async () => {
  h = await startHarness();
  world = fs.mkdtempSync(path.join(os.tmpdir(), "claw-changes-"));
  home = path.join(world, "home");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, ".gitconfig"), "[safe]\n\tdirectory = *\n[init]\n\tdefaultBranch = main\n");
  stub = await startHandsBashStub({ token: "tok-sandbox", env: gitEnv() });
  changesPorts.readTarget = async () => target;
  // The sandbox's work trees are under a temporary root here; /workspace in production.
  (changesPorts as { root: string }).root = "";
});
beforeEach(async () => {
  await h.reset();
  root = fs.mkdtempSync(path.join(world, "ws-"));
  (changesPorts as { root: string }).root = root;
  target = { url: stub.url, token: stub.token };
  stub.commands.length = 0;
  published = 0;
  dispatched = 0;
  // Anything that would start or reach a sandbox is a failure of the whole feature.
  sessionDispatchPorts.publishTask = (async () => { published++; return 1; }) as typeof sessionDispatchPorts.publishTask;
  sessionDispatchPorts.openChatRun = (async () => { dispatched++; return null; }) as typeof sessionDispatchPorts.openChatRun;
  sessionDispatchPorts.doorbellDispatch = (() => { dispatched++; return null; }) as typeof sessionDispatchPorts.doorbellDispatch;
});
after(async () => {
  Object.assign(changesPorts, original);
  Object.assign(sessionDispatchPorts, originalDispatch);
  await stub.close();
  await h.close();
  fs.rmSync(world, { recursive: true, force: true });
});

async function appAs(user: typeof OWNER): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("preHandler", async (req) => { (req as unknown as { user: typeof OWNER }).user = user; });
  await registerSessionRoutes(app);
  await app.ready();
  return app;
}

async function get(url: string, user = OWNER) {
  const app = await appAs(user);
  try {
    const res = await app.inject({ method: "GET", url });
    return { status: res.statusCode, body: res.json() as any, raw: res.body };
  } finally {
    await app.close();
  }
}

/** A repository with a first commit; `files` are written and committed. */
function repo(rel: string, files: Record<string, string | Buffer> = { "README.md": "# r\n" }): string {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  for (const [f, c] of Object.entries(files)) write(path.join(dir, f), c);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

const lines = (n: number, tag = "l") => Array.from({ length: n }, (_, i) => `${tag}${i}`).join("\n") + "\n";
const SID = "s-changes";
const seed = (owner = OWNER.userId) => seedSession(h, SID, { userId: owner, agentStatus: "idle" });
const changes = (q = "", user = OWNER) => get(`/v1/sessions/${SID}/changes${q}`, user);
const patch = (repoPath: string, file: string, user = OWNER) =>
  changes(`?repo=${encodeURIComponent(repoPath)}&file=${encodeURIComponent(file)}`, user);

// ----------------------------------------------------------------------------------------------

test("C1 the summary: one work tree with a modified, a deleted, an added, a renamed, a binary and an untracked file", async () => {
  await seed();
  const app = repo("app", { "a.txt": lines(5), "b.txt": lines(3), "old name.txt": lines(10, "r"), "bin.dat": Buffer.from([0, 1, 2, 3, 0, 255]), "keep.txt": "same\n" });
  write(path.join(app, "a.txt"), lines(5).replace("l1\n", "L1\nextra\n"));    // modified: +2 -1
  fs.rmSync(path.join(app, "b.txt"));                                          // deleted: -3
  write(path.join(app, "c.txt"), lines(4, "c"));                               // added (staged): +4
  git(app, "add", "c.txt");
  git(app, "mv", "old name.txt", "new name.txt");                              // renamed (staged)
  write(path.join(app, "bin.dat"), Buffer.from([9, 0, 9, 0, 9]));              // binary, modified
  write(path.join(app, "u.txt"), lines(6, "u"));                               // untracked: +6
  write(path.join(app, "u.bin"), Buffer.from([0, 0, 1, 2]));                   // untracked binary
  const r = await changes();
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.session_id, SID);
  assert.match(r.body.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(r.body.truncated, false);
  assert.equal(r.body.repos.length, 1);
  const [a] = r.body.repos;
  assert.equal(a.path, app);
  assert.equal(a.branch, "main");
  assert.equal(a.head, git(app, "rev-parse", "--short", "HEAD").trim());
  assert.equal(a.truncated, false);
  assert.deepEqual(a.files, [
    { path: "a.txt", status: "M", additions: 2, deletions: 1, binary: false },
    { path: "b.txt", status: "D", additions: 0, deletions: 3, binary: false },
    { path: "bin.dat", status: "M", additions: null, deletions: null, binary: true },
    { path: "c.txt", status: "A", additions: 4, deletions: 0, binary: false },
    { path: "new name.txt", status: "R", additions: 0, deletions: 0, binary: false },
    { path: "u.bin", status: "?", additions: null, deletions: null, binary: true },
    { path: "u.txt", status: "?", additions: 6, deletions: 0, binary: false },
  ]);
  assert.deepEqual(a.totals, { files: 7, additions: 2 + 4 + 6, deletions: 1 + 3 });
});

test("C1 the work trees under the root: depth <= 2, nested and at the root, none in node_modules or deeper, a clean one is listed empty", async () => {
  await seed();
  const top = repo("app");
  write(path.join(top, "x.txt"), "x\n");
  const group = repo("group/lib");                // depth 2
  const clean = repo("clean");
  const fresh = path.join(root, "fresh");         // no commit yet
  fs.mkdirSync(fresh);
  git(fresh, "init", "-q", "-b", "main");
  write(path.join(fresh, "staged.txt"), lines(3));
  git(fresh, "add", "staged.txt");
  write(path.join(fresh, "loose.txt"), lines(2));
  repo("deep/a/b/c");                             // deeper than two levels: not listed
  repo("three/a/b");                              // three levels down: not listed either
  repo("node_modules/pkg");                       // pruned
  repo(".cache/thing");                           // pruned
  repo(".skills/thing");                          // pruned
  const r = await changes();
  assert.equal(r.status, 200, r.raw);
  assert.deepEqual(r.body.repos.map((x: any) => x.path), [clean, fresh, group, top].sort());
  const by = Object.fromEntries(r.body.repos.map((x: any) => [x.path, x]));
  assert.deepEqual(by[clean].files, []);
  assert.deepEqual(by[clean].totals, { files: 0, additions: 0, deletions: 0 });
  assert.equal(by[group].files.length, 0);
  assert.deepEqual(by[top].files.map((f: any) => f.path), ["x.txt"]);
  // A repository with no commit: head is empty, a staged file is an addition, a loose one is untracked.
  assert.equal(by[fresh].head, "");
  assert.deepEqual(by[fresh].files, [
    { path: "loose.txt", status: "?", additions: 2, deletions: 0, binary: false },
    { path: "staged.txt", status: "A", additions: 3, deletions: 0, binary: false },
  ]);
  assert.equal(r.body.truncated, false);
});

test("C1 the root may itself be a work tree; a detached HEAD has no branch; no repositories is an empty list, not an error", async () => {
  await seed();
  const empty = await changes();
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.repos, []);
  const rootRepo = repo("");
  write(path.join(rootRepo, "r.txt"), "r\n");
  git(rootRepo, "checkout", "-q", "--detach", "HEAD");
  const r = await changes();
  assert.equal(r.body.repos.length, 1);
  assert.equal(r.body.repos[0].path, root);
  assert.equal(r.body.repos[0].branch, null);
  assert.deepEqual(r.body.repos[0].files.map((f: any) => f.path), ["r.txt"]);
});

test("C2 the numbers are git's: the totals equal `git diff --numstat HEAD` run directly, plus the untracked lines", async () => {
  await seed();
  const app = repo("app", { "a.ts": lines(40), "b.ts": lines(20, "b"), "c.ts": lines(8, "c") });
  write(path.join(app, "a.ts"), lines(40).replace(/l1\d\n/g, "X\n"));
  write(path.join(app, "b.ts"), lines(25, "b"));
  fs.rmSync(path.join(app, "c.ts"));
  write(path.join(app, "d.ts"), lines(12, "d"));
  write(path.join(app, "e.ts"), lines(7, "e"));
  git(app, "add", "d.ts");
  let add = 0, del = 0, files = 0;
  for (const l of git(app, "diff", "--numstat", "HEAD").split("\n").filter(Boolean)) {
    const [a, d] = l.split("\t"); add += Number(a); del += Number(d); files++;
  }
  add += 7; files += 1;                                                // e.ts, untracked, 7 lines
  const r = await changes();
  assert.deepEqual(r.body.repos[0].totals, { files, additions: add, deletions: del });
  assert.equal(r.body.repos[0].files.length, files);
});

test("C3 odd names: spaces, non-ASCII, quotes, a newline, shell text and an option-looking name are listed as they are", async () => {
  await seed();
  const app = repo("app", { "keep.txt": "k\n" });
  const names = ["has space.txt", "café 中.txt", "quo\"te'.txt", "new\nline.txt", "$(touch pwned).txt", "`touch pwned2`.txt", "-rf", "--output=x", ":(top)magic", "semi;colon.txt", "a\tb.txt"];
  for (const n of names) write(path.join(app, n), lines(2));
  const r = await changes();
  assert.equal(r.status, 200, r.raw);
  assert.deepEqual(r.body.repos[0].files.map((f: any) => f.path).sort(), [...names].sort());
  assert.ok(r.body.repos[0].files.every((f: any) => f.status === "?" && f.additions === 2));
  assert.equal(fs.existsSync(path.join(app, "pwned")), false);
  assert.equal(fs.existsSync(path.join(app, "pwned2")), false);
  assert.equal(fs.existsSync("pwned"), false);
});

test("C3 a path with a space in a repository's own directory name", async () => {
  await seed();
  const app = repo("my project (v2)", { "a.txt": "a\n" });
  write(path.join(app, "a.txt"), "a\nb\n");
  const r = await changes();
  assert.equal(r.body.repos[0].path, app);
  assert.deepEqual(r.body.repos[0].files, [{ path: "a.txt", status: "M", additions: 1, deletions: 0, binary: false }]);
});

// ---- C4 owner isolation ------------------------------------------------------------------------

test("C4 another user's session, an administrator, and a session that does not exist are the same 404", async () => {
  await seed();
  repo("app");
  const own = await changes();
  assert.equal(own.status, 200);
  const other = await changes("", OTHER);
  const admin = await changes("", ADMIN);
  const missing = await get("/v1/sessions/no-such-session/changes");
  const deleted = (async () => {
    await seedSession(h, "gone", { userId: OWNER.userId, agentStatus: "idle" });
    await h.sql("UPDATE claw_sessions SET deleted_at = NOW() WHERE session_id = 'gone'");
    return get("/v1/sessions/gone/changes");
  })();
  for (const r of [other, admin, missing, await deleted]) {
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { ok: false, error: "session not found" });
  }
  assert.equal(other.raw, missing.raw, "byte for byte: the answer does not say that the session exists");
  // The patch form is no way round it.
  const p = await get(`/v1/sessions/${SID}/changes?repo=${encodeURIComponent(path.join(root, "app"))}&file=README.md`, OTHER);
  assert.equal(p.status, 404);
});

test("C4 a refused caller never reaches the sandbox", async () => {
  await seed();
  repo("app");
  stub.commands.length = 0;
  for (const user of [OTHER, ADMIN]) {
    assert.equal((await changes("", user)).status, 404);
    assert.equal((await patch(path.join(root, "app"), "README.md", user)).status, 404);
  }
  assert.equal((await get("/v1/sessions/nope/changes")).status, 404);
  assert.equal(stub.commands.length, 0);
});

// ---- C5 not running -----------------------------------------------------------------------------

test("C5 a sandbox that is not running is a 409, and nothing is started to look at it", async () => {
  await seed();
  repo("app");
  stub.commands.length = 0;
  const cases: Array<[string, () => void]> = [
    ["no registry entry (reclaimed)", () => { target = null; }],
    ["an address that nobody answers", () => { target = { url: "http://127.0.0.1:9/mcp", token: "t" }; }],
    ["an entry whose token is not the sandbox's (a replaced sandbox)", () => { target = { url: stub.url, token: "stale" }; }],
  ];
  for (const [label, arrange] of cases) {
    arrange();
    for (const q of ["", `?repo=${encodeURIComponent(path.join(root, "app"))}&file=README.md`]) {
      const r = await changes(q);
      assert.equal(r.status, 409, `${label} ${q}: ${r.raw}`);
      assert.deepEqual(r.body, { ok: false, error: "sandbox_not_running" }, label);
    }
  }
  assert.equal(published, 0, "no turn was published");
  assert.equal(dispatched, 0, "no run was opened, no doorbell rung");
  assert.equal(stub.commands.length, 0, "and nothing was run in a sandbox that was not the one named");
  assert.equal((await h.sql("SELECT count(*)::int AS n FROM claw_tasks"))[0].n, 0, "no run row exists");
  assert.equal((await h.sql("SELECT agent_status FROM claw_sessions WHERE session_id = $1", [SID]))[0].agent_status, "idle", "the session was not touched");
});

test("C5 the registry read: only a ready entry with an address and a token names a sandbox", async () => {
  const { readHandsTarget } = await import("../src/sessions/changes-service.js");
  const { handsSessionKey } = await import("@claw/protocol");
  const entries = new Map<string, { operation?: string; value: Uint8Array }>();
  const enc = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));
  const bucket = { get: async (key: string) => entries.get(key) ?? null };
  const key = handsSessionKey("s-reg");
  const ready = { status: "ready", handsUrl: "http://h/mcp", token: "t" };
  const cases: Array<[string, { operation?: string; value: Uint8Array }, boolean]> = [
    ["ready", { value: enc(ready) }, true],
    ["ready, written as a PUT", { operation: "PUT", value: enc(ready) }, true],
    ["pending", { value: enc({ ...ready, status: "pending" }) }, false],
    ["closing", { value: enc({ ...ready, status: "closing" }) }, false],
    ["no status", { value: enc({ handsUrl: "http://h/mcp", token: "t" }) }, false],
    ["no url", { value: enc({ status: "ready", token: "t" }) }, false],
    ["no token", { value: enc({ status: "ready", handsUrl: "http://h/mcp" }) }, false],
    ["empty url", { value: enc({ ...ready, handsUrl: "" }) }, false],
    ["empty token", { value: enc({ ...ready, token: "" }) }, false],
    ["wrong types", { value: enc({ status: "ready", handsUrl: 5, token: {} }) }, false],
    ["a deleted entry", { operation: "DEL", value: enc(ready) }, false],
    ["a purged entry", { operation: "PURGE", value: enc(ready) }, false],
    ["an empty value (what a delete leaves)", { value: new Uint8Array() }, false],
    ["not JSON", { value: enc("{{{") }, false],
  ];
  for (const [label, entry, ok] of cases) {
    entries.set(key, entry);
    assert.deepEqual(await readHandsTarget("s-reg", bucket), ok ? { url: "http://h/mcp", token: "t" } : null, label);
  }
  assert.equal(await readHandsTarget("s-absent", bucket), null, "no entry");
  assert.equal(await readHandsTarget("s-reg", { get: async () => { throw new Error("registry down"); } }), null, "an unreadable registry is not a sandbox");
});

// ---- C6 limits ---------------------------------------------------------------------------------

test("C6 more than 200 changed files: 200 are listed, truncated says so, the totals still count them", async () => {
  await seed();
  const app = repo("app");
  for (let i = 0; i < 230; i++) write(path.join(app, `d/f${String(i).padStart(3, "0")}.txt`), "1\n");
  const r = await changes();
  assert.equal(r.status, 200, r.raw);
  const [a] = r.body.repos;
  assert.equal(a.files.length, 200);
  assert.equal(a.truncated, true);
  assert.equal(r.body.truncated, true);
  assert.equal(a.files[0].path, "d/f000.txt");
  assert.equal(a.files[199].path, "d/f199.txt");
  assert.ok(a.totals.files >= 201, `${a.totals.files}`);
});

test("C6 exactly 200 is not truncated; tracked changes beyond 200 are all counted", async () => {
  await seed();
  const files: Record<string, string> = {};
  for (let i = 0; i < 260; i++) files[`t${String(i).padStart(3, "0")}.txt`] = "a\n";
  const app = repo("app", files);
  for (let i = 0; i < 260; i++) write(path.join(app, `t${String(i).padStart(3, "0")}.txt`), "a\nb\n");
  const r = await changes();
  const [a] = r.body.repos;
  assert.equal(a.files.length, 200);
  assert.equal(a.truncated, true);
  assert.deepEqual(a.totals, { files: 260, additions: 260, deletions: 0 }, "tracked changes are all in the totals");
  // 200 exactly
  fs.rmSync(path.join(root, "app"), { recursive: true });
  const b = repo("app2");
  for (let i = 0; i < 200; i++) write(path.join(b, `u${i}.txt`), "1\n");
  const e = await changes();
  const two = e.body.repos.find((x: any) => x.path === b);
  assert.equal(two.files.length, 200);
  assert.equal(two.truncated, false);
});

test("C6 more than 20 repositories: 20 are listed and the answer is truncated", async () => {
  await seed();
  for (let i = 0; i < 23; i++) repo(`r${String(i).padStart(2, "0")}`);
  const r = await changes();
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.repos.length, 20);
  assert.equal(r.body.truncated, true);
});

test("C6 past the output budget the script stops after a whole repository and says there are more", async () => {
  await seed();
  for (const n of ["a", "b", "c"]) { const r = repo(n); write(path.join(r, "README.md"), "# changed\n"); write(path.join(r, "x.txt"), "x\n"); }
  const real = changesPorts.exec;
  const { summaryScript } = await import("../src/sessions/changes.js");
  // The same script with a budget of one character: the first repository fills it.
  changesPorts.exec = (async (t: never, command: string, timeout: number) => real(t, command.includes("@@REPO") ? summaryScript(root, 1) : command, timeout)) as never;
  try {
    const r = await changes();
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.repos.length, 1, "one whole repository, not a cut one");
    assert.deepEqual(r.body.repos[0].files.map((f: any) => f.path), ["README.md", "x.txt"]);
    assert.equal(r.body.truncated, true);
  } finally {
    changesPorts.exec = real;
  }
  const all = await changes();
  assert.equal(all.body.repos.length, 3, "and with the real budget all three");
  assert.equal(all.body.truncated, false);
});

test("C6 an untracked file too large to count is an addition of unknown size, not a stall", async () => {
  await seed();
  const app = repo("app");
  write(path.join(app, "huge.log"), Buffer.alloc(5 * 1024 * 1024 + 10, 97));
  write(path.join(app, "small.log"), "a\nb\n");
  const r = await changes();
  assert.deepEqual(r.body.repos[0].files, [
    { path: "huge.log", status: "?", additions: null, deletions: 0, binary: false },
    { path: "small.log", status: "?", additions: 2, deletions: 0, binary: false },
  ]);
});

// ---- C7 the patch form --------------------------------------------------------------------------

test("C7 one file's diff: tracked, staged, deleted, renamed, untracked and binary, relative or absolute", async () => {
  await seed();
  const app = repo("app", { "a.txt": lines(6), "b.txt": "gone\n", "old.txt": lines(20, "o"), "bin.dat": Buffer.from([0, 1, 2]) });
  write(path.join(app, "a.txt"), lines(6).replace("l2\n", "CHANGED\n"));
  fs.rmSync(path.join(app, "b.txt"));
  git(app, "mv", "old.txt", "new.txt");
  write(path.join(app, "bin.dat"), Buffer.from([0, 9, 9, 9]));
  write(path.join(app, "u.txt"), "fresh\nfile\n");
  const a = await patch(app, "a.txt");
  assert.equal(a.status, 200, a.raw);
  assert.equal(a.body.truncated, false);
  assert.match(a.body.patch, /^diff --git a\/a\.txt b\/a\.txt\n/);
  assert.match(a.body.patch, /-l2\n\+CHANGED\n/);
  assert.equal(a.body.patch, git(app, "diff", "--no-color", "HEAD", "--", "a.txt"), "the same bytes git prints");
  const abs = await patch(app, path.join(app, "a.txt"));
  assert.equal(abs.body.patch, a.body.patch);
  assert.match((await patch(app, "b.txt")).body.patch, /deleted file mode[\s\S]*-gone\n/);
  assert.match((await patch(app, "new.txt")).body.patch, /rename from old\.txt\nrename to new\.txt/);
  assert.match((await patch(app, "bin.dat")).body.patch, /Binary files a\/bin\.dat and b\/bin\.dat differ/);
  const u = await patch(app, "u.txt");
  assert.match(u.body.patch, /new file mode[\s\S]*\+fresh\n\+file\n/);
});

test("C7 a patch over 64 KB is cut at 64 KB and says so; secrets in it are masked", async () => {
  await seed();
  const app = repo("app", { "big.txt": "x\n", "cfg.env": "A=1\n" });
  write(path.join(app, "big.txt"), "y".repeat(100) + "\n".repeat(1) + lines(8000, "line number "));
  const big = await patch(app, "big.txt");
  assert.equal(big.status, 200);
  assert.equal(big.body.truncated, true);
  assert.equal(Buffer.byteLength(big.body.patch), 64 * 1024);
  write(path.join(app, "cfg.env"), "A=1\nGH_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyzAB\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123\nURL=https://user:pw456789@h.example.invalid/x\n");
  const cfg = await patch(app, "cfg.env");
  assert.equal(cfg.status, 200);
  for (const secret of ["ghp_0123456789", "abcdefghijklmnopqrstuvwxyz0123", "user:pw456789"]) assert.equal(cfg.body.patch.includes(secret), false, secret);
  assert.match(cfg.body.patch, /\+A=1|A=1/);
});

test("C7 a credential held under a NAME in a changed file is masked in the patch, and a 64 KB single-line change comes back at once", async () => {
  await seed();
  const app = repo("app", { ".env": "A=1\n", "min.js": "x\n" });
  write(path.join(app, ".env"), "A=1\nDB_PASSWORD=hunter2\napi_key = \"s3cr3tvalue\"\n  password: correcthorse\nrun --kube-token kubesecret1 up\n");
  const env = await patch(app, ".env");
  assert.equal(env.status, 200, env.raw);
  for (const secret of ["hunter2", "s3cr3tvalue", "correcthorse", "kubesecret1"]) assert.equal(env.body.patch.includes(secret), false, secret);
  assert.match(env.body.patch, /\+A=1|A=1/);
  // One line of 64 KB (a minified bundle): redaction must not stall the process.
  write(path.join(app, "min.js"), "a".repeat(64 * 1024) + "\n");
  const t0 = Date.now();
  const big = await patch(app, "min.js");
  assert.equal(big.status, 200);
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
  assert.equal(big.body.truncated, true);
});

test("C7 the patch form needs both parameters, once each", async () => {
  await seed();
  const app = repo("app");
  write(path.join(app, "x.txt"), "x\n");
  for (const q of [`?repo=${encodeURIComponent(app)}`, `?file=x.txt`]) {
    const r = await changes(q);
    assert.equal(r.status, 400, q);
    assert.deepEqual(r.body, { ok: false, error: "repo and file must be given together" });
  }
  for (const q of [`?repo=${encodeURIComponent(app)}&file=x.txt&file=y.txt`, `?repo=${encodeURIComponent(app)}&repo=${encodeURIComponent(app)}&file=x.txt`, "?repo=&file=x.txt", `?repo=${encodeURIComponent(app)}&file=`]) {
    const r = await changes(q);
    assert.equal(r.status, 400, q);
  }
  assert.equal(stub.commands.length, 0, "a malformed ask never reaches the sandbox");
});

test("C7 a file that is not changed, and a repository that is not listed, are 404 with their own words", async () => {
  await seed();
  const app = repo("app");
  write(path.join(app, "x.txt"), "x\n");
  const a = await patch(app, "README.md");           // exists, unchanged
  assert.deepEqual([a.status, a.body], [404, { ok: false, error: "file_not_found" }]);
  const b = await patch(path.join(root, "nowhere"), "x.txt");
  assert.deepEqual([b.status, b.body], [404, { ok: false, error: "repo_not_found" }]);
});

// ---- C8 injection -------------------------------------------------------------------------------

test("C8 nothing a caller sends reaches the sandbox unless the listing produced it", async () => {
  await seed();
  const app = repo("app", { "a.txt": "a\n" });
  write(path.join(app, "a.txt"), "a\nb\n");
  const marker = path.join(world, "INJECTED");
  const bad: Array<[string, string, string, number]> = [
    ["a traversal out of the repository", app, "../../../etc/passwd", 400],
    ["an absolute path outside", app, "/etc/passwd", 400],
    ["an option", app, "--output=" + marker, 404],
    ["an option that looks like a flag with a value", app, "-p", 404],
    ["pathspec magic", app, ":(glob)**", 404],
    ["a glob", app, "*", 404],
    ["a shell substitution", app, "$(touch " + marker + ")", 404],
    ["backticks", app, "`touch " + marker + "`", 404],
    ["a semicolon", app, "a.txt; touch " + marker, 404],
    ["a newline", app, "a.txt\ntouch " + marker, 400],
    ["a NUL", app, "a.txt\0x", 400],
    ["a quote", app, "a.txt' ; touch " + marker + " ; echo '", 404],
    ["a repository outside the root", "/etc", "passwd", 400],
    ["a repository by traversal", path.join(root, "app", "..", "..", "etc"), "passwd", 400],
    ["a repository with shell text (a well-formed path nobody listed)", app + "; touch " + marker, "a.txt", 404],
    ["a repository that is not listed but exists", path.join(root, "app", ".git"), "config", 404],
    ["a relative repository", "app", "a.txt", 400],
  ];
  stub.commands.length = 0;
  for (const [label, repoParam, fileParam, status] of bad) {
    const r = await patch(repoParam, fileParam);
    assert.equal(r.status, status, `${label}: ${r.raw}`);
    assert.equal(r.body.ok, false, label);
  }
  assert.equal(fs.existsSync(marker), false, "no command of the caller's ran");
  // Every command the sandbox was given was one of the two scripts, with the listing's own paths.
  const patchCommands = stub.commands.filter((c) => c.command.includes("@@PATCH"));
  assert.equal(patchCommands.length, 0, "no patch command was built for any of those");
  for (const c of stub.commands) {
    assert.equal(c.command.includes("touch"), false, c.command);
    assert.equal(c.command.includes("/etc/passwd"), false);
  }
});

test("C8 a changed file whose NAME is shell text is diffed as a name, quoted, and nothing runs", async () => {
  await seed();
  const app = repo("app", { "keep.txt": "k\n" });
  const nasty = ["$(touch pwned).txt", "`touch pwned2`.txt", "a'b; touch pwned3 ;'.txt", "-p", "--output=pwned4", ":(top)x", "sp ace\ttab.txt"];
  for (const n of nasty) write(path.join(app, n), `content of ${n.length}\n`);
  git(app, "add", "-N", ...nasty.filter((n) => !n.startsWith("-") && !n.startsWith(":")));   // some tracked-as-intent, some untracked
  const listed = (await changes()).body.repos[0].files.map((f: any) => f.path);
  assert.deepEqual([...listed].sort(), [...nasty, "keep.txt"].filter((n) => n !== "keep.txt").sort());
  for (const n of nasty) {
    const r = await patch(app, n);
    assert.equal(r.status, 200, `${n}: ${r.raw}`);
    assert.match(r.body.patch, /content of \d+/, n);
  }
  for (const f of ["pwned", "pwned2", "pwned3", "pwned4"]) assert.equal(fs.existsSync(path.join(app, f)), false, f);
  assert.equal(fs.existsSync(path.join(root, "pwned")), false);
});

test("C8 the scripts the sandbox is given take only the listing's paths, quoted, after --, with literal pathspecs", async () => {
  await seed();
  const app = repo("app", { "a.txt": "a\n" });
  write(path.join(app, "a.txt"), "a\nb\n");
  stub.commands.length = 0;
  await patch(app, "a.txt");
  const [listing, one] = stub.commands.map((c) => c.command);
  assert.ok(listing.includes("GIT_LITERAL_PATHSPECS=1") && listing.includes("GIT_OPTIONAL_LOCKS=0"));
  assert.ok(one.includes(`-C '${app}'`) && one.includes("-- 'a.txt'"), one);
  assert.ok(one.includes("GIT_LITERAL_PATHSPECS=1"));
  assert.ok(one.includes("--no-ext-diff") && one.includes("--no-textconv"));
  assert.deepEqual(stub.commands.map((c) => c.timeout), [45, 30]);
});

// ---- C9 read-only -------------------------------------------------------------------------------

test("C9 asking changes nothing: the index, the work tree and the objects are as they were", async () => {
  await seed();
  const app = repo("app", { "a.txt": "a\n" });
  write(path.join(app, "a.txt"), "a\nb\n");
  write(path.join(app, "u.txt"), "u\n");
  git(app, "add", "a.txt");
  write(path.join(app, "a.txt"), "a\nb\nc\n");
  const snapshot = () => ({
    status: git(app, "status", "--porcelain=v2"),
    index: fs.readFileSync(path.join(app, ".git", "index")).toString("hex"),
    mtimes: fs.readdirSync(path.join(app, ".git")).sort().join(","),
    files: fs.readdirSync(app).sort().join(","),
  });
  const before = snapshot();
  for (let i = 0; i < 3; i++) { await changes(); await patch(app, "a.txt"); await patch(app, "u.txt"); }
  assert.deepEqual(snapshot(), before);
  assert.equal(fs.existsSync(path.join(app, ".git", "index.lock")), false);
});

test("C9 it does not fight the agent's own git: an index lock held by another process does not stop the summary", async () => {
  await seed();
  const app = repo("app", { "a.txt": "a\n" });
  write(path.join(app, "a.txt"), "a\nb\n");
  fs.writeFileSync(path.join(app, ".git", "index.lock"), "");
  const r = await changes();
  assert.equal(r.status, 200, r.raw);
  assert.deepEqual(r.body.repos[0].files.map((f: any) => f.path), ["a.txt"]);
  assert.equal(fs.existsSync(path.join(app, ".git", "index.lock")), true, "the other process's lock is untouched");
});

test("C9 two callers asking at once share one run in the sandbox", async () => {
  await seed();
  const app = repo("app", { "a.txt": "a\n" });
  write(path.join(app, "a.txt"), "a\nb\n");
  stub.commands.length = 0;
  const [x, y, z] = await Promise.all([changes(), changes(), changes()]);
  assert.equal(x.status, 200); assert.equal(y.status, 200); assert.equal(z.status, 200);
  assert.deepEqual(x.body.repos, y.body.repos);
  assert.equal(stub.commands.length, 1, "one listing served three requests");
});

// ---- failures that are not "not running" -------------------------------------------------------

test("C10 more than two patch requests at once for a session: the extra is asked to wait with a 429, and the slot comes back", async () => {
  await seed();
  const app = repo("app", { "a.txt": "a\n" });
  write(path.join(app, "a.txt"), "a\nb\n");
  const real = changesPorts.exec;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  changesPorts.exec = (async (t: never, command: string, timeout: number) => {
    if (command.includes("@@PATCH")) await gate;
    return real(t, command, timeout);
  }) as typeof changesPorts.exec;
  try {
    const inflight = [patch(app, "a.txt"), patch(app, "a.txt")];
    // Let the two reach the gate before the third asks.
    for (let i = 0; i < 200 && stub.commands.filter((c) => !c.command.includes("@@PATCH")).length < 1; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 300));
    const third = await patch(app, "a.txt");
    assert.deepEqual([third.status, third.body], [429, { ok: false, error: "too_many_requests" }]);
    release();
    for (const r of await Promise.all(inflight)) assert.equal(r.status, 200);
    assert.equal((await patch(app, "a.txt")).status, 200, "the slots were given back");
  } finally {
    release();
    changesPorts.exec = real;
  }
});

test("C11 a sandbox that answered but could not do it is a 502, not a 409 and not a 500", async () => {
  await seed();
  const app = repo("app", { "a.txt": "a\n" });
  write(path.join(app, "a.txt"), "a\nb\n");
  const real = changesPorts.exec;
  const cases: Array<[string, typeof changesPorts.exec]> = [
    ["the script exited non-zero", (async () => ({ text: "exit 127\nstdout: \nstderr: git: not found", isError: true })) as never],
    ["something other than a connection failed", (async () => { throw new Error("boom"); }) as never],
  ];
  for (const [label, exec] of cases) {
    changesPorts.exec = exec;
    for (const q of ["", `?repo=${encodeURIComponent(app)}&file=a.txt`]) {
      const r = await changes(q);
      assert.deepEqual([r.status, r.body], [502, { ok: false, error: "changes_unavailable" }], `${label} ${q}`);
    }
  }
  // The listing works but the patch command fails, or prints nothing at all.
  changesPorts.exec = (async (t: never, command: string, timeout: number) => (
    command.includes("@@PATCH") ? { text: "", isError: false } : real(t, command, timeout)
  )) as never;
  assert.equal((await patch(app, "a.txt")).status, 502);
  changesPorts.exec = (async (t: never, command: string, timeout: number) => (
    command.includes("@@PATCH") ? { text: "exit 1", isError: true } : real(t, command, timeout)
  )) as never;
  assert.equal((await patch(app, "a.txt")).status, 502);
  changesPorts.exec = (async (t: never, command: string, timeout: number) => {
    if (command.includes("@@PATCH")) throw new (await import("../src/sessions/hands-exec.js")).SandboxUnreachableError("gone between the two calls");
    return real(t, command, timeout);
  }) as never;
  assert.deepEqual((await patch(app, "a.txt")).body, { ok: false, error: "sandbox_not_running" }, "a sandbox that goes away between the two calls");
  changesPorts.exec = real;
  // Unparseable output from a sandbox that said it succeeded is an empty listing, not an error.
  changesPorts.exec = (async () => ({ text: "garbage\nmore garbage", isError: false })) as never;
  const empty = await changes();
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.repos, []);
  changesPorts.exec = real;
});

test("C12 a registry entry that goes away after the listing is a 409 for the patch, and a request for an unlisted file never gets that far", async () => {
  await seed();
  const app = repo("app", { "a.txt": "a\n" });
  write(path.join(app, "a.txt"), "a\nb\n");
  let reads = 0;
  const realRead = changesPorts.readTarget;
  changesPorts.readTarget = async (sid: string) => (++reads === 1 ? realRead.call(changesPorts, sid) : null);
  try {
    const r = await patch(app, "a.txt");
    assert.deepEqual([r.status, r.body], [409, { ok: false, error: "sandbox_not_running" }]);
  } finally {
    changesPorts.readTarget = realRead;
  }
});
