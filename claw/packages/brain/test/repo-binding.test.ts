// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The repository binding against a scripted Hands: which commands go out, in what
 * order, for each state of /workspace/<name>; what a failure of each step does to
 * the result; and how the block the model reads is written. The commands
 * themselves are run for real in repo-binding-git.test.ts.
 *
 *   S1 the command sequence for absent / has .git (new sandbox) / has .git (same sandbox) / files without .git
 *   S2 a failure of any step is a reason in the result, never a throw
 *   S3 a value that fails the check runs nothing
 *   S4 the abort signal reaches Hands
 *   S5 no command carries a credential, a force or a discard
 *   S6 truncation and budget: byte-exact, multi-byte safe
 *   S7 the prompt block
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  bindRepo, clipUtf8, parseInstructions, renderRepoBlock, sameRepoUrl, scrubReason,
  REPO_INSTRUCTIONS_MAX_BYTES, REPO_TRUNCATION_MARKER, GIT_CREDENTIAL_HELPER, type RepoBinding,
} from "../src/workspace/repo-binding.js";

const URL = "https://github.com/example-org/example-repo";
const TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";

type Reply = { text: string; isError?: boolean } | Error;
interface Script { match: RegExp; reply: Reply | (() => Reply) }

/** A Hands that records every call and answers by the command's text; anything unmatched succeeds silently. */
function scripted(script: Script[]) {
  const calls: Array<{ name: string; command: string; timeout: unknown; signal: AbortSignal | undefined }> = [];
  return {
    calls,
    commands: () => calls.map((c) => c.command),
    async callToolFull(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      const command = String(args.command);
      calls.push({ name, command, timeout: args.timeout, signal });
      const hit = script.find((s) => s.match.test(command));
      const reply = hit ? (typeof hit.reply === "function" ? hit.reply() : hit.reply) : { text: "" };
      if (reply instanceof Error) throw reply;
      return { text: reply.text, isError: reply.isError === true };
    },
  };
}

/** What the probe's single call prints on a turn after the first: the tree's state, and the instruction files. */
interface Inline { branch?: string; head?: string; changed?: number; files?: string }
const probe = (state: "absent" | "git" | "occupied" | "linked", opts: { origin?: string; bound?: boolean; cred?: "ok" | "failed"; inline?: Inline } = {}): Script => ({
  match: /CLAW_REPO_STATE/,
  reply: { text: [
    `CLAW_REPO_CRED=${opts.cred ?? "ok"}`,
    `CLAW_REPO_STATE=${state}`,
    ...(state === "git" ? [`CLAW_REPO_ORIGIN=${opts.origin ?? URL}`] : []),
    `CLAW_REPO_BOUND=${opts.bound ? "yes" : "no"}`,
    ...(state === "git" && opts.bound ? [
      `CLAW_REPO_BRANCH=${opts.inline?.branch ?? "main"}`, `CLAW_REPO_HEAD=${opts.inline?.head ?? "abc1234"}`, `CLAW_REPO_CHANGED=${opts.inline?.changed ?? 0}`,
      ...(opts.inline?.files ? [opts.inline.files] : []),
    ] : []),
  ].join("\n") },
});
const status = (branch = "main", head = "abc1234", changed = 0): Script => ({
  match: /CLAW_REPO_CHANGED/,
  reply: { text: `CLAW_REPO_BRANCH=${branch}\nCLAW_REPO_HEAD=${head}\nCLAW_REPO_CHANGED=${changed}\n` },
});
const branchResult = (r: string): Script => ({ match: /CLAW_REPO_BRANCH_RESULT/, reply: { text: `CLAW_REPO_BRANCH_RESULT=${r}\n` } });
const fail = (match: RegExp, stderr: string): Script => ({ match, reply: { text: `exit 128\nstdout: \nstderr: ${stderr}`, isError: true } });

const opts = { root: "/workspace", stateDir: "/tmp" };
/** The step each command is, by what it does. */
const stepOf = (c: string) =>
  /CLAW_REPO_STATE/.test(c) ? "probe"
    : /git clone --quiet --no-checkout/.test(c) ? "adopt"
      : /git clone --quiet/.test(c) ? "clone"
        : / fetch --quiet origin/.test(c) ? "fetch"
          : /CLAW_REPO_BRANCH_RESULT/.test(c) ? "branch"
            : /CLAW_REPO_CHANGED/.test(c) ? "status"
              : /CLAW-REPO-FILE/.test(c) ? "instructions"
                : `unknown: ${c}`;

test("S1 absent: probe, clone, status, instructions; with a branch, a branch step after the clone", async () => {
  const plain = scripted([probe("absent"), status()]);
  const a = await bindRepo(plain, { url: URL }, opts);
  assert.deepEqual(plain.commands().map(stepOf), ["probe", "clone", "status", "instructions"]);
  assert.equal(a.state, "cloned");
  assert.equal(a.path, "/workspace/example-repo");

  const withBranch = scripted([probe("absent"), branchResult("switched"), status("release/1.2")]);
  const b = await bindRepo(withBranch, { url: URL, branch: "release/1.2" }, opts);
  assert.deepEqual(withBranch.commands().map(stepOf), ["probe", "clone", "branch", "status", "instructions"]);
  assert.equal(b.branch, "release/1.2");
  assert.deepEqual(b.notes, []);
});

test("S1 has a .git in a new sandbox: probe, fetch, status, instructions - and never a clone", async () => {
  const hands = scripted([probe("git"), status("claw/work", "def5678", 3)]);
  const b = await bindRepo(hands, { url: URL, branch: "main" }, opts);
  assert.deepEqual(hands.commands().map(stepOf), ["probe", "fetch", "status", "instructions"]);
  assert.ok(hands.commands()[1].startsWith("export GIT_TERMINAL_PROMPT=0; "), "the fetch never waits for a login either");
  assert.equal(b.state, "present");
  assert.equal(b.branch, "claw/work");
  assert.equal(b.changed, 3);
  assert.equal(b.notes.length, 1);
  assert.match(b.notes[0], /session was started on branch main; this checkout is on claw\/work, where the earlier work was left, and it was not switched/);
});

test("S1 has a .git in the sandbox that already bound it: no fetch, and ONE call - the state and the instructions come with the probe", async () => {
  const files = "@@CLAW-REPO-FILE AGENTS.md@@\nbe kind\n@@CLAW-REPO-END@@";
  const hands = scripted([probe("git", { bound: true, inline: { branch: "claw/work", head: "def5678", changed: 2, files } })]);
  const b = await bindRepo(hands, { url: URL }, opts);
  assert.deepEqual(hands.commands().map(stepOf), ["probe"]);
  assert.equal(b.state, "present");
  assert.deepEqual([b.branch, b.head, b.changed], ["claw/work", "def5678", 2]);
  assert.deepEqual(b.instructions, [{ file: "AGENTS.md", text: "be kind", truncated: false }]);
  assert.deepEqual(b.notes, []);
  // The probe command itself carries the status and the instruction reads, only for a bound git checkout.
  const cmd = hands.commands()[0];
  assert.match(cmd, /if \[ "\$ST" = git \] && \[ "\$BD" = yes \]; then echo "CLAW_REPO_BRANCH=/);
  assert.ok(cmd.includes("@@CLAW-REPO-FILE AGENTS.md@@") && cmd.includes("@@CLAW-REPO-FILE CLAUDE.md@@"));
});

test("S1 a probe that brought no state (the first turn in a sandbox) is followed by the fetch, the status and the instructions", async () => {
  const hands = scripted([probe("git", { bound: false }), status()]);
  await bindRepo(hands, { url: URL }, opts);
  assert.deepEqual(hands.commands().map(stepOf), ["probe", "fetch", "status", "instructions"]);
});

test("S1 an origin that is not the repository drops what the probe brought with it", async () => {
  const files = "@@CLAW-REPO-FILE AGENTS.md@@\nsomeone else's rules\n@@CLAW-REPO-END@@";
  const hands = scripted([probe("git", { bound: true, origin: "https://github.com/other-org/example-repo.git", inline: { files } })]);
  const b = await bindRepo(hands, { url: URL }, opts);
  assert.equal(b.state, "failed");
  assert.deepEqual(b.instructions, []);
  assert.equal(renderRepoBlock(b).includes("someone else's rules"), false);
});

test("S1 on the requested branch, a present checkout has no branch note; detached HEAD is named as such", async () => {
  const same = await bindRepo(scripted([probe("git"), status("main")]), { url: URL, branch: "main" }, opts);
  assert.deepEqual(same.notes, []);
  const detached = await bindRepo(scripted([probe("git"), status("", "abc1234")]), { url: URL, branch: "main" }, opts);
  assert.equal(detached.branch, null);
  assert.match(detached.notes[0], /this checkout is on a detached HEAD/);
});

test("S1 files without a .git: the adopt step, a note, and a requested branch is not forced over the files", async () => {
  const hands = scripted([probe("occupied"), status("main", "abc1234", 5)]);
  const b = await bindRepo(hands, { url: URL, branch: "feature/x" }, opts);
  assert.deepEqual(hands.commands().map(stepOf), ["probe", "adopt", "status", "instructions"]);
  assert.equal(b.state, "adopted");
  assert.equal(b.notes.length, 2);
  assert.match(b.notes[0], /already had files and no \.git/);
  assert.match(b.notes[1], /branch feature\/x was not checked out because the files are in the way/);
});

test("S1 the repository is the directory under the root named by the url; the clone is staged in a directory made for the call", async () => {
  const hands = scripted([probe("absent"), status()]);
  await bindRepo(hands, { url: "https://git.example.invalid/team/tool.git" }, { root: "/srv/ws/", stateDir: "/var/state/" });
  const clone = hands.commands().find((c) => stepOf(c) === "clone")!;
  assert.ok(clone.startsWith("export GIT_TERMINAL_PROMPT=0; "), "git never waits for a login nobody can type");
  assert.match(clone, /D='\/srv\/ws\/tool';/);
  // Staged in a fresh directory of its own (mktemp), in the root so the final move stays on one filesystem,
  // and recorded OUTSIDE the workspace so that only a call's own leftover is ever cleared.
  assert.match(clone, /REC='\/var\/state\/\.claw-repo-staging-tool';/);
  assert.match(clone, /S=\$\(mktemp -d '\/srv\/ws\/\.claw-clone-XXXXXX'\) \|\| exit 1; printf %s "\$S" > "\$REC"; T="\$S\/repo";/);
  assert.match(clone, /git clone --quiet -- 'https:\/\/git\.example\.invalid\/team\/tool\.git' "\$T" && mv "\$T" "\$D" && rm -rf "\$S" && rm -f "\$REC" && touch '\/var\/state\/\.claw-repo-bound-tool'/);
  // The leftover the record names is removed only while it still has the shape this code gives it.
  assert.match(clone, /case "\$old" in '\/srv\/ws'\/\.claw-clone-\?\?\?\?\?\?\) \[ -d "\$old" \] && \[ ! -L "\$old" \] && rm -rf "\$old";; esac; rm -f "\$REC"/);
  assert.equal(clone.includes("find "), false, "nothing in the workspace is searched for and removed");
  assert.match(hands.commands()[0], /\[ -e '\/var\/state\/\.claw-repo-bound-tool' \]/);
});

test("S1 a checkout that is a link, or has a .git that is a link or not a directory, is left alone: a failure, and nothing else runs", async () => {
  const hands = scripted([probe("linked")]);
  const b = await bindRepo(hands, { url: URL }, opts);
  assert.equal(b.state, "failed");
  assert.equal(b.failure, "/workspace/example-repo (or its .git) is a symbolic link, or its .git is a pointer file and not a directory, so it was left untouched");
  assert.deepEqual(hands.commands().map(stepOf), ["probe"]);
  assert.match(hands.commands()[0], /if \[ -L "\$D" \] \|\| \[ -L "\$D\/\.git" \] \|\| \{ \[ -e "\$D\/\.git" \] && \[ ! -d "\$D\/\.git" \]; \}; then ST=linked;/);
});

test("S2 a failed clone is a reason and a failed state, not a throw; the instructions step is skipped", async () => {
  const hands = scripted([probe("absent"), fail(/git clone --quiet --/, "remote: Repository not found.\nfatal: repository 'https://github.com/example-org/example-repo/' not found")]);
  const b = await bindRepo(hands, { url: URL }, opts);
  assert.equal(b.state, "failed");
  assert.equal(b.failure, "git clone of https://github.com/example-org/example-repo failed: remote: Repository not found. | fatal: repository 'https://github.com/example-org/example-repo/' not found");
  assert.deepEqual(hands.commands().map(stepOf), ["probe", "clone"], "nothing is read from a tree that is not there");
  assert.equal(b.instructions.length, 0);
});

test("S2 a failed fetch keeps the checkout, says so, and goes on", async () => {
  const hands = scripted([probe("git"), fail(/ fetch --quiet origin/, "fatal: unable to access 'https://github.com/example-org/example-repo/': Could not resolve host: github.com"), status()]);
  const b = await bindRepo(hands, { url: URL }, opts);
  assert.equal(b.state, "present");
  assert.equal(b.failure, null);
  assert.match(b.notes[0], /^git fetch failed \(fatal: unable to access .*Could not resolve host: github\.com\); the checkout is as it was left$/);
  assert.deepEqual(hands.commands().map(stepOf), ["probe", "fetch", "status", "instructions"]);
});

test("S2 a failed adopt is a failure that names the directory, and a missing branch / failed switch are notes", async () => {
  const adopt = await bindRepo(scripted([probe("occupied"), fail(/clone --quiet --no-checkout/, "fatal: could not read from remote")]), { url: URL }, opts);
  assert.equal(adopt.state, "failed");
  assert.match(adopt.failure ?? "", /^\/workspace\/example-repo already has files and is not a git repository, and attaching the repository to them failed: fatal: could not read from remote$/);

  const missing = await bindRepo(scripted([probe("absent"), branchResult("missing"), status()]), { url: URL, branch: "nope" }, opts);
  assert.equal(missing.state, "cloned");
  assert.match(missing.notes[0], /branch nope does not exist on the remote; the checkout is on the remote's default branch/);

  const refused = await bindRepo(scripted([probe("absent"), branchResult("failed"), status()]), { url: URL, branch: "nope" }, opts);
  assert.match(refused.notes[0], /switching to branch nope failed/);
});

test("S2 somebody else's repository: failure, and no clone, fetch or adopt", async () => {
  const hands = scripted([probe("git", { origin: "https://github.com/other-org/example-repo.git" })]);
  const b = await bindRepo(hands, { url: URL }, opts);
  assert.equal(b.state, "failed");
  assert.match(b.failure ?? "", /already holds a different repository \(its origin is https:\/\/github\.com\/other-org\/example-repo\.git\), so it was left untouched/);
  assert.deepEqual(hands.commands().map(stepOf), ["probe"]);
});

test("S2 an origin carrying a credential is neither matched against nor repeated", async () => {
  const sameWithUserinfo = await bindRepo(scripted([probe("git", { origin: `https://x-access-token:${TOKEN}@github.com/example-org/example-repo.git` }), status()]), { url: URL }, opts);
  assert.equal(sameWithUserinfo.state, "present", "the same repository, however it was cloned");
  const other = await bindRepo(scripted([probe("git", { origin: `https://x-access-token:${TOKEN}@github.com/other-org/example-repo.git` })]), { url: URL }, opts);
  assert.equal(other.state, "failed");
  assert.equal((other.failure ?? "").includes(TOKEN), false, other.failure ?? "");
  assert.equal(renderRepoBlock(other).includes(TOKEN), false);
});

test("S2 the sandbox cannot be reached, or the probe is unreadable: a failure with the reason, no throw", async () => {
  const down = await bindRepo(scripted([{ match: /./, reply: new Error("fetch failed: ECONNREFUSED") }]), { url: URL }, opts);
  assert.equal(down.state, "failed");
  assert.match(down.failure ?? "", /^the sandbox could not inspect \/workspace\/example-repo: could not run the command in the sandbox: fetch failed: ECONNREFUSED$/);
  const garbled = await bindRepo(scripted([{ match: /./, reply: { text: "no markers here" } }]), { url: URL }, opts);
  assert.equal(garbled.state, "failed");
  assert.match(garbled.failure ?? "", /^the sandbox could not inspect/);
});

test("S2 git that cannot take the credential helper is a note, and the clone still goes", async () => {
  const hands = scripted([probe("absent", { cred: "failed" }), status()]);
  const b = await bindRepo(hands, { url: URL }, opts);
  assert.equal(b.state, "cloned");
  assert.match(b.notes[0], /git could not be set up to use the signed-in GitHub account/);
});

test("S2 a failure's reason never carries a url's userinfo or a token-shaped string", async () => {
  const hands = scripted([probe("absent"), fail(/git clone --quiet --/, `fatal: unable to access 'https://user:secret@example.invalid/o/r/': 403; Authorization: Bearer ${TOKEN}`)]);
  const b = await bindRepo(hands, { url: URL }, opts);
  assert.equal(b.state, "failed");
  assert.equal((b.failure ?? "").includes("secret"), false);
  assert.equal((b.failure ?? "").includes(TOKEN), false);
  assert.match(b.failure ?? "", /https:\/\/<redacted>@example\.invalid/);
  assert.equal(scrubReason(`clone https://a:b@h.invalid/x and ${TOKEN}`).includes(TOKEN), false);
  // A user name alone is not shaped like a secret to the general redaction, and is still somebody's identity.
  assert.equal(scrubReason("fatal: unable to access 'https://alice@example.invalid/o/r/': 403"), "fatal: unable to access 'https://<redacted>@example.invalid/o/r/': 403");
});

test("S3 a value that fails the check runs nothing, and the reason is the check's own words", async () => {
  for (const [raw, reason] of [
    [{ url: "http://github.com/o/r" }, /^config\.repo\.url must be an https clone URL/],
    [{ url: `https://${TOKEN}@github.com/o/r` }, /^config\.repo\.url must be an https clone URL/],
    [{ url: URL, branch: "-f" }, /^config\.repo\.branch is not a valid branch name$/],
    [{ url: URL, extra: 1 }, /^config\.repo\.extra is not supported$/],
    ["https://github.com/o/r", /^config\.repo must be an object/],
    [{ url: "https://github.com/o/.." }, /^config\.repo\.url /],
  ] as Array<[unknown, RegExp]>) {
    const hands = scripted([]);
    const b = await bindRepo(hands, raw, opts);
    assert.equal(b.state, "failed", JSON.stringify(raw));
    assert.match(b.failure ?? "", reason, JSON.stringify(raw));
    assert.equal(hands.calls.length, 0, `nothing was run for ${JSON.stringify(raw)}`);
    assert.equal(JSON.stringify(b).includes(TOKEN), false, "the refused value is not echoed");
    assert.equal(renderRepoBlock(b).includes(TOKEN), false);
  }
  const none = scripted([]);
  assert.equal((await bindRepo(none, null, opts)).state, "failed");
  assert.equal(none.calls.length, 0);
});

test("S4 the abort signal is handed to Hands on every call, and each call is bash with a timeout", async () => {
  const ctl = new AbortController();
  const hands = scripted([probe("absent"), status()]);
  await bindRepo(hands, { url: URL }, { ...opts, signal: ctl.signal });
  assert.ok(hands.calls.length >= 4);
  for (const c of hands.calls) {
    assert.equal(c.name, "bash");
    assert.equal(c.signal, ctl.signal);
    assert.equal(typeof c.timeout, "number");
    assert.ok((c.timeout as number) > 0 && (c.timeout as number) <= 100, "within Hands' foreground ceiling");
  }
});

test("S5 no command carries a credential, a force or a discard; every url and branch is quoted", async () => {
  const run = async (state: "absent" | "git" | "occupied", repo: Record<string, unknown>) => {
    const hands = scripted([probe(state), branchResult("switched"), status()]);
    await bindRepo(hands, repo, opts);
    return hands.commands();
  };
  const all = [
    ...await run("absent", { url: URL, branch: "feat/x" }),
    ...await run("git", { url: URL, branch: "feat/x" }),
    ...await run("occupied", { url: URL, branch: "feat/x" }),
  ];
  assert.ok(all.length >= 10);
  for (const c of all) {
    assert.doesNotMatch(c, /GH_TOKEN|GITHUB_TOKEN|ghp_|x-access-token|https:\/\/[^/\s'"]*@/i, c);
    assert.doesNotMatch(c, /--force|reset --hard|\bclean\b|checkout -f|stash|\bpull\b|\bmerge\b|rebase|--delete|\bpush\b/, c);
    assert.doesNotMatch(c, /\bgit\b[^;&|]*\s-f(\s|$)/, `a forced git: ${c}`);
    // `rm -rf` only ever names the staging directory this call made, or the leftover the record outside
    // the workspace names (and only when it still has the shape of one).
    for (const m of c.matchAll(/rm -rf (\S+)/g)) assert.ok(['"$S"', '"$old"', '"$D/.git";'].includes(m[1]) || ['"$S"', '"$old"', '"$D/.git"'].includes(m[1].replace(/;+$/, "")), `${m[1]} in ${c}`);
  }
  // The url reaches git once, single-quoted, after `--`.
  const clone = all.find((c) => stepOf(c) === "clone")!;
  assert.equal(clone.split("https://github.com").length - 1, 1, "the url is written once");
  assert.ok(clone.includes(`git clone --quiet -- 'https://github.com/example-org/example-repo' "$T"`));
  // The credential helper is the one fixed string, added only when it is not there.
  const first = all[0];
  assert.ok(first.includes(`'${GIT_CREDENTIAL_HELPER}'`));
  assert.match(first, /--get-all credential\.helper .*\| grep -qxF '!gh auth git-credential' \|\| git config --global --add credential\.helper '!gh auth git-credential'/);
});

test("S6 clipUtf8 cuts on a character boundary, by bytes", () => {
  assert.deepEqual(clipUtf8("abc", 3), { text: "abc", truncated: false });
  assert.deepEqual(clipUtf8("abcd", 3), { text: "abc", truncated: true });
  // "é" is two bytes: a cut at 3 bytes of "aéé" would split the second one.
  const s = "aéé";
  assert.equal(Buffer.byteLength(s), 5);
  const cut = clipUtf8(s, 4);
  assert.equal(cut.truncated, true);
  assert.equal(cut.text, "aé");
  assert.equal(cut.text.includes("�"), false);
  // Three-byte characters, cut in each position.
  const cjk = "中文字";
  for (let n = 0; n <= 9; n++) {
    const c = clipUtf8(cjk, n);
    assert.ok(Buffer.byteLength(c.text) <= n, `n=${n}`);
    assert.equal(c.text.includes("�"), false, `n=${n}`);
    assert.equal(c.truncated, n < 9, `n=${n}`);
  }
  assert.deepEqual(clipUtf8("abc", 0), { text: "", truncated: true });
});

const fileOut = (name: string, body: string) => `@@CLAW-REPO-FILE ${name}@@\n${body}\n@@CLAW-REPO-END@@\n`;
const rendered = (i: { text: string; truncated: boolean }) => Buffer.byteLength(i.text + (i.truncated ? REPO_TRUNCATION_MARKER : ""));

test("S6 parseInstructions: the budget is exact, the marker counts against it, a copy is given once", () => {
  const one = parseInstructions(fileOut("AGENTS.md", "hello\n"));
  assert.deepEqual(one, [{ file: "AGENTS.md", text: "hello", truncated: false }]);

  const exact = "x".repeat(REPO_INSTRUCTIONS_MAX_BYTES);
  assert.deepEqual(parseInstructions(fileOut("AGENTS.md", exact)), [{ file: "AGENTS.md", text: exact, truncated: false }], "exactly the limit is not cut");
  const over = parseInstructions(fileOut("AGENTS.md", `${exact}y`));
  assert.equal(over[0].truncated, true);
  assert.ok(rendered(over[0]) <= REPO_INSTRUCTIONS_MAX_BYTES, `${rendered(over[0])}`);
  assert.ok(rendered(over[0]) >= REPO_INSTRUCTIONS_MAX_BYTES - 3, "and it is not cut short of it");

  const twoCopies = parseInstructions(fileOut("AGENTS.md", "same") + fileOut("CLAUDE.md", "same"));
  assert.deepEqual(twoCopies.map((i) => i.file), ["AGENTS.md"]);

  const shared = parseInstructions(fileOut("AGENTS.md", "a".repeat(30000)) + fileOut("CLAUDE.md", "c".repeat(30000)));
  assert.deepEqual(shared.map((i) => [i.file, i.truncated]), [["AGENTS.md", false], ["CLAUDE.md", true]]);
  assert.ok(shared.reduce((n, i) => n + rendered(i), 0) <= REPO_INSTRUCTIONS_MAX_BYTES);

  const none = parseInstructions(fileOut("AGENTS.md", "a".repeat(REPO_INSTRUCTIONS_MAX_BYTES)) + fileOut("CLAUDE.md", "different"));
  assert.deepEqual(none.map((i) => [i.file, i.text === "", i.truncated]), [["AGENTS.md", false, false], ["CLAUDE.md", true, true]], "nothing left of the budget: named, not included");

  assert.deepEqual(parseInstructions(""), []);
  assert.deepEqual(parseInstructions(fileOut("AGENTS.md", "   \n  ")), [], "a blank file is nothing");
});

test("S6 parseInstructions: a multi-byte text over the budget never ends in half a character", () => {
  const body = "中".repeat(20000); // 60000 bytes
  const [ins] = parseInstructions(fileOut("AGENTS.md", body));
  assert.equal(ins.truncated, true);
  assert.equal(ins.text.includes("�"), false);
  assert.ok(rendered(ins) <= REPO_INSTRUCTIONS_MAX_BYTES);
});

test("S6 sameRepoUrl: case, .git, a trailing slash and userinfo do not make a different repository; owner or name do", () => {
  const yes: Array<[string, string]> = [
    [URL, URL], [`${URL}.git`, URL], [URL, `${URL}.git`], [`${URL}/`, URL], [URL.toUpperCase(), URL],
    [`https://tok:en@github.com/example-org/example-repo.git`, URL], [`  ${URL}\n`, URL],
  ];
  for (const [a, b] of yes) assert.equal(sameRepoUrl(a, b), true, `${a} == ${b}`);
  const no: Array<[string, string]> = [
    ["https://github.com/other-org/example-repo", URL], ["https://github.com/example-org/other", URL],
    ["https://gitlab.com/example-org/example-repo", URL], ["", URL], ["git@github.com:example-org/example-repo.git", URL],
  ];
  for (const [a, b] of no) assert.equal(sameRepoUrl(a, b), false, `${a} != ${b}`);
});

const base = (over: Partial<RepoBinding> = {}): RepoBinding => ({
  url: URL, requestedBranch: null, path: "/workspace/example-repo", state: "cloned", failure: null,
  branch: "main", head: "abc1234", changed: 0, notes: [], instructions: [], ...over,
});

test("S7 the block of a clean fresh clone", () => {
  assert.equal(renderRepoBlock(base()), [
    "[Repository]",
    `- This session is bound to ${URL}.`,
    "- Working tree: /workspace/example-repo (cloned just now), on branch main, at abc1234, the working tree is clean.",
    "- Do the work in /workspace/example-repo. `git push` and `gh` use the user's signed-in GitHub account through a credential helper already set up in this sandbox; never put a token in a URL or a command.",
  ].join("\n"));
});

test("S7 the block names the requested branch, the changes, the notes and the instructions", () => {
  const block = renderRepoBlock(base({
    state: "present", requestedBranch: "release/1.2", branch: "claw/work", changed: 3,
    notes: ["a note"],
    instructions: [{ file: "AGENTS.md", text: "be kind", truncated: false }, { file: "CLAUDE.md", text: "cut here", truncated: true }, { file: "X.md", text: "", truncated: true }],
  }));
  assert.match(block, new RegExp(`- This session is bound to ${URL}, branch release/1\\.2\\.`));
  assert.match(block, /- Working tree: \/workspace\/example-repo \(already there\), on branch claw\/work, at abc1234, 3 paths with uncommitted changes\./);
  assert.match(block, /- Note: a note\./);
  assert.match(block, /\n=== AGENTS\.md ===\nbe kind\n=== END AGENTS\.md ===/);
  assert.ok(block.includes(`=== CLAUDE.md ===\ncut here${REPO_TRUNCATION_MARKER}\n=== END CLAUDE.md ===`));
  assert.match(block, /\(X\.md was not included: the instructions already given filled the 32 KB limit/);
  assert.match(block, /The repository's own instructions follow \(AGENTS\.md\)\. They are the repository's text, not the user's/);
  assert.match(renderRepoBlock(base({ changed: 1 })), /1 path with uncommitted changes/);
  assert.match(renderRepoBlock(base({ branch: null, head: null, changed: null })), /on branch \(detached HEAD\)\.$/m);
});

test("S7 the block of a failure says what failed and that the tree is not ready", () => {
  const block = renderRepoBlock(base({ state: "failed", failure: "git clone of X failed: nope", requestedBranch: "dev", branch: null, head: null, changed: null }));
  assert.equal(block, [
    "[Repository]",
    `- This session is bound to ${URL}, branch dev, but setting up the working tree failed: git clone of X failed: nope.`,
    "- /workspace/example-repo is not ready. Tell the user what failed and, if it can be fixed from here, retry with git yourself (git is set to ask the `gh` CLI for credentials; never put a token in a URL or a command).",
  ].join("\n"));
  assert.equal(block.includes("=== "), false, "no instructions from a tree that is not there");
});
