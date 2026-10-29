// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The repository binding, run for real: the commands `bindRepo` sends are executed
 * by bash against the git on this machine, with a local bare repository standing in
 * for the remote (a `url.<local>.insteadOf` in the sandbox's global git config makes
 * the https url resolve to it). Nothing here is a stand-in for the commands
 * themselves, so a quoting slip, a wrong flag or a step that discards work shows up
 * as a wrong file system, not as a green string comparison.
 *
 *   G1 absent: cloned, plain url in .git/config, default branch, helper set once
 *   G2 absent + branch: on that branch, tracking the remote; a missing branch leaves the default and says so
 *   G3 .git already there: fetch only. Local commit, other branch and uncommitted edits survive
 *   G4 the same sandbox, next turn: no fetch, no clone
 *   G5 files but no .git: the repository is attached, the files stay as local changes
 *   G6 somebody else's repository under the same name: untouched
 *   G7 a clone that fails: a reason, no directory, no leftover, no throw
 *   G8 the instructions: size cap with a marker, symlinks, dedupe, a link out of the repository
 *   G9 no credential anywhere: not in a command, not in .git/config
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bindRepo, renderRepoBlock, REPO_INSTRUCTIONS_MAX_BYTES, REPO_TRUNCATION_MARKER, GIT_CREDENTIAL_HELPER } from "../src/workspace/repo-binding.js";

const FAKE_TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
const URL_BASE = "https://git.example.invalid/example-org";
const REPO_URL = `${URL_BASE}/example-repo.git`;

let world: string;
let remote: string;
let home: string;
const runRaw = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv(), stdio: ["ignore", "pipe", "ignore"] });
const run = (cwd: string, ...args: string[]) => runRaw(cwd, ...args).trim();
/** The url as stored in .git/config. `remote get-url` would apply the insteadOf rewrite the test relies on. */
const storedOrigin = (dir: string) => run(dir, "config", "--get", "remote.origin.url");

function gitEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
}

before(() => {
  world = fs.mkdtempSync(path.join(os.tmpdir(), "claw-repo-binding-"));
  home = path.join(world, "home");
  fs.mkdirSync(home);
  remote = path.join(world, "remote.git");
  run(world, "init", "--bare", "-b", "main", remote);
  const seed = path.join(world, "seed");
  run(world, "clone", "-q", remote, seed);
  fs.writeFileSync(path.join(seed, "README.md"), "# example\n");
  fs.writeFileSync(path.join(seed, "app.txt"), "one\n");
  run(seed, "add", "-A");
  run(seed, "commit", "-q", "-m", "first");
  run(seed, "push", "-q", "origin", "HEAD:main");
  run(seed, "checkout", "-q", "-b", "feature/x");
  fs.writeFileSync(path.join(seed, "feature.txt"), "feature\n");
  run(seed, "add", "-A");
  run(seed, "commit", "-q", "-m", "feature");
  run(seed, "push", "-q", "origin", "feature/x");
  // The sandbox's own global git config: the https name resolves to the local remote.
  fs.writeFileSync(path.join(home, ".gitconfig"), [
    `[url "file://${remote.replace(/\.git$/, "")}"]`,
    `\tinsteadOf = ${URL_BASE}/example-repo`,
    `[url "file://${path.join(world, "nowhere")}"]`,
    `\tinsteadOf = ${URL_BASE}/missing`,
    "",
  ].join("\n"));
});

after(() => { fs.rmSync(world, { recursive: true, force: true }); });

interface Sandbox { root: string; state: string; calls: string[]; hands: { callToolFull(n: string, a: Record<string, unknown>): Promise<{ text: string; isError: boolean }> } }

/** A sandbox: its own /workspace and /tmp, and a Hands whose bash really runs. */
function sandbox(label: string): Sandbox {
  const dir = fs.mkdtempSync(path.join(world, `${label}-`));
  const root = path.join(dir, "workspace");
  const state = path.join(dir, "tmp");
  fs.mkdirSync(root);
  fs.mkdirSync(state);
  const calls: string[] = [];
  return {
    root, state, calls,
    hands: {
      async callToolFull(name, args) {
        assert.equal(name, "bash");
        const command = String(args.command);
        calls.push(command);
        const r = spawnSync("bash", ["-c", command], { encoding: "utf8", env: gitEnv() });
        const ok = r.status === 0;
        return { isError: !ok, text: ok ? r.stdout : `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}` };
      },
    },
  };
}

const bind = (s: Sandbox, repo: unknown) => bindRepo(s.hands, repo, { root: s.root, stateDir: s.state });
const verbs = (s: Sandbox) => s.calls.map((c) => (/git (clone|fetch)|git -C \S+ fetch/.exec(c) ?? [""])[0]);
const remoteHead = () => run(remote, "rev-parse", "main");

test("G1 absent: cloned, the remote in .git/config is the plain url, default branch, helper configured once", async () => {
  const s = sandbox("g1");
  const b = await bind(s, { url: REPO_URL });
  assert.equal(b.state, "cloned", JSON.stringify(b));
  assert.equal(b.failure, null);
  assert.equal(b.path, `${s.root}/example-repo`);
  assert.equal(b.branch, "main");
  assert.equal(b.head, remoteHead().slice(0, 7));
  assert.equal(b.changed, 0);
  assert.deepEqual(b.notes, []);
  assert.equal(fs.readFileSync(path.join(b.path, "README.md"), "utf8"), "# example\n");
  assert.equal(storedOrigin(b.path), REPO_URL, "the plain url, nothing added to it");
  assert.equal(fs.readdirSync(s.root).join(), "example-repo", "no temporary clone directory is left");
  assert.equal(run(world, "config", "--global", "--get-all", "credential.helper"), GIT_CREDENTIAL_HELPER);
  // A second sandbox on the same global config does not add a second helper line.
  await bind(sandbox("g1b"), { url: REPO_URL });
  assert.equal(run(world, "config", "--global", "--get-all", "credential.helper"), GIT_CREDENTIAL_HELPER);
});

test("G2 absent + branch: on that branch tracking the remote; a branch the remote lacks leaves the default and says so", async () => {
  const on = await bind(sandbox("g2a"), { url: REPO_URL, branch: "feature/x" });
  assert.equal(on.state, "cloned");
  assert.equal(on.branch, "feature/x");
  assert.equal(run(on.path, "rev-parse", "--abbrev-ref", "feature/x@{upstream}"), "origin/feature/x");
  assert.equal(fs.existsSync(path.join(on.path, "feature.txt")), true);
  assert.deepEqual(on.notes, []);

  const already = await bind(sandbox("g2b"), { url: REPO_URL, branch: "main" });
  assert.equal(already.branch, "main");
  assert.deepEqual(already.notes, []);

  const missing = await bind(sandbox("g2c"), { url: REPO_URL, branch: "no/such-branch" });
  assert.equal(missing.state, "cloned", "the repository is still there");
  assert.equal(missing.branch, "main");
  assert.equal(missing.notes.length, 1);
  assert.match(missing.notes[0], /branch no\/such-branch does not exist on the remote/);
  assert.match(renderRepoBlock(missing), /branch no\/such-branch does not exist on the remote/);
});

test("G3 a .git already there (a restored snapshot): fetch only, nothing local is discarded", async () => {
  const s = sandbox("g3");
  const first = await bind(s, { url: REPO_URL, branch: "main" });
  const dir = first.path;
  // The agent's work: its own branch, a commit on it, an edit and a new file.
  run(dir, "checkout", "-q", "-b", "claw/work");
  fs.writeFileSync(path.join(dir, "app.txt"), "one\ntwo\n");
  run(dir, "commit", "-q", "-am", "local commit");
  const localHead = run(dir, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, "app.txt"), "one\ntwo\nthree-uncommitted\n");
  fs.writeFileSync(path.join(dir, "untracked.txt"), "keep me\n");
  // The remote moves on while the sandbox is gone.
  const other = path.join(world, "other-g3");
  run(world, "clone", "-q", remote, other);
  fs.writeFileSync(path.join(other, "remote-new.txt"), "new\n");
  run(other, "add", "-A");
  run(other, "commit", "-q", "-m", "remote moves");
  run(other, "push", "-q", "origin", "HEAD:main");
  const newRemote = remoteHead();
  // A new sandbox: the workspace came back with its .git, /tmp is empty.
  const calls: string[] = [];
  const spy = { callToolFull: async (n: string, a: Record<string, unknown>) => { calls.push(String(a.command)); return s.hands.callToolFull(n, a); } };
  const second = await bindRepo(spy, { url: REPO_URL, branch: "main" }, { root: s.root, stateDir: fs.mkdtempSync(path.join(world, "g3-tmp-")) });
  assert.equal(second.state, "present", JSON.stringify(second));
  assert.equal(second.branch, "claw/work", "not switched off the branch the work was left on");
  assert.equal(run(dir, "rev-parse", "HEAD"), localHead, "the local commit is where it was");
  assert.equal(fs.readFileSync(path.join(dir, "app.txt"), "utf8"), "one\ntwo\nthree-uncommitted\n", "the uncommitted edit is intact");
  assert.equal(fs.readFileSync(path.join(dir, "untracked.txt"), "utf8"), "keep me\n");
  assert.equal(second.changed, 2, "one modified file and one untracked file");
  assert.equal(run(dir, "rev-parse", "origin/main"), newRemote, "the remote's new commit was fetched");
  assert.equal(fs.existsSync(path.join(dir, "remote-new.txt")), false, "and not merged into the working tree");
  assert.equal(calls.some((c) => /git clone/.test(c)), false, "no clone over a repository that is there");
  assert.equal(second.notes.length, 1);
  assert.match(second.notes[0], /session was started on branch main; this checkout is on claw\/work/);
  // Nothing in what was sent can discard work.
  for (const c of calls) assert.doesNotMatch(c, /reset --hard|clean |checkout -f|checkout --force|\brm -rf "\$D"|stash|pull|merge|rebase/, c);
});

test("G4 the next turn in the same sandbox: no fetch and no clone", async () => {
  const s = sandbox("g4");
  await bind(s, { url: REPO_URL });
  s.calls.length = 0;
  // The remote moves; this sandbox has already bound the repository.
  const other = path.join(world, "other-g4");
  run(world, "clone", "-q", remote, other);
  fs.writeFileSync(path.join(other, "later.txt"), "x\n");
  run(other, "add", "-A");
  run(other, "commit", "-q", "-m", "later");
  run(other, "push", "-q", "origin", "HEAD:main");
  const again = await bind(s, { url: REPO_URL });
  assert.equal(again.state, "present");
  assert.deepEqual(verbs(s).filter(Boolean), [], "neither git clone nor git fetch ran");
  assert.notEqual(run(again.path, "rev-parse", "origin/main"), remoteHead(), "so the remote's newer commit is not here yet");
});

test("G5 files but no .git: the repository is attached and the files stay, as local changes", async () => {
  const s = sandbox("g5");
  const dir = path.join(s.root, "example-repo");
  // What a snapshot taken before .git was carried leaves: every file, no .git, and an edit and a new file besides.
  const seedCopy = path.join(world, "g5-copy");
  run(world, "clone", "-q", remote, seedCopy);
  fs.rmSync(path.join(seedCopy, ".git"), { recursive: true });
  fs.renameSync(seedCopy, dir);
  fs.writeFileSync(path.join(dir, "README.md"), "# edited while there was no .git\n");
  fs.writeFileSync(path.join(dir, "extra.txt"), "mine\n");
  const b = await bind(s, { url: REPO_URL, branch: "feature/x" });
  assert.equal(b.state, "adopted", JSON.stringify(b));
  assert.equal(fs.existsSync(path.join(dir, ".git")), true);
  assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8"), "# edited while there was no .git\n");
  assert.equal(fs.readFileSync(path.join(dir, "extra.txt"), "utf8"), "mine\n");
  assert.deepEqual(runRaw(dir, "status", "--porcelain").split("\n").filter(Boolean).sort(), [" M README.md", "?? extra.txt"]);
  assert.equal(storedOrigin(dir), REPO_URL);
  assert.equal(b.branch, "main", "on the remote's default branch");
  assert.equal(b.changed, 2);
  assert.equal(b.notes.length, 2);
  assert.match(b.notes.join("|"), /branch feature\/x was not checked out because the files are in the way/);
  assert.deepEqual(fs.readdirSync(s.root), ["example-repo"], "no temporary clone left");
});

test("G6 somebody else's repository under the same name is left exactly as it is", async () => {
  const s = sandbox("g6");
  const dir = path.join(s.root, "example-repo");
  fs.mkdirSync(dir);
  run(dir, "init", "-q", "-b", "main");
  run(dir, "remote", "add", "origin", "https://github.com/other-org/example-repo.git");
  fs.writeFileSync(path.join(dir, "mine.txt"), "x\n");
  const b = await bind(s, { url: REPO_URL });
  assert.equal(b.state, "failed");
  assert.match(b.failure ?? "", /already holds a different repository \(its origin is https:\/\/github\.com\/other-org\/example-repo\.git\), so it was left untouched/);
  assert.equal(storedOrigin(dir), "https://github.com/other-org/example-repo.git");
  assert.equal(verbs(s).filter(Boolean).length, 0, "no clone and no fetch against it");
  assert.equal(fs.readFileSync(path.join(dir, "mine.txt"), "utf8"), "x\n");
});

test("G7 a clone that fails: a reason in the block, no directory, no leftover, nothing thrown", async () => {
  const s = sandbox("g7");
  const b = await bind(s, { url: `${URL_BASE}/missing.git` });
  assert.equal(b.state, "failed");
  assert.match(b.failure ?? "", /^git clone of https:\/\/git\.example\.invalid\/example-org\/missing\.git failed: /);
  assert.match(b.failure ?? "", /does not appear to be a git repository/, "git's own words are in the reason");
  assert.ok((b.failure ?? "").length < 600, "and it is short");
  assert.deepEqual(fs.readdirSync(s.root), [], "neither the checkout nor the temporary clone directory exists");
  assert.equal(fs.existsSync(path.join(s.state, ".claw-repo-bound-missing")), false, "and the sandbox is not marked as bound");
  const block = renderRepoBlock(b);
  assert.match(block, /^\[Repository\]\n- This session is bound to https:\/\/git\.example\.invalid\/example-org\/missing\.git, but setting up the working tree failed: git clone of /);
  assert.match(block, /is not ready\. Tell the user what failed/);
  // A retry in the next turn is a fresh attempt.
  const again = await bind(s, { url: `${URL_BASE}/missing.git` });
  assert.equal(again.state, "failed");
});

test("G7b only this code's own old leftovers are cleared: a marked one an hour old goes, a fresh one and somebody's directory stay", async () => {
  const s = sandbox("g7b");
  const mk = (name: string, o: { marker: boolean; ageMin: number }) => {
    const dir = path.join(s.root, name);
    fs.mkdirSync(path.join(dir, "half"), { recursive: true });
    fs.writeFileSync(path.join(dir, "half", "pack"), "partial\n");
    if (o.marker) fs.writeFileSync(path.join(dir, ".claw-staging"), "");
    const t = new Date(Date.now() - o.ageMin * 60_000);
    fs.utimesSync(dir, t, t);
    return dir;
  };
  const killed = mk(".claw-clone-AAAAAA", { marker: true, ageMin: 180 });        // ours, from a clone that was killed
  const fresh = mk(".claw-clone-BBBBBB", { marker: true, ageMin: 5 });           // ours, and may be in use
  const theirs = mk(".claw-clone-example-repo", { marker: false, ageMin: 500 });   // the shape of ours, but somebody's work
  const b = await bind(s, { url: REPO_URL });
  assert.equal(b.state, "cloned", JSON.stringify(b));
  assert.equal(fs.existsSync(killed), false, "an old leftover of this code's own is cleared");
  assert.equal(fs.existsSync(fresh), true, "a recent one is not touched");
  assert.equal(fs.readFileSync(path.join(theirs, "half", "pack"), "utf8"), "partial\n", "a directory without the marker is never removed, however old");
  assert.deepEqual(fs.readdirSync(s.root).sort(), [".claw-clone-BBBBBB", ".claw-clone-example-repo", "example-repo"]);
  assert.equal(fs.existsSync(path.join(b.path, "half")), false, "nothing of a leftover ended up in the checkout");
  assert.equal(fs.existsSync(path.join(b.path, "README.md")), true);
});

test("G7d a clone that fails removes its own staging directory and nothing else", async () => {
  const s = sandbox("g7d");
  const theirs = path.join(s.root, ".claw-clone-missing");
  fs.mkdirSync(theirs);
  fs.writeFileSync(path.join(theirs, "work.txt"), "mine\n");
  const b = await bind(s, { url: `${URL_BASE}/missing.git` });
  assert.equal(b.state, "failed");
  assert.deepEqual(fs.readdirSync(s.root), [".claw-clone-missing"], "only the directory that was already there");
  assert.equal(fs.readFileSync(path.join(theirs, "work.txt"), "utf8"), "mine\n");
});

test("G6b a checkout that is a symbolic link, or has a .git that is, is left alone: nothing written through it, nothing read from it", async () => {
  // /workspace/example-repo -> somewhere else, which holds an AGENTS.md that must not reach the prompt.
  const s = sandbox("g6b");
  const elsewhere = fs.mkdtempSync(path.join(world, "elsewhere-"));
  fs.writeFileSync(path.join(elsewhere, "AGENTS.md"), "from another place\n");
  fs.symlinkSync(elsewhere, path.join(s.root, "example-repo"));
  const a = await bind(s, { url: REPO_URL });
  assert.equal(a.state, "failed");
  assert.match(a.failure ?? "", /is a symbolic link, so it was left untouched/);
  assert.deepEqual(a.instructions, []);
  assert.deepEqual(fs.readdirSync(elsewhere), ["AGENTS.md"], "no .git was attached over there");
  assert.equal(verbs(s).filter(Boolean).length, 0, "no clone, no fetch");
  assert.equal(renderRepoBlock(a).includes("from another place"), false);

  // A real directory whose .git is a link to a repository elsewhere.
  const s2 = sandbox("g6c");
  const real = path.join(world, "real-repo");
  run(world, "clone", "-q", remote, real);
  fs.mkdirSync(path.join(s2.root, "example-repo"));
  fs.symlinkSync(path.join(real, ".git"), path.join(s2.root, "example-repo", ".git"));
  const before = run(real, "rev-parse", "HEAD");
  const c = await bind(s2, { url: REPO_URL });
  assert.equal(c.state, "failed");
  assert.equal(run(real, "rev-parse", "HEAD"), before);
  assert.equal(verbs(s2).filter(Boolean).length, 0);
});

test("G7c an empty directory in the way is replaced by the clone", async () => {
  const s = sandbox("g7c");
  fs.mkdirSync(path.join(s.root, "example-repo"));
  const b = await bind(s, { url: REPO_URL });
  assert.equal(b.state, "cloned", JSON.stringify(b));
  assert.equal(fs.existsSync(path.join(b.path, ".git")), true);
  assert.equal(fs.existsSync(path.join(b.path, "example-repo")), false, "the clone is not nested inside the empty directory");
});

// --- G8 the instructions --------------------------------------------------------------

/** A remote whose root holds exactly the given files; symlinks are `{ link: target }`. */
function remoteWith(label: string, files: Record<string, string | { link: string }>): string {
  const bare = path.join(world, `${label}.git`);
  run(world, "init", "-q", "--bare", "-b", "main", bare);
  const work = path.join(world, `${label}-work`);
  run(world, "clone", "-q", bare, work);
  fs.writeFileSync(path.join(work, "README.md"), "x\n");
  for (const [name, v] of Object.entries(files)) {
    if (typeof v === "string") fs.writeFileSync(path.join(work, name), v);
    else fs.symlinkSync(v.link, path.join(work, name));
  }
  run(work, "add", "-A");
  run(work, "commit", "-q", "-m", "files");
  run(work, "push", "-q", "origin", "HEAD:main");
  fs.appendFileSync(path.join(home, ".gitconfig"), `[url "file://${bare.replace(/\.git$/, "")}"]\n\tinsteadOf = ${URL_BASE}/${label}\n`);
  return `${URL_BASE}/${label}.git`;
}

const bytes = (t: string) => Buffer.byteLength(t, "utf8");
const rendered = (i: { text: string; truncated: boolean }) => bytes(i.text + (i.truncated ? REPO_TRUNCATION_MARKER : ""));

test("G8a an AGENTS.md over 32 KB is cut, ends with the marker, and what is rendered fits the limit", async () => {
  const big = `${"# rules\n"}${"0123456789abcdef\n".repeat(4000)}`;
  const url = remoteWith("g8a", { "AGENTS.md": big });
  const b = await bind(sandbox("g8a"), { url });
  assert.equal(b.instructions.length, 1);
  const [ins] = b.instructions;
  assert.equal(ins.file, "AGENTS.md");
  assert.equal(ins.truncated, true);
  assert.ok(rendered(ins) <= REPO_INSTRUCTIONS_MAX_BYTES, `${rendered(ins)} bytes`);
  assert.ok(rendered(ins) > REPO_INSTRUCTIONS_MAX_BYTES - 200, "and it is not cut far short of the limit");
  assert.ok(big.startsWith(ins.text), "what is kept is the start of the file");
  const block = renderRepoBlock(b);
  assert.ok(block.includes(REPO_TRUNCATION_MARKER));
  assert.ok(block.includes("=== AGENTS.md ===") && block.includes("=== END AGENTS.md ==="));
});

test("G8b a file under the limit is given whole; CLAUDE.md that links to AGENTS.md is given once", async () => {
  const text = "# Rules\n- run the tests\n- non-ASCII: é中\n";
  const url = remoteWith("g8b", { "AGENTS.md": text, "CLAUDE.md": { link: "AGENTS.md" } });
  const b = await bind(sandbox("g8b"), { url });
  assert.deepEqual(b.instructions, [{ file: "AGENTS.md", text: text.replace(/\n$/, ""), truncated: false }]);
  assert.equal(renderRepoBlock(b).split("=== AGENTS.md ===").length, 2);
  assert.equal(renderRepoBlock(b).includes("=== CLAUDE.md ==="), false);
});

test("G8c both files, different: AGENTS.md first, CLAUDE.md gets what is left of the one 32 KB budget", async () => {
  const a = `A${"a".repeat(20000)}\n`;
  const c = `C${"c".repeat(20000)}\n`;
  const url = remoteWith("g8c", { "AGENTS.md": a, "CLAUDE.md": c });
  const b = await bind(sandbox("g8c"), { url });
  assert.deepEqual(b.instructions.map((i) => [i.file, i.truncated]), [["AGENTS.md", false], ["CLAUDE.md", true]]);
  const total = b.instructions.reduce((n, i) => n + rendered(i), 0);
  assert.ok(total <= REPO_INSTRUCTIONS_MAX_BYTES, `${total} bytes together`);
  assert.ok(total > REPO_INSTRUCTIONS_MAX_BYTES - 200);
});

test("G8d only CLAUDE.md is read when there is no AGENTS.md; neither means no instructions", async () => {
  const only = await bind(sandbox("g8d1"), { url: remoteWith("g8d1", { "CLAUDE.md": "claude only\n" }) });
  assert.deepEqual(only.instructions.map((i) => i.file), ["CLAUDE.md"]);
  const none = await bind(sandbox("g8d2"), { url: remoteWith("g8d2", {}) });
  assert.deepEqual(none.instructions, []);
  assert.equal(renderRepoBlock(none).includes("instructions follow"), false);
});

test("G8e an instruction file that is a link out of the repository is not read", async () => {
  const secret = path.join(world, "sandbox-secret.txt");
  fs.writeFileSync(secret, `GH_TOKEN=${FAKE_TOKEN}\n`);
  const url = remoteWith("g8e", { "AGENTS.md": { link: secret }, "CLAUDE.md": { link: "/proc/self/environ" } });
  const b = await bind(sandbox("g8e"), { url });
  assert.equal(b.state, "cloned");
  assert.deepEqual(b.instructions, []);
  assert.equal(JSON.stringify(b).includes(FAKE_TOKEN), false);
  assert.equal(renderRepoBlock(b).includes(FAKE_TOKEN), false);
});

test("G8f an empty AGENTS.md is no instructions", async () => {
  const b = await bind(sandbox("g8f"), { url: remoteWith("g8f", { "AGENTS.md": "\n\n" }) });
  assert.deepEqual(b.instructions, []);
});

// --- G9 -------------------------------------------------------------------------------

test("G9 no credential anywhere: not in a command, not in .git/config, not in the block", async () => {
  const before = process.env.GH_TOKEN;
  process.env.GH_TOKEN = FAKE_TOKEN;
  try {
    const s = sandbox("g9");
    const b = await bind(s, { url: REPO_URL, branch: "main" });
    assert.equal(b.state, "cloned");
    for (const c of s.calls) {
      assert.equal(c.includes(FAKE_TOKEN), false, `a command carries the token: ${c}`);
      assert.doesNotMatch(c, /GH_TOKEN|GITHUB_TOKEN|x-access-token|https:\/\/[^/ '"]*@/i, c);
    }
    assert.equal(fs.readFileSync(path.join(b.path, ".git", "config"), "utf8").includes(FAKE_TOKEN), false);
    assert.equal(fs.readFileSync(path.join(b.path, ".git", "config"), "utf8").includes("@"), false, "no userinfo in the remote");
    assert.equal(JSON.stringify(b).includes(FAKE_TOKEN), false);
    assert.equal(renderRepoBlock(b).includes(FAKE_TOKEN), false);
  } finally {
    if (before === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = before;
  }
});
