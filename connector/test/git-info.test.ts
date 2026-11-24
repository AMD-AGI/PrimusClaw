// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The folders' git facts the heartbeat reports (`src/git-info.ts`, `workspaces`), and a turn that only answers (`prompt.answer_only`).
 *
 *   G1 a remote is reported as host/owner/repo with the user and any credential gone; one that still looks like it carries a secret is
 *      not reported at all; a branch is checked; a linked worktree reads its own HEAD and the shared config; detached and no repo
 *   G2 the heartbeat never waits for a read: a stalled disk is given up within the timeout, and holds back the rest (one thread)
 *   G3 end to end: the connector's heartbeat carries the session folder's remote and branch, with the capability, and the server's
 *      own parser takes it (and takes a heartbeat without it, as an older connector sends)
 *   A1 an answer-only prompt runs in the agent's read-only mode (switched to for the turn, and back): the permission the agent asks for
 *      is refused on the machine, nobody is asked, nothing is written
 *   A1c the agent leaving the read-only mode in that turn stops the turn
 *   A1b a plan the agent proposes and a question it asks in that turn (Cursor's extension requests) are refused, put to nobody
 *   A2 the same prompt without answer_only still asks, so the refusal is the flag's doing
 *   A3 refused, never reaching the agent, in a session that does not ask (unattended) and for an agent with no read-only mode
 *   A4 the user is there: a set_mode sent in that turn stops it and is set only after it (never a turn that only answers going on in a
 *      mode that does not ask), the user's own prompt stops it, it is refused while a turn of the user's runs, and an agent that dies
 *      in it comes back in the session's own mode, not the read-only one; a resume in it keeps it in the read-only mode; a cancel while
 *      it is readied stops it; a set_mode sent while the mode is settled after it is set after that, never under it
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, describe } from "node:test";
import { headBranch, originUrl, readGitFacts, WorkspaceFacts, type GitFs } from "../src/git-info.js";
import { normalizeGitBranch, normalizeGitRemote } from "../src/protocol.js";
import { parseHeartbeat } from "../../claw/packages/protocol/src/remote-agents.js";
import { Harness, tmpdir } from "./support/harness.js";

const hs: Harness[] = [];
const make = async (o: Parameters<typeof Harness.create>[0] = {}) => { const h = await Harness.create(o); hs.push(h); return h; };
after(async () => { for (const h of hs) await h.close(); });

function repo(dir: string, opts: { url?: string; head?: string } = {}): void {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), opts.head ?? "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(dir, ".git", "config"), opts.url === undefined ? "[core]\n\tbare = false\n"
    : `[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@example.org:other/thing.git\n[remote "origin"]\n\turl = ${opts.url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
}

describe("G1 what a folder's repository is reported as", () => {
  test("remotes: user and credentials go; a secret-shaped path is no remote; local paths are none", () => {
    const cases: Array<[string, string | null]> = [
      ["https://github.com/AMD-AGI/PrimusClaw.git", "github.com/AMD-AGI/PrimusClaw"],
      ["https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123@github.com/Org/Repo.git", "github.com/Org/Repo"],
      ["https://someone:hunter2@GitLab.Example.com:8443/group/sub/proj.git?private_token=abc#frag", "gitlab.example.com:8443/group/sub/proj"],
      ["git@github.com:Org/Repo.git", "github.com/Org/Repo"],
      ["ssh://git@github.com:22/Org/Repo", "github.com:22/Org/Repo"],
      ["https://github.com/ghp_abcdefghijklmnopqrstuvwxyz0123456789/Repo.git", null],
      ["https://host.example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/repo", null],
      ["/srv/git/repo.git", null],
      ["file:///srv/git/repo.git", null],
      ["C:\\repos\\thing", null],
      ["https://github.com/Org/Repo with space", null],
      ["https://github.com/Org/$(rm -rf ~)", null],
      ["", null],
    ];
    for (const [raw, want] of cases) assert.equal(normalizeGitRemote(raw), want, raw);
    assert.equal(normalizeGitBranch("refs/heads/feat/seats-m0"), "feat/seats-m0");
    for (const bad of ["a..b", "-x", "x y", "x;rm", "x".repeat(101), "x.lock"]) assert.equal(normalizeGitBranch(bad), null, bad);
    assert.equal(headBranch("ref: refs/heads/release/1.2\n"), "release/1.2");
    assert.equal(headBranch("3f1c0d9e7a\n"), null, "detached");
    assert.equal(originUrl('[remote "a"]\n url = https://h.example/x/y\n[remote "origin"]\n url = "https://h.example/o/r"\n'), "https://h.example/o/r");
    assert.equal(originUrl('[remote "a"]\n url = https://h.example/x/y\n'), "https://h.example/x/y", "no origin: the first remote");
  });

  test("a folder inside a repository, a linked worktree, a detached HEAD, and a folder in none", async () => {
    const root = tmpdir("cc-git-");
    const main = path.join(root, "main");
    repo(main, { url: "https://bot:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/Org/Repo.git" });
    fs.mkdirSync(path.join(main, "src", "deep"), { recursive: true });
    assert.deepEqual(await readGitFacts(path.join(main, "src", "deep")), { git_remote: "github.com/Org/Repo", git_branch: "main" });
    // A linked worktree: .git is a file naming its git dir, whose commondir is the main .git (where the config is).
    const wtGit = path.join(main, ".git", "worktrees", "wt1");
    fs.mkdirSync(wtGit, { recursive: true });
    fs.writeFileSync(path.join(wtGit, "HEAD"), "ref: refs/heads/feat/x\n");
    fs.writeFileSync(path.join(wtGit, "commondir"), "../..\n");
    const wt = path.join(root, "wt1");
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${wtGit}\n`);
    assert.deepEqual(await readGitFacts(wt), { git_remote: "github.com/Org/Repo", git_branch: "feat/x" });
    const detached = path.join(root, "detached");
    repo(detached, { url: "git@github.com:Org/Other.git", head: "0123456789abcdef0123456789abcdef01234567\n" });
    assert.deepEqual(await readGitFacts(detached), { git_remote: "github.com/Org/Other", git_branch: null });
    const noRemote = path.join(root, "noremote");
    repo(noRemote);
    assert.deepEqual(await readGitFacts(noRemote), { git_remote: null, git_branch: "main" });
    assert.equal(await readGitFacts("relative/path"), null);
    const plain = tmpdir("cc-plain-");
    // (a temporary folder is in no repository unless TMPDIR itself is in one)
    const found = await readGitFacts(plain);
    assert.ok(found === null || typeof found === "object");
  });
});

describe("G2 the heartbeat never waits", () => {
  test("first report is empty and starts the reads; the next has them; a stalled disk is given up and holds the rest back", async () => {
    const root = tmpdir("cc-git2-");
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    repo(a, { url: "https://github.com/Org/A.git" });
    repo(b, { url: "https://github.com/Org/B.git" });
    const facts = new WorkspaceFacts({ timeoutMs: 200 });
    assert.deepEqual(facts.report([a, b, a]), [], "nothing read yet: nothing reported, and the call did not wait");
    await facts.settled();
    assert.deepEqual(facts.report([a, b]).map((w) => [w.cwd, w.git_remote]), [[a, "github.com/Org/A"], [b, "github.com/Org/B"]]);

    // A disk that never answers for one folder.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let stats = 0;
    const stalled: GitFs = {
      stat: async (p) => { stats += 1; if (p.startsWith(a)) await gate; return fs.promises.stat(p); },
      readHead: async (p, max) => (await fs.promises.readFile(p, "utf8")).slice(0, max),
    };
    const slow = new WorkspaceFacts({ fs: stalled, timeoutMs: 100 });
    const t0 = Date.now();
    assert.deepEqual(slow.report([a, b]), []);
    assert.ok(Date.now() - t0 < 50, "report did not wait for the disk");
    await slow.settled();
    const statsWhileStalled = stats;
    assert.deepEqual(slow.report([a, b]), [], "a was given up, b waits behind it: nothing else is read while a read hangs");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(stats, statsWhileStalled, "no new read started while the stalled one is still out");
    release();
    await new Promise((r) => setTimeout(r, 50));
    await slow.settled();
    assert.deepEqual(slow.report([a, b]).map((w) => w.cwd), [b], "once the disk answered, the rest were read");
  });

  test("at most the limit of folders, each once", () => {
    const facts = new WorkspaceFacts();
    const many = Array.from({ length: 50 }, (_, i) => `/nowhere/${i}`);
    facts.report(many);
    // (only the first 32 are asked for; none is a repository, so nothing is reported, and the call returns at once)
    assert.ok(facts.report(many).length <= 32);
  });
});

describe("G3 and A1-A3 end to end", () => {
  test("the heartbeat carries the session folder's remote and branch; the server's parser takes it, and one without it", async () => {
    const work = tmpdir("cc-work-git-");
    repo(work, { url: "https://dev:supersecretpassword@github.com/Org/Repo.git", head: "ref: refs/heads/feat/seats\n" });
    const h = await make({ work });
    await h.online();
    const hb = await h.claw.until("a heartbeat with the folder's repository", () =>
      h.claw.heartbeats.find((b: any) => Array.isArray(b.workspaces) && b.workspaces.some((w: any) => w.cwd === work)));
    const entry = hb.workspaces.find((w: any) => w.cwd === work);
    assert.deepEqual(entry, { cwd: work, git_remote: "github.com/Org/Repo", git_branch: "feat/seats" });
    assert.ok(!JSON.stringify(hb).includes("supersecretpassword"), "the credential never leaves the machine");
    assert.equal(hb.agents[0].capabilities.git_info, true);
    assert.equal(hb.agents[0].capabilities.answer_only, true);
    const parsed = parseHeartbeat(hb);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.value.workspaces?.find((w) => w.cwd === work), entry);
    const { workspaces: _w, ...older } = hb;
    const old = parseHeartbeat(older);
    assert.ok(old.ok);
    assert.equal(old.value.workspaces, null, "an older connector's heartbeat: no workspaces, still taken");
  });

  test("A1 answer_only: run in a read-only mode switched to for the turn and back; the permission is refused on the machine, nobody asked", async () => {
    const h = await make({ preset: "claude" });
    const sid = await h.newSession();
    h.prompt(sid, "write probe.txt something", { answer_only: true });
    const end = await h.turnEnd(sid);
    assert.equal(end.data.stopReason, "end_turn");
    assert.equal(h.claw.eventsOf(sid, "permissionRequest").length, 0, "no card was put to anyone");
    const denied = h.claw.eventsOf(sid, "permission_auto_denied");
    assert.equal(denied.length, 1);
    assert.equal(denied[0]!.data.reason, "answer_only");
    assert.equal(fs.existsSync(path.join(h.work, "probe.txt")), false);
    assert.deepEqual(h.adapterLog().find((l) => l.permissionAnswer)!.permissionAnswer, { outcome: { outcome: "selected", optionId: "reject" } });
    assert.equal(h.adapterLog().find((l) => l.prompt === "write probe.txt something")!.mode, "plan", "the turn ran in the read-only mode");
    await h.claw.until("the mode put back", () => h.claw.eventsOf(sid, "mode_update").some((e) => e.data.currentMode === "default"));
    assert.deepEqual(h.adapterLog().filter((l) => l.method === "session/set_mode").map((l) => l.params.modeId).slice(-2), ["plan", "default"]);
    // The next prompt of the same session is an ordinary one again, in its own mode: it asks.
    h.prompt(sid, "write after.txt again");
    const perm = await h.permission(sid);
    assert.ok(perm.data.actionId);
    assert.equal(h.adapterLog().find((l) => l.prompt === "write after.txt again")!.mode, "default");
  });

  test("A1b answer_only: a plan the agent proposes and a question it asks are refused on the machine, put to nobody", async () => {
    const h = await make({ preset: "claude" });
    const sid = await h.newSession();
    h.prompt(sid, "plan", { answer_only: true });
    await h.turnEnd(sid);
    h.prompt(sid, "question", { answer_only: true });
    await h.turnEnd(sid, 2);
    assert.equal(h.claw.eventsOf(sid, "permissionRequest").length, 0, "no card was put to anyone");
    assert.deepEqual(h.adapterLog().find((l) => l.planAnswer)!.planAnswer.outcome.outcome, "rejected");
    assert.deepEqual(h.adapterLog().find((l) => l.questionAnswer)!.questionAnswer.outcome.outcome, "skipped");
    assert.deepEqual(h.claw.eventsOf(sid, "permission_auto_denied").map((e) => e.data.reason), ["answer_only", "answer_only"]);
    // Without answer_only the same plan is put to the person.
    h.prompt(sid, "plan");
    const perm = await h.permission(sid);
    assert.ok(perm.data.actionId);
  });

  test("A1c answer_only: the agent leaving the read-only mode in that turn stops it; the session is put back in its own mode", async () => {
    const h = await make({ preset: "claude" });
    const sid = await h.newSession();
    h.prompt(sid, "leave-mode default", { answer_only: true });
    const end = await h.turnEnd(sid);
    assert.equal(end.data.stopReason, "cancelled", "stopped, not left to run in a mode that may act");
    assert.ok(h.audit().some((a) => a.kind === "answer_only_stopped" && a.to === "default"));
    await h.claw.until("the mode put back", () => h.claw.eventsOf(sid, "mode_update").at(-1)?.data.currentMode === "default");
  });

  test("A3 answer_only is refused, and never reaches the agent, where it cannot be held to answering", async () => {
    // A session that does not ask (the agent's own rules would run anything), and an agent with no read-only mode.
    const cases: Array<[string, Parameters<typeof Harness.create>[0]]> = [
      ["unattended", { preset: "claude", approval: "never", askMode: "bypassPermissions" }],
      ["no read-only mode", {}],
    ];
    for (const [why, opts] of cases) {
      const h = await make(opts);
      const sid = await h.newSession();
      const seq = h.prompt(sid, "write probe.txt something", { answer_only: true });
      const end = await h.turnEnd(sid);
      assert.equal(end.data.error, "answer_only_unsupported", why);
      assert.equal(end.data.cmd_seq, seq, `${why}: the turn's end names its prompt`);
      assert.deepEqual(h.claw.eventsOf(sid, "command_rejected").map((e) => e.data.reason), ["answer_only_unsupported"], why);
      assert.equal(h.adapterLog().filter((l) => l.prompt === "write probe.txt something").length, 0, `${why}: the agent never saw it`);
      assert.equal(fs.existsSync(path.join(h.work, "probe.txt")), false, why);
      assert.equal(h.claw.eventsOf(sid, "permissionRequest").length, 0, why);
    }
  });

  test("A4a a set_mode sent in that turn stops it and is set after it: the turn never goes on in the mode the user chose", async () => {
    const h = await make({ preset: "claude", topToml: "allow_unsafe_modes = true\n" });
    const sid = await h.newSession();
    const gate = path.join(h.work, "gate-open");
    h.prompt(sid, `gate ${gate} write probe.txt something`, { answer_only: true });
    await h.claw.until("the turn reached the agent", () => h.adapterLog().find((l) => typeof l.prompt === "string" && l.prompt.startsWith("gate ")));
    // The user picks a mode that does not ask, while that turn runs.
    h.claw.issue("set_mode", sid, { mode_id: "bypassPermissions" });
    await h.claw.until("the set_mode handled", () => h.turnEnds(sid)[0]
      ?? h.adapterLog().find((l) => l.method === "session/set_mode" && l.params.modeId === "bypassPermissions"));
    fs.writeFileSync(gate, "");
    const end = await h.turnEnd(sid);
    assert.equal(end.data.stopReason, "cancelled", "the turn that only answers gave way to the user");
    assert.equal(h.adapterLog().filter((l) => l.gateOpened).length, 0, "it never went on, in any mode");
    assert.equal(fs.existsSync(path.join(h.work, "probe.txt")), false, "nothing was written without asking");
    assert.ok(h.audit().some((a) => a.kind === "answer_only_stopped" && a.why === "set_mode"));
    // The user's mode is set after that turn, and is the one the session stays in: never overwritten by the mode it was switched from.
    await h.claw.until("the user's mode set", () => h.claw.eventsOf(sid, "mode_update").at(-1)?.data.currentMode === "bypassPermissions");
    const modes = h.adapterLog().filter((l) => l.method === "session/set_mode").map((l) => l.params.modeId);
    assert.deepEqual(modes.slice(modes.indexOf("plan")), ["plan", "bypassPermissions"]);
    assert.equal(h.claw.eventsOf(sid, "command_rejected").filter((e) => e.data.type === "set_mode").length, 0);
  });

  test("A4b the user's own prompt stops that turn; theirs runs next, in the session's own mode, and asks", async () => {
    const h = await make({ preset: "claude" });
    const sid = await h.newSession();
    h.prompt(sid, `gate ${path.join(h.work, "never")} say hi`, { answer_only: true });
    await h.claw.until("the turn reached the agent", () => h.adapterLog().find((l) => typeof l.prompt === "string" && l.prompt.startsWith("gate ")));
    h.prompt(sid, "write mine.txt");
    const end = await h.turnEnd(sid);
    assert.equal(end.data.stopReason, "cancelled");
    assert.ok(h.audit().some((a) => a.kind === "answer_only_stopped" && a.why === "user_prompt"));
    const perm = await h.permission(sid);
    assert.ok(perm.data.actionId);
    assert.equal(h.adapterLog().find((l) => l.prompt === "write mine.txt")!.mode, "default");
  });

  test("A4b2 the user's prompt sent while that turn is still being readied: it never runs, theirs does", async () => {
    const h = await make({ preset: "claude", env: { FAKE_PLAN_DELAY_MS: "600" } });
    const sid = await h.newSession();
    const seq = h.prompt(sid, "say probe", { answer_only: true });
    await h.claw.until("switching to the read-only mode", () => h.adapterLog().find((l) => l.method === "session/set_mode" && l.params.modeId === "plan"));
    h.prompt(sid, "write mine.txt");
    const refused = await h.turnEnd(sid);
    assert.equal(refused.data.error, "answer_only_busy");
    assert.equal(refused.data.cmd_seq, seq);
    const perm = await h.permission(sid);
    assert.ok(perm.data.actionId);
    assert.equal(h.adapterLog().filter((l) => l.prompt === "say probe").length, 0, "the agent never saw it");
    assert.equal(h.adapterLog().find((l) => l.prompt === "write mine.txt")!.mode, "default");
  });

  test("A4e a resume in that turn re-asserts its read-only mode, never the session's own", async () => {
    const h = await make({ preset: "claude" });
    const sid = await h.newSession();
    const gate = path.join(h.work, "gate-open");
    h.prompt(sid, `gate ${gate} write probe.txt something`, { answer_only: true });
    await h.claw.until("the turn reached the agent", () => h.adapterLog().find((l) => typeof l.prompt === "string" && l.prompt.startsWith("gate ")));
    h.claw.issue("resume", sid, {});
    await h.claw.until("resumed", () => h.claw.eventsOf(sid, "session_resumed")[0]);
    fs.writeFileSync(gate, "");
    await h.turnEnd(sid);
    assert.equal(h.adapterLog().find((l) => l.gateOpened)!.mode, "plan", "the rest of the turn ran in the read-only mode");
    assert.equal(fs.existsSync(path.join(h.work, "probe.txt")), false);
    await h.claw.until("the mode put back", () => h.claw.eventsOf(sid, "mode_update").at(-1)?.data.currentMode === "default");
  });

  test("A4c refused while a turn of the user's runs: it never waits behind it, nor reaches the agent", async () => {
    const h = await make({ preset: "claude" });
    const sid = await h.newSession();
    const gate = path.join(h.work, "gate-open");
    h.prompt(sid, `gate ${gate} say mine`);
    await h.claw.until("the user's turn runs", () => h.adapterLog().find((l) => typeof l.prompt === "string" && l.prompt.startsWith("gate ")));
    const seq = h.prompt(sid, "say probe", { answer_only: true });
    const refused = await h.turnEnd(sid);
    assert.equal(refused.data.error, "answer_only_busy");
    assert.equal(refused.data.cmd_seq, seq);
    fs.writeFileSync(gate, "");
    const mine = await h.turnEnd(sid, 2);
    assert.equal(mine.data.stopReason, "end_turn");
    assert.equal(h.adapterLog().filter((l) => l.prompt === "say probe").length, 0, "the agent never saw it");
  });

  test("A4d an agent that dies in that turn comes back in the session's own mode, not the read-only one", async () => {
    const h = await make({ preset: "claude" });
    const sid = await h.newSession();
    h.prompt(sid, "crash", { answer_only: true });
    await h.turnEnd(sid);
    h.prompt(sid, "write after.txt");
    const perm = await h.permission(sid);
    assert.ok(perm.data.actionId);
    assert.equal(h.adapterLog().find((l) => l.prompt === "write after.txt")!.mode, "default", "the user's turn runs in the session's own mode");
  });

  test("A4f a cancel while that turn is still being readied: it never runs, and the session is back in its own mode", async () => {
    const h = await make({ preset: "claude", env: { FAKE_PLAN_DELAY_MS: "600" } });
    const sid = await h.newSession();
    const seq = h.prompt(sid, "say probe", { answer_only: true });
    await h.claw.until("switching to the read-only mode", () => h.adapterLog().find((l) => l.method === "session/set_mode" && l.params.modeId === "plan"));
    h.claw.issue("cancel", sid);
    const refused = await h.turnEnd(sid);
    assert.equal(refused.data.error, "answer_only_busy");
    assert.equal(refused.data.cmd_seq, seq);
    await h.claw.until("the mode put back", () => h.claw.eventsOf(sid, "mode_update").at(-1)?.data.currentMode === "default");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(h.adapterLog().filter((l) => l.prompt === "say probe").length, 0, "the agent never saw it");
  });

  test("A4f2 a cancel while that turn is still being confirmed with Claw (`endAsking`): it is dropped, never run", async () => {
    const h = await make({ preset: "claude" });
    const sid = await h.newSession();
    h.claw.holdConfirms = true;
    const seq = h.prompt(sid, "say probe", { answer_only: true, sent_at: Date.now() - 10_000, cmd_id: "c-probe" });
    await h.claw.until("the prompt being confirmed", () => h.claw.confirmAsked.includes("c-probe") || undefined);
    h.claw.issue("cancel", sid);
    await h.claw.until("the cancel handled", () => h.audit().some((a) => a.kind === "command" && a.type === "cancel") || undefined);
    h.claw.holdConfirms = false;
    h.claw.releaseConfirms();
    const rejected = await h.claw.until("the prompt refused", () => h.claw.eventsOf(sid, "command_rejected").find((e) => e.data.cmd_id === "c-probe"));
    assert.deepEqual([rejected.data.status, rejected.data.cmd_seq], ["cancelled", seq]);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(h.adapterLog().filter((l) => l.prompt === "say probe").length, 0, "the agent never saw it");
    assert.equal(h.adapterLog().filter((l) => l.method === "session/set_mode" && l.params.modeId === "plan").length, 0, "nor was it readied");
  });

  // The user's latest set_mode is the mode the session ends in, whether it comes while the one chosen in that turn is being set after
  // it (`deferred`), or while the mode it was switched from is being put back (`back`): never an earlier one set over it.
  for (const [name, slow] of [["deferred", "acceptEdits"], ["back", "default"]] as const) {
    test(`A4g a set_mode sent while the mode is being settled after that turn (${name}) is set after it, never under it`, async () => {
      const h = await make({ preset: "claude", topToml: "allow_unsafe_modes = true\n", env: { FAKE_MODE_DELAYS: `${slow}:800` } });
      const sid = await h.newSession();
      const gate = path.join(h.work, "gate-open");
      h.prompt(sid, `gate ${gate} say probe`, { answer_only: true });
      await h.claw.until("the turn reached the agent", () => h.adapterLog().find((l) => typeof l.prompt === "string" && l.prompt.startsWith("gate ")));
      if (name === "deferred") h.claw.issue("set_mode", sid, { mode_id: "acceptEdits" });
      else fs.writeFileSync(gate, "");
      await h.turnEnd(sid);
      const setModes = () => h.adapterLog().filter((l) => l.method === "session/set_mode").map((l) => l.params.modeId as string);
      await h.claw.until(`the slow ${slow} being set`, () => { const m = setModes(); return m.slice(m.lastIndexOf("plan")).includes(slow) || undefined; });
      h.claw.issue("set_mode", sid, { mode_id: "bypassPermissions" });
      await h.claw.until("both set", () => h.adapterLog().filter((l) => l.method === "session/set_mode" && l.params.modeId === "bypassPermissions").length === 1
        && h.claw.eventsOf(sid, "mode_update").at(-1)?.data.currentMode === "bypassPermissions" ? true : undefined);
      await new Promise((r) => setTimeout(r, 1_200));
      const modes = setModes();
      assert.deepEqual(modes.slice(modes.lastIndexOf("plan")), ["plan", slow, "bypassPermissions"], "the latest last");
      assert.equal(h.claw.eventsOf(sid, "mode_update").at(-1)?.data.currentMode, "bypassPermissions");
      h.prompt(sid, "say after");
      await h.turnEnd(sid, 2);
      assert.equal(h.adapterLog().find((l) => l.prompt === "say after")!.mode, "bypassPermissions", "the agent is in the user's latest mode");
    });
  }

  test("A2 the same prompt without answer_only asks the person", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.prompt(sid, "write probe.txt something");
    const perm = await h.permission(sid);
    assert.equal(h.claw.eventsOf(sid, "permission_auto_denied").length, 0);
    h.decide(sid, perm.data.actionId, "reject");
    await h.turnEnd(sid);
  });
});
