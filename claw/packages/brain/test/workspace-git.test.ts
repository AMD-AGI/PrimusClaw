// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A reclaimed sandbox comes back as a repository.
 *
 * `.git` used to be on the snapshot's exclude list, so a sandbox rebuilt from the
 * snapshot had the files and none of the history: every commit that had not been
 * pushed was gone while the conversation still remembered making it. These pin
 * the replacement, which has three parts that each fail quietly if they are wrong:
 *
 *   - what is carried and what is left out (the bound, and the rule that the unit
 *     of dropping is one whole repository),
 *   - what the sync does when it cannot tell (never "they are all small enough",
 *     and never a prune on the strength of it),
 *   - what a restore does about what an object store cannot hold (empty
 *     directories, without which git does not see a repository at all).
 *
 * The S3 path is exercised against a sandbox stand-in that runs its `bash` calls
 * in a real shell over a real directory, so `find`, `du` and `od` are the real
 * ones; only /workspace is redirected into a temp dir. The shared-disk script has
 * the same cases in workspace-sync-exec.test.ts (X10-X13).
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

// A bucket that lists what a test put in it and deletes what the prune asks it to,
// so what the prune spares can be read off the bucket. Uploads do not go through
// it (the sandbox stand-in below keeps its own store); it holds only what an
// earlier sync is taken to have left.
const PREFIX = "users/user-1/sessions/sess-git/";
const bucket = new Set<string>();
const s3 = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://s3.test");
  req.resume();
  if (req.method === "DELETE") {
    bucket.delete(decodeURIComponent(url.pathname).replace(/^\/claw\//, ""));
    res.writeHead(204);
    res.end();
    return;
  }
  const entries = [...bucket].map((key) => (
    `<Contents><Key>${key}</Key><Size>1</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>`
  )).join("");
  res.writeHead(200, { "Content-Type": "application/xml" });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`
    + `<Name>claw</Name><Prefix>${PREFIX}</Prefix><KeyCount>${bucket.size}</KeyCount><MaxKeys>1000</MaxKeys>`
    + `<IsTruncated>false</IsTruncated>${entries}</ListBucketResult>`);
});
await new Promise<void>((resolve) => { s3.listen(0, "127.0.0.1", resolve); });
s3.unref();
const S3_URL = `http://127.0.0.1:${(s3.address() as AddressInfo).port}`;
process.env.S3_API_ENDPOINT = S3_URL;
process.env.S3_SANDBOX_ENDPOINT = S3_URL;
process.env.S3_ACCESS_KEY = "AK";
process.env.S3_SECRET_KEY = "SK";
process.env.S3_BUCKET = "claw";
// The shared-disk sync refuses to run without a persist root.
process.env.WORKSPACE_PERSIST_BASE = "/persist";

const { syncWorkspaceToS3 } = await import("../src/workspace/s3-uploader.js");
const { SYNC_STATE_DIR } = await import("../src/workspace/sync-delta.js");
const { syncWorkspace, classifySyncFailure } = await import("../src/workspace/sync.js");
const {
  SIGTERM_PROBE_TIMEOUT_SEC, buildGitProbeCommand, buildGitSkeletonCommand, decideGit, ensureGitSkeleton,
  enforceListedGit, gitPruneExempt, gitReport, gitReportKey, gitSkipNote, parseGitProbe, planGit,
  restoredGitDirs, unmeasuredGit,
} = await import("../src/workspace/git-dirs.js");
const { s3Excludes } = await import("../src/workspace/excludes.js");
import type { HandsClient } from "../src/clients/hands.js";
import type { GitLimits, GitProbe } from "../src/workspace/git-dirs.js";

const created: string[] = [];
after(() => { for (const d of created) rmSync(d, { recursive: true, force: true }); });

const hex = (s: string): string => Buffer.from(s, "utf8").toString("hex");
const BEGIN = "__claw_git_begin__";
const END = "__claw_git_end__";
const probeOutput = (lines: string[], rc = 0): string => [BEGIN, ...lines, `${END}:${rc}`].join("\n");
// Apparent bytes include a directory's own size (4 KiB on most filesystems), so
// the byte bound is well above what a handful of directories adds and the "big"
// repositories below are well above it.
// The totals are out of the way unless a test is about them.
const FAR = Number.MAX_SAFE_INTEGER;
const LIMITS: GitLimits = { maxBytes: 100_000, maxFiles: 10, totalBytes: FAR, totalFiles: FAR };
const DEFAULT_LIMITS: GitLimits = { maxBytes: 300 * 1024 * 1024, maxFiles: 2000, totalBytes: FAR, totalFiles: FAR };
const BIG = 200_000;

// ── Deciding ────────────────────────────────────────────────────────────

test("decideGit: a repository is carried unless it is over a bound, and the bound is strict", () => {
  const dir = (bytes: number, files: number) => ({ path: "/workspace/r/.git", bytes, files });
  const rows: Array<[label: string, bytes: number, files: number, expected: string | null]> = [
    ["well under both", 10, 3, null],
    ["exactly the byte limit", 100_000, 3, null],
    ["exactly the file limit", 10, 10, null],
    ["one byte over", 100_001, 3, "too_large"],
    ["one file over", 10, 11, "too_many_files"],
    ["over both is reported by its size", 500_000, 50, "too_large"],
    ["size unreadable", -1, 3, "unmeasured"],
    ["file count unreadable", 10, -1, "unmeasured"],
  ];
  for (const [label, bytes, files, expected] of rows) {
    const d = decideGit({ ok: true, dirs: [dir(bytes, files)] }, LIMITS);
    assert.equal(d.mode, "keep", label);
    assert.deepEqual(d.mode === "keep" ? d.skipped.map((s) => s.reason) : [], expected ? [expected] : [], label);
  }
});

test("decideGit: a measurement that cannot be believed is not 'all small enough'", () => {
  const d = decideGit({ ok: false, reason: "find_exit_1" }, LIMITS);
  assert.deepEqual(d, { mode: "drop-all", why: "unmeasured", detail: "find_exit_1" });
});

// Dozens of small clones are each within the per-repository bounds and together
// are tens of thousands of PUTs, which is what the file bound exists to prevent.
const repo = (name: string, bytes: number, files: number) => ({ path: `/workspace/${name}/.git`, bytes, files });
const skippedOf = (d: ReturnType<typeof decideGit>): Array<[string, string]> =>
  (d.mode === "keep" ? d.skipped : []).map((s) => [s.path.replace("/workspace/", "").replace("/.git", ""), s.reason]);

test("decideGit: repositories are also bounded together, and the largest go first", () => {
  const dirs = [repo("a", 10, 5), repo("b", 10, 4), repo("c", 10, 3), repo("d", 10, 2), repo("e", 10, 1)];
  // 15 files; the limit is 10, so the one with 5 goes and 10 remain -- not b as well.
  assert.deepEqual(
    skippedOf(decideGit({ ok: true, dirs }, { ...LIMITS, totalFiles: 10 })),
    [["a", "over_total_files"]],
  );
  // One file less of room and it takes two.
  assert.deepEqual(
    skippedOf(decideGit({ ok: true, dirs }, { ...LIMITS, totalFiles: 9 })),
    [["a", "over_total_files"], ["b", "over_total_files"]],
  );
  // Exactly at the bound is carried, as it is for one repository.
  assert.deepEqual(skippedOf(decideGit({ ok: true, dirs }, { ...LIMITS, totalFiles: 15 })), []);

  // Bytes the same way, independently of files.
  const heavy = [repo("x", 60_000, 1), repo("y", 50_000, 1), repo("z", 10_000, 1)];
  assert.deepEqual(
    skippedOf(decideGit({ ok: true, dirs: heavy }, { ...LIMITS, totalBytes: 100_000 })),
    [["x", "over_total_bytes"]],
  );
});

test("decideGit: a repository already left out for its own size does not count toward the total", () => {
  const dirs = [repo("huge", 500_000, 50), repo("a", 10, 4), repo("b", 10, 4)];
  assert.deepEqual(
    skippedOf(decideGit({ ok: true, dirs }, { ...LIMITS, totalFiles: 8 })),
    [["huge", "too_large"]],
    "8 files carried against a limit of 8: the 50 files of the one already out are not in the sum",
  );
});

test("decideGit: which of equals goes is fixed by the path, not by the order the sandbox listed them", () => {
  const forward = [repo("m", 1, 3), repo("k", 1, 3), repo("l", 1, 3)];
  const a = skippedOf(decideGit({ ok: true, dirs: forward }, { ...LIMITS, totalFiles: 6 }));
  const b = skippedOf(decideGit({ ok: true, dirs: [...forward].reverse() }, { ...LIMITS, totalFiles: 6 }));
  assert.deepEqual(a, [["k", "over_total_files"]]);
  assert.deepEqual(b, a);
});

test("decideGit: files are settled before bytes, so one repository is not dropped twice over", () => {
  // Dropping the file-heaviest repository also brings the bytes under their bound.
  const dirs = [repo("many", 60_000, 9), repo("big", 70_000, 1)];
  assert.deepEqual(
    skippedOf(decideGit({ ok: true, dirs }, { ...LIMITS, totalFiles: 5, totalBytes: 100_000 })),
    [["many", "over_total_files"]],
  );
});

test("unmeasuredGit: a repository nobody could measure is the same situation as a probe that failed", () => {
  const unreadable = decideGit({ ok: true, dirs: [repo("a", -1, 3), repo("b", 10, 3)] }, LIMITS);
  const rows: Array<[label: string, d: Parameters<typeof unmeasuredGit>[0], expected: boolean]> = [
    ["the whole probe failed", { mode: "drop-all", why: "unmeasured", detail: "x" }, true],
    ["one directory's size was unreadable", unreadable, true],
    ["an operator switched it off", { mode: "drop-all", why: "disabled" }, false],
    ["everything was measured", { mode: "keep", skipped: [] }, false],
    [
      "something was measured and found too big",
      { mode: "keep", skipped: [{ ...repo("a", 1e9, 1), reason: "too_large" }] },
      false,
    ],
  ];
  for (const [label, d, expected] of rows) assert.equal(unmeasuredGit(d), expected, label);
});

test("gitReportKey: the same repositories left out for the same reasons are the same news, whatever their sizes", () => {
  const lim: GitLimits = { ...DEFAULT_LIMITS, totalBytes: FAR, totalFiles: FAR };
  const at = (mb: number, over = "/workspace/big/.git") => gitReport(
    { mode: "keep", skipped: [{ path: over, bytes: mb * 1024 * 1024, files: 5, reason: "too_large" }] }, lim, "/workspace",
  )!;
  assert.notEqual(at(351).note, at(353).note, "the sentence moves with the size");
  assert.equal(gitReportKey(at(351)), gitReportKey(at(353)));
  assert.notEqual(gitReportKey(at(351)), gitReportKey(at(351, "/workspace/other/.git")), "another repository is news");

  const twoWays = (order: boolean) => gitReport({
    mode: "keep",
    skipped: [
      { path: "/workspace/a/.git", bytes: 1e9, files: 1, reason: "too_large" as const },
      { path: "/workspace/b/.git", bytes: 1, files: 9e3, reason: "too_many_files" as const },
    ][order ? "slice" : "reverse"](),
  }, lim, "/workspace")!;
  assert.equal(gitReportKey(twoWays(true)), gitReportKey(twoWays(false)), "not the order the sandbox listed them in");

  const reason = gitReport({ mode: "keep", skipped: [{ path: "/workspace/big/.git", bytes: 1, files: 9e3, reason: "too_many_files" }] }, lim, "/workspace")!;
  assert.notEqual(gitReportKey(at(351)), gitReportKey(reason), "the same repository for another reason is news");
  const probe = gitReport({ mode: "drop-all", why: "unmeasured" }, lim, "/workspace")!;
  assert.notEqual(gitReportKey(probe), gitReportKey(at(351)));
});

test("gitPruneExempt: spares what this sync left out, whatever the reason, and nothing else", () => {
  const probeFailed = gitPruneExempt({ mode: "drop-all", why: "unmeasured" }, "/workspace");
  assert.equal(probeFailed("proj/.git/HEAD"), true);
  assert.equal(probeFailed(".git/objects/ab/cd"), true, "the workspace's own repository");
  assert.equal(probeFailed("a/b/.git"), true, "a submodule's pointer file");
  assert.equal(probeFailed("proj/src/a.ts"), false, "an ordinary file is pruned as ever");
  assert.equal(probeFailed("proj/.gitignore"), false, "named like one, is not one");

  const d = decideGit({
    ok: true,
    dirs: [
      repo("it's", -1, 3), repo("other", 10, 3), repo("big", 1e9, 3), repo("many", 10, 50),
      repo("t1", 10, 8), repo("t2", 10, 7),
    ],
  }, { ...LIMITS, totalFiles: 15 });
  const out = gitPruneExempt(d, "/workspace");
  assert.equal(out("it's/.git/HEAD"), true, "could not be read");
  assert.equal(out("big/.git/HEAD"), true, "over the byte bound: its last good copy is what a reclaimed sandbox needs");
  assert.equal(out("many/.git/HEAD"), true, "over the file bound: the project that was just `git add`ed");
  assert.equal(out("t1/.git/HEAD"), true, "the largest, dropped for the total");
  assert.equal(out("t2/.git/HEAD"), false, "carried, so its listing decides");
  assert.equal(out("other/.git/HEAD"), false, "a repository that was measured and carried is pruned like any other");
  assert.equal(out("it's2/.git/HEAD"), false, "the exemption is a directory, not a prefix of a name");
  assert.equal(out("big/src/a.ts"), false, "and only its .git, not the working tree beside it");
  assert.equal(gitPruneExempt({ mode: "drop-all", why: "disabled" }, "/workspace")("proj/.git/HEAD"), false);
});

// ── Reading the measurement ─────────────────────────────────────────────

test("parseGitProbe: what it accepts and what it refuses to believe", () => {
  const ok = (path: string, bytes = 10, files = 2): string => `${bytes} ${files} ${hex(path)}`;
  const rows: Array<[label: string, raw: string, expected: "ok" | string]> = [
    ["no repositories", probeOutput([]), "ok"],
    ["two repositories", probeOutput([ok("/workspace/a/.git"), ok("/workspace/b c/.git")]), "ok"],
    ["a name with a space and a quote", probeOutput([ok("/workspace/it's mine/.git")]), "ok"],
    ["a value find could not read", probeOutput(["-1 -1 " + hex("/workspace/a/.git")]), "ok"],
    ["no opening fence", `${ok("/workspace/a/.git")}\n${END}:0`, "no_begin_fence"],
    ["no closing fence", `${BEGIN}\n${ok("/workspace/a/.git")}`, "no_end_fence"],
    // 1 is `find` reporting a directory it could not read or a file that went away
    // while it walked: not about git, and not a walk that stopped.
    ["find met something unreadable", probeOutput([ok("/workspace/a/.git")], 1), "ok"],
    ["find was killed", probeOutput([ok("/workspace/a/.git")], 137), "find_exit_137"],
    ["find failed outright", probeOutput([ok("/workspace/a/.git")], 2), "find_exit_2"],
    ["Hands says it dropped output", `${probeOutput([])}\n[stdout truncated; 4096 bytes dropped]`, "output_truncated"],
    ["a stray line", probeOutput(["hello", ok("/workspace/a/.git")]), "unexpected_line"],
    ["a path outside the workspace", probeOutput([ok("/etc/.git")]), "path_outside_workspace"],
    ["a path that is not a .git", probeOutput([ok("/workspace/a/b")]), "path_outside_workspace"],
    ["a newline in a path", probeOutput([ok("/workspace/a\nb/.git")]), "path_has_control_character"],
    ["bytes that are not UTF-8", probeOutput([`10 2 ${hex("/workspace/a/")}ff${hex("/.git")}`]), "path_not_utf8"],
  ];
  for (const [label, raw, expected] of rows) {
    const p: GitProbe = parseGitProbe(raw, "/workspace");
    if (expected === "ok") assert.equal(p.ok, true, label);
    else assert.deepEqual(p, { ok: false, reason: expected }, label);
  }
  const p = parseGitProbe(probeOutput([ok("/workspace/b c/.git", 1234, 56)]), "/workspace");
  assert.deepEqual(p.ok && p.dirs, [{ path: "/workspace/b c/.git", bytes: 1234, files: 56 }]);
});

test("a forged closing fence in a path cannot end the measurement early", () => {
  // The path travels as hex, so a directory named like the fence is data.
  const forged = `/workspace/${END}:0/.git`;
  const p = parseGitProbe(probeOutput([`1 1 ${hex(forged)}`]), "/workspace");
  assert.deepEqual(p.ok && p.dirs.map((d) => d.path), [forged]);
});

// ── Telling the user ────────────────────────────────────────────────────

test("gitSkipNote: says which repository, why, and what it costs", () => {
  const big = { path: "/workspace/big/.git", bytes: 412 * 1024 * 1024, files: 40, reason: "too_large" as const };
  const many = { path: "/workspace/many/.git", bytes: 1, files: 3412, reason: "too_many_files" as const };
  const lim: GitLimits = { ...DEFAULT_LIMITS, totalBytes: 1024 * 1024 * 1024, totalFiles: 10_000 };

  assert.equal(gitSkipNote([], false, lim, "/workspace"), null, "nothing left out and nothing unmeasured: nothing to say");

  const note = gitSkipNote([big, many], false, lim, "/workspace")!;
  assert.match(note, /big\/\.git \(412 MB, limit 300 MB\)/);
  assert.match(note, /many\/\.git \(3412 files, limit 2000; git gc packs them\)/);
  assert.match(note, /^Not saved this time: /);
  assert.match(note, /What was saved of them before is kept, but commits made since are not: if the sandbox restarts they are lost, so push them first\.$/);

  assert.match(gitSkipNote([], true, lim, "/workspace")!, /Could not measure the git repositories in \/workspace, so none were saved this time/);
  // Names a repository relative to whatever the workspace root is, not to "/workspace".
  assert.match(gitSkipNote([{ ...big, path: "/srv/ws/a/b/.git" }], true, lim, "/srv/ws")!, /Not saved this time: a\/b\/\.git \(412 MB/);
  assert.match(gitSkipNote([], true, lim, "/srv/ws")!, /repositories in \/srv\/ws,/);

  const together = { path: "/workspace/clone/.git", bytes: 2 * 1024 * 1024, files: 400, reason: "over_total_files" as const };
  assert.match(gitSkipNote([together], false, lim, "/workspace")!, /clone\/\.git \(400 files; together the repositories are over 10000 files\)/);
  const heavy = { ...together, reason: "over_total_bytes" as const };
  assert.match(gitSkipNote([heavy], false, lim, "/workspace")!, /clone\/\.git \(2 MB; together the repositories are over 1024 MB\)/);
  const unknown = { ...together, bytes: -1, reason: "unmeasured" as const };
  assert.match(gitSkipNote([unknown], false, lim, "/workspace")!, /clone\/\.git \(size unknown\)/);

  const lots = Array.from({ length: 5 }, (_, i) => ({ ...big, path: `/workspace/r${i}/.git` }));
  assert.match(gitSkipNote(lots, false, lim, "/workspace")!, /r0\/\.git.*r2\/\.git \(412 MB, limit 300 MB\); and 2 more\./);
});

// ── A sandbox stand-in ──────────────────────────────────────────────────

class Sandbox {
  readonly root = mkdtempSync(join(tmpdir(), "claw-git-ws-"));
  readonly state = `${this.root}-state`;
  readonly store = `${this.root}-store`;
  commands: string[] = [];
  uploaded: string[] = [];
  /** Answers the git measurement itself, as a sandbox whose `du` is broken would. */
  probeReply: string | undefined;

  constructor() { created.push(this.root, this.state, this.store); mkdirSync(this.store, { recursive: true }); }

  put(rel: string, contents: string | Buffer = "x\n"): string {
    const p = join(this.root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, contents);
    return p;
  }

  private local(cmd: string): string {
    return cmd.replaceAll(SYNC_STATE_DIR, this.state).replaceAll("/workspace", this.root);
  }
  private remote(out: string): string {
    return out.replaceAll(this.state, SYNC_STATE_DIR).replaceAll(this.root, "/workspace");
  }
  /**
   * The measurement prints its paths as hex, which the text substitution above
   * cannot reach: decode, redirect, encode, so it reports /workspace paths as the
   * real sandbox's would.
   */
  private remoteProbe(out: string): string {
    return out.split("\n").map((line) => {
      const m = /^(-?\d+ -?\d+ )([0-9a-f]+)$/.exec(line);
      return m ? m[1] + hex(this.remote(Buffer.from(m[2], "hex").toString("utf8"))) : line;
    }).join("\n");
  }

  readonly client = {
    generation: `http://sandbox.test/${this.root}/mcp`,
    callTool: async (tool: string, args: Record<string, unknown>): Promise<string> => {
      if (tool === "bash") {
        const command = String(args.command);
        this.commands.push(command);
        if (command.includes(BEGIN) && this.probeReply !== undefined) return this.probeReply;
        const r = spawnSync("bash", ["-c", this.local(command)], { encoding: "utf-8" });
        const out = command.includes(BEGIN) ? this.remoteProbe(r.stdout ?? "") : this.remote(r.stdout ?? "");
        return r.status === 0 ? out : `exit ${r.status}\nstdout: ${out}\nstderr: ${this.remote(r.stderr ?? "")}`;
      }
      if (tool === "write") {
        const p = this.local(String(args.path));
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, String(args.contents));
        return `Written to ${args.path}`;
      }
      if (tool === "log_s3_upload_manifest") return JSON.stringify({ ok: true });
      if (tool === "upload_to_s3") {
        // An object store: files in, by path. Directories are not objects, which is
        // the property the restore has to cope with.
        const files = args.files as Array<{ local_path: string }>;
        for (const f of files) {
          const rel = f.local_path.replace("/workspace/", "");
          const dst = join(this.store, rel);
          mkdirSync(dirname(dst), { recursive: true });
          writeFileSync(dst, readFileSync(join(this.root, rel)));
          this.uploaded.push(rel);
        }
        return JSON.stringify({ ok: files.map((f) => f.local_path), failed: [], total: files.length });
      }
      throw new Error(`unexpected tool ${tool}`);
    },
  } as unknown as HandsClient;

  sync(gitLimits: GitLimits = DEFAULT_LIMITS) {
    this.uploaded = [];
    return syncWorkspaceToS3(this.client, "sess-git", "user-1", { gitLimits });
  }

  get uploadedSet(): Set<string> { return new Set(this.uploaded); }
}

const GIT_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();

// ── Measuring a real tree ───────────────────────────────────────────────

test("planGit measures real repositories and leaves each bound to its own decision", async () => {
  const sb = new Sandbox();
  sb.put("ok/.git/HEAD", "ref: refs/heads/main\n");
  sb.put("space dir/.git/HEAD", "ref: refs/heads/main\n");
  const bigPack = sb.put("big/.git/objects/pack/pack-1.pack", "");
  truncateSync(bigPack, BIG);
  for (let i = 0; i < 12; i++) sb.put(`many/.git/objects/o${i}`, "o\n");
  // Not this step's business: it is a tree the snapshot drops whole.
  sb.put("node_modules/dep/.git/HEAD", "ref: refs/heads/main\n");

  const d = await planGit(sb.client, "/workspace", s3Excludes(), LIMITS);

  assert.equal(d.mode, "keep");
  const skipped = d.mode === "keep" ? d.skipped : [];
  assert.deepEqual(
    skipped.map((s) => [s.path.replace("/workspace", ""), s.reason]).sort(),
    [["/big/.git", "too_large"], ["/many/.git", "too_many_files"]],
  );
  assert.ok(skipped.every((s) => s.bytes > 0 && s.files > 0), "measured, not guessed");
});

test("planGit counts files, not lines: a name with newlines in it is one file", async () => {
  // Counting `find` output by lines would make these three files look like twelve,
  // over the bound of ten, and a small repository would be left out -- and its
  // saved copy pruned -- on the strength of what it was called.
  const sb = new Sandbox();
  for (const n of ["a\n\n\n", "b\n\n\n", "c\n\n\n"]) sb.put(`odd/.git/objects/${n}`, "o\n");
  sb.put("odd/.git/HEAD", "ref: refs/heads/main\n");

  const p = parseGitProbe(await sb.client.callTool("bash", { command: buildGitProbeCommand("/workspace", s3Excludes()) }), "/workspace");
  assert.deepEqual(p.ok && p.dirs.map((d) => d.files), [4]);

  const d = await planGit(sb.client, "/workspace", s3Excludes(), LIMITS);
  assert.deepEqual(d, { mode: "keep", skipped: [] });
});

test("the measurement is one walk of each repository: its bytes are those of its files, and its files are counted", async () => {
  const sb = new Sandbox();
  sb.put("r/.git/HEAD", "x".repeat(10));
  sb.put("r/.git/objects/pack/p.pack", "y".repeat(20));
  sb.put("r/.git/objects/ab/ee\nodd", "z".repeat(5)); // a name with a newline is one file
  const p = parseGitProbe(await sb.client.callTool("bash", { command: buildGitProbeCommand("/workspace", s3Excludes()) }), "/workspace");
  assert.deepEqual(p.ok && p.dirs, [{ path: "/workspace/r/.git", bytes: 35, files: 3 }]);

  const empty = new Sandbox();
  mkdirSync(join(empty.root, "e/.git"), { recursive: true });
  const e = parseGitProbe(await empty.client.callTool("bash", { command: buildGitProbeCommand("/workspace", s3Excludes()) }), "/workspace");
  assert.deepEqual(e.ok && e.dirs, [{ path: "/workspace/e/.git", bytes: 0, files: 0 }], "a repository with nothing in it is measured as empty");
});

// A directory nobody can read is a fact about the tree, not about git; root reads
// everything, so these only mean something as another user.
const NOT_ROOT = { skip: process.getuid?.() === 0 ? "root can read every directory" : false };

test("an unreadable directory elsewhere in the workspace does not make the repositories unmeasured", NOT_ROOT, async () => {
  const sb = new Sandbox();
  sb.put("proj/.git/HEAD", "ref: refs/heads/main\n");
  sb.put("locked/inside.txt", "x\n");
  chmodSync(join(sb.root, "locked"), 0o000);
  try {
    const d = await planGit(sb.client, "/workspace", s3Excludes(), LIMITS);
    assert.deepEqual(d, { mode: "keep", skipped: [] }, "find exited 1 over `locked`, and the repository is measured all the same");
  } finally {
    chmodSync(join(sb.root, "locked"), 0o755);
  }
});

test("a repository with an unreadable corner of its own is unmeasured, and only that one", NOT_ROOT, async () => {
  const sb = new Sandbox();
  sb.put("bad/.git/HEAD", "ref: refs/heads/main\n");
  sb.put("bad/.git/secret/x", "x\n");
  sb.put("good/.git/HEAD", "ref: refs/heads/main\n");
  chmodSync(join(sb.root, "bad/.git/secret"), 0o000);
  try {
    const d = await planGit(sb.client, "/workspace", s3Excludes(), LIMITS);
    assert.deepEqual(d.mode === "keep" && d.skipped.map((x) => [x.path, x.reason]), [["/workspace/bad/.git", "unmeasured"]]);
  } finally {
    chmodSync(join(sb.root, "bad/.git/secret"), 0o755);
  }
});

test("planGit: a path the command line cannot carry is 'could not measure', not a guess", async () => {
  const sb = new Sandbox();
  sb.put("a\nb/.git/HEAD", "ref: refs/heads/main\n"); // a directory name with a newline in it
  const d = await planGit(sb.client, "/workspace", s3Excludes(), LIMITS);
  assert.deepEqual(d, { mode: "drop-all", why: "unmeasured", detail: "path_has_control_character" });
});

test("planGit: switched off means no measurement at all", async () => {
  const sb = new Sandbox();
  sb.put("r/.git/HEAD", "x\n");
  const d = await planGit(sb.client, "/workspace", s3Excludes(), { ...LIMITS, maxBytes: 0 });
  assert.deepEqual(d, { mode: "drop-all", why: "disabled" });
  assert.equal(sb.commands.length, 0, "a switched-off deployment pays for no extra call");
});

test("planGit: a sandbox that cannot answer is unmeasured, and never throws", async () => {
  const hands = { callTool: async () => { throw new Error("connection reset"); } } as unknown as HandsClient;
  const d = await planGit(hands, "/workspace", s3Excludes(), LIMITS);
  assert.deepEqual(d, { mode: "drop-all", why: "unmeasured", detail: "connection reset" });
});

test("the measuring command only ever reads: no shell syntax of its own is fed a path", () => {
  const cmd = buildGitProbeCommand("/workspace", s3Excludes());
  assert.match(cmd, /^bash <<'__CLAW_GIT_PROBE_EOF__'\n/, "dash has neither pipefail nor read -d");
  assert.ok(cmd.includes("set -o pipefail"));
  assert.ok(cmd.includes("-print0"), "a name may hold anything");
});

// ── The S3 sync ─────────────────────────────────────────────────────────

test("a sync uploads the repository, and what git was in the middle of stays behind", async () => {
  const sb = new Sandbox();
  sb.put("proj/.git/HEAD", "ref: refs/heads/main\n");
  sb.put("proj/.git/objects/pack/pack-1.pack", "pack\n");
  sb.put("proj/.git/refs/heads/main", "abc\n");
  sb.put("proj/.git/index.lock", "");
  sb.put("proj/.git/objects/pack/tmp_pack_x", "half\n");
  sb.put("proj/yarn.lock", "yarn\n");
  sb.put("proj/src/a.ts", "a\n");

  const r = await sb.sync();

  assert.equal(r.git, undefined, "nothing left out, nothing to tell");
  for (const rel of ["proj/.git/HEAD", "proj/.git/objects/pack/pack-1.pack", "proj/.git/refs/heads/main", "proj/yarn.lock", "proj/src/a.ts"]) {
    assert.ok(sb.uploadedSet.has(rel), `${rel} goes up`);
  }
  for (const rel of ["proj/.git/index.lock", "proj/.git/objects/pack/tmp_pack_x"]) {
    assert.ok(!sb.uploadedSet.has(rel), `${rel} is transient`);
  }
});

test("a repository over a bound is not uploaded, in part or whole, and the result says so", async () => {
  const sb = new Sandbox();
  sb.put("small/.git/HEAD", "ref: refs/heads/main\n");
  truncateSync(sb.put("huge/.git/objects/pack/pack-1.pack", ""), BIG);
  sb.put("huge/.git/HEAD", "ref: refs/heads/main\n");
  sb.put("huge/src.txt", "kept\n");

  const r = await sb.sync(LIMITS);

  assert.ok(sb.uploadedSet.has("small/.git/HEAD"));
  assert.ok(sb.uploadedSet.has("huge/src.txt"), "the working tree beside it is not the repository's business");
  assert.deepEqual([...sb.uploadedSet].filter((p) => p.startsWith("huge/.git")), []);
  assert.equal(r.git?.unmeasured, false);
  assert.deepEqual(r.git?.skipped.map((s) => [s.path, s.reason]), [["/workspace/huge/.git", "too_large"]]);
  assert.match(r.git!.note, /huge\/\.git/, "names the repository");
  assert.match(r.git!.note, /push them first/);
});

// What a directory can be called, as the S3 listing's `find -path` has to read it.
const SKIPPED_NAMES: Array<[label: string, skipped: string, decoy: string | null]> = [
  ["plain", "big", null],
  ["space", "my project", null],
  ["glob characters", "x[1]*?", "x1ab"],
  ["single quote", "it's", null],
  ["backslash", "back\\slash", null],
  ["non-ascii", "dir-é", null],
  ["nested", "deep/er/repo", null],
];
for (const [label, skipped, decoy] of SKIPPED_NAMES) {
  test(`the listing leaves out exactly the repository that was measured: ${label}`, async () => {
    const sb = new Sandbox();
    truncateSync(sb.put(`${skipped}/.git/objects/pack/pack-1.pack`, ""), BIG);
    sb.put(`${skipped}/.git/HEAD`, "ref: refs/heads/main\n");
    sb.put(`${skipped}/src.txt`, "kept\n");
    sb.put("small/.git/HEAD", "ref: refs/heads/main\n");
    if (decoy) sb.put(`${decoy}/.git/HEAD`, "ref: refs/heads/main\n");

    await sb.sync(LIMITS);

    assert.deepEqual([...sb.uploadedSet].filter((p) => p.startsWith(`${skipped}/.git`)), []);
    assert.ok(sb.uploadedSet.has(`${skipped}/src.txt`));
    assert.ok(sb.uploadedSet.has("small/.git/HEAD"));
    if (decoy) assert.ok(sb.uploadedSet.has(`${decoy}/.git/HEAD`), "a name the skipped one would match as a pattern");
  });
}

/** What an earlier sync left in the bucket, as keys under the session prefix. */
const saved = (...rels: string[]): void => { bucket.clear(); for (const r of rels) bucket.add(`${PREFIX}${r}`); };
const inBucket = (): string[] => [...bucket].map((k) => k.slice(PREFIX.length)).sort();

test("when the sandbox cannot measure, the rest of the workspace is synced as usual", async () => {
  const sb = new Sandbox();
  sb.put("proj/.git/HEAD", "ref: refs/heads/main\n");
  sb.put("proj/src/a.ts", "a\n");
  saved("proj/.git/HEAD", "proj/src/a.ts");

  // Once, measured: the next sync has a manifest to compare against.
  const healthy = await sb.sync();
  assert.ok(sb.uploadedSet.has("proj/.git/HEAD"));
  const again = await sb.sync();
  assert.ok((again.unchanged ?? 0) > 0, "the delta works on a trusted listing");

  // Then the measurement times out. The repository is not uploaded this time, but
  // that must not turn every later sync into a full re-upload of the workspace for
  // as long as it stays slow: the listing is complete for everything else, so the
  // delta holds and only what changed goes up.
  sb.probeReply = `${BEGIN}\n${END}:2`;
  sb.put("proj/src/b.ts", "b\n");
  const r = await sb.sync();
  assert.equal(r.git?.unmeasured, true);
  assert.match(r.git!.note, /Could not measure/);
  assert.deepEqual([...sb.uploadedSet].filter((p) => p.includes(".git/")), [], "unknown is not 'small enough'");
  assert.deepEqual([...sb.uploadedSet], ["proj/src/b.ts"], "only the file that changed is uploaded");
  assert.ok((r.unchanged ?? 0) > 0, "the delta was not thrown away with the measurement");
  assert.equal(healthy.git, undefined);
});

test("when the sandbox cannot measure, what was saved of every repository stays, and only that", async () => {
  const sb = new Sandbox();
  sb.put("proj/.git/HEAD", "ref: refs/heads/main\n");
  sb.put("proj/src/a.ts", "a\n");
  // A repository whose `.git` is in the bucket from a sync that could measure, a
  // file the user has since deleted, and a deleted repository's last file.
  saved(
    "proj/.git/HEAD", "proj/.git/objects/pack/p.pack", "proj/src/a.ts", "proj/src/deleted.ts",
    "gone/.git/HEAD", "gone/readme.md",
  );
  sb.probeReply = `${BEGIN}\n${END}:2`;

  await sb.sync();

  assert.deepEqual(
    inBucket(),
    ["gone/.git/HEAD", "proj/.git/HEAD", "proj/.git/objects/pack/p.pack", "proj/src/a.ts"],
    "no saved .git object is deleted, whichever repository it is; a file that is not git's still is",
  );
});

test("a measurement that works prunes a repository the user deleted", async () => {
  // The other side of the case above, so that it cannot be satisfied by never
  // pruning a `.git` at all.
  const sb = new Sandbox();
  sb.put("proj/src/a.ts", "a\n");
  saved("proj/src/a.ts", "gone/.git/HEAD", "gone/.git/objects/pack/p.pack");

  await sb.sync();

  assert.deepEqual(inBucket(), ["proj/src/a.ts"]);
});

test("a repository that is left out keeps its saved copy, whatever the reason; the others are pruned as ever", async () => {
  const sb = new Sandbox();
  sb.put("odd/.git/HEAD", "ref: refs/heads/main\n");
  sb.put("fine/.git/HEAD", "ref: refs/heads/main\n");
  sb.put("fine/src.txt", "s\n");
  sb.put("huge/.git/HEAD", "ref: refs/heads/main\n");
  saved(
    "odd/.git/HEAD", "odd/.git/refs/heads/main", // the repository `du` could not read
    "fine/.git/HEAD", "fine/.git/refs/heads/topic", // measured, and the branch is gone from it
    "huge/.git/HEAD", "huge/.git/objects/pack/old.pack", // measured, and over the bound this time
  );
  sb.probeReply = probeOutput([
    `-1 -1 ${hex("/workspace/odd/.git")}`,
    `10 3 ${hex("/workspace/fine/.git")}`,
    `${BIG} 3 ${hex("/workspace/huge/.git")}`,
  ]);

  const r = await sb.sync(LIMITS);

  assert.deepEqual(
    inBucket(),
    [
      "fine/.git/HEAD", "huge/.git/HEAD", "huge/.git/objects/pack/old.pack", "odd/.git/HEAD", "odd/.git/refs/heads/main",
    ],
    "what is left out of this sync is kept as it was saved; the measured ones are judged by what the listing has",
  );
  assert.equal(r.git?.unmeasured, true, "the user is told, and the event says part of it was a measurement problem");
  assert.deepEqual(r.git?.skipped.map((x) => [x.path, x.reason]).sort(), [
    ["/workspace/huge/.git", "too_large"], ["/workspace/odd/.git", "unmeasured"],
  ]);
  assert.ok(sb.uploadedSet.has("fine/src.txt"));
  assert.deepEqual([...sb.uploadedSet].filter((p) => p.startsWith("odd/.git") || p.startsWith("huge/.git")), []);
});

test("a project that outgrows the file bound keeps the history it had when it was small", async () => {
  // The scenario: the agent `git add`s a big project, the loose objects take the
  // repository past the bound, and the next sync leaves it out. Deleting what was
  // saved of it would leave a reclaimed sandbox with files and no history at all,
  // when the last good copy was right there.
  const sb = new Sandbox();
  for (let i = 0; i < 12; i++) sb.put(`proj/.git/objects/o${i}`, "o\n");
  sb.put("proj/.git/HEAD", "ref: refs/heads/main\n");
  sb.put("proj/src.txt", "s\n");
  saved("proj/.git/HEAD", "proj/.git/refs/heads/main", "proj/old-file.txt");

  const r = await sb.sync(LIMITS);

  assert.deepEqual(r.git?.skipped.map((x) => [x.path, x.reason]), [["/workspace/proj/.git", "too_many_files"]]);
  assert.deepEqual(inBucket(), ["proj/.git/HEAD", "proj/.git/refs/heads/main"], "the saved history stays, a file the user deleted does not");
  assert.deepEqual([...sb.uploadedSet].filter((p) => p.includes(".git/")), []);
});

test("a repository that grew after it was measured is held to the file bound by the listing", async () => {
  // The measurement and the listing are two calls with the agent working between
  // them. Here the measurement says three files and the listing finds twelve, which
  // is a thousand PUTs when it is a clone: the upload is built from the listing, so
  // that is where the bound is applied again.
  const sb = new Sandbox();
  for (let i = 0; i < 12; i++) sb.put(`grown/.git/objects/o${i}`, "o\n");
  sb.put("small/.git/HEAD", "ref: refs/heads/main\n");
  sb.put("src.txt", "s\n");
  saved("grown/.git/HEAD");
  sb.probeReply = probeOutput([
    `10 3 ${hex("/workspace/grown/.git")}`,
    `10 1 ${hex("/workspace/small/.git")}`,
  ]);

  const r = await sb.sync(LIMITS);

  assert.deepEqual([...sb.uploadedSet].filter((p) => p.startsWith("grown/")), [], "none of it goes up");
  assert.ok(sb.uploadedSet.has("small/.git/HEAD") && sb.uploadedSet.has("src.txt"));
  assert.deepEqual(r.git?.skipped.map((x) => [x.path, x.reason]), [["/workspace/grown/.git", "too_many_files"]]);
  assert.match(r.git!.note, /grown\/\.git \(12 files, limit 10/);
  assert.deepEqual(inBucket(), ["grown/.git/HEAD"], "and the copy saved before is kept, like any repository left out");
});

test("enforceListedGit: counts what the listing holds, drops whole repositories, and says nothing when all is well", () => {
  const files = (root: string, n: number): string[] =>
    Array.from({ length: n }, (_, i) => `/workspace/${root}/.git/objects/o${i}`);
  const keep = { mode: "keep" as const, skipped: [] };

  const fine = enforceListedGit([...files("a", 3), "/workspace/a/x.txt"], keep, LIMITS);
  assert.equal(fine.decision, keep, "the same decision object: nothing was dropped, nothing changed");
  assert.equal(fine.files.length, 4);

  const grown = enforceListedGit([...files("a", 3), ...files("g", 11), "/workspace/g/x.txt"], keep, LIMITS);
  assert.deepEqual(grown.files, [...files("a", 3), "/workspace/g/x.txt"], "the working tree beside it stays");
  assert.deepEqual(
    grown.decision.mode === "keep" && grown.decision.skipped.map((s) => [s.path, s.reason, s.files]),
    [["/workspace/g/.git", "too_many_files", 11]],
  );

  // The total, across repositories that are each within the bound.
  const total = enforceListedGit([...files("a", 8), ...files("b", 6), ...files("c", 4)], keep, { ...LIMITS, totalFiles: 12 });
  assert.deepEqual(
    total.decision.mode === "keep" && total.decision.skipped.map((s) => [s.path, s.reason]),
    [["/workspace/a/.git", "over_total_files"]],
  );

  // What was already left out keeps its reason, and what is not carried is not counted.
  const prior = { mode: "keep" as const, skipped: [{ path: "/workspace/z/.git", bytes: 1e9, files: 1, reason: "too_large" as const }] };
  const both = enforceListedGit(files("g", 11), prior, LIMITS);
  assert.deepEqual(
    both.decision.mode === "keep" && both.decision.skipped.map((s) => s.reason),
    ["too_large", "too_many_files"],
  );

  // A decision that carries no repository has nothing to hold the listing to.
  const off = { mode: "drop-all" as const, why: "disabled" as const };
  assert.equal(enforceListedGit(files("g", 99), off, LIMITS).decision, off);
});

test("a workspace that holds nothing but a repository left out still tells the user about it", async () => {
  // The listing never saw the repository, so what it found is nothing, and the
  // result says empty; the one thing that explains it is the report.
  const sb = new Sandbox();
  for (let i = 0; i < 12; i++) sb.put(`proj/.git/objects/o${i}`, "o\n");

  const r = await sb.sync(LIMITS);

  assert.equal(r.empty, true);
  assert.deepEqual(r.git?.skipped.map((x) => x.reason), ["too_many_files"]);
});

test("a repository the listing itself drops is not an empty workspace", async () => {
  // Measured small, listed large (it grew in between): the listing is not empty, the
  // upload is, and that is a sync that landed with nothing to put.
  const sb = new Sandbox();
  for (let i = 0; i < 12; i++) sb.put(`proj/.git/objects/o${i}`, "o\n");
  sb.probeReply = probeOutput([`10 3 ${hex("/workspace/proj/.git")}`]);
  saved("proj/.git/HEAD");

  const r = await sb.sync(LIMITS);

  assert.equal(r.empty, false);
  assert.equal(r.uploaded, 0);
  assert.deepEqual(r.git?.skipped.map((x) => x.reason), ["too_many_files"]);
  assert.deepEqual(inBucket(), ["proj/.git/HEAD"]);
});

test("a measurement whose find only met something unreadable still measures", async () => {
  const sb = new Sandbox();
  sb.put("proj/.git/HEAD", "ref: refs/heads/main\n");
  sb.put("proj/src.txt", "s\n");
  // Exit status 1: `find` could not read some directory unrelated to git, as a
  // directory made by a root-owned container is. That used to make every
  // repository "unmeasured" and stop any `.git` being saved again for the session.
  sb.probeReply = probeOutput([`10 1 ${hex("/workspace/proj/.git")}`], 1);

  const r = await sb.sync();

  assert.equal(r.git, undefined, "measured, small, and carried: nothing to tell");
  assert.ok(sb.uploadedSet.has("proj/.git/HEAD"));
});

test("the git measurement is given the budget the caller has", async () => {
  const sb = new Sandbox();
  sb.put("proj/src.txt", "s\n");
  const timeouts: unknown[] = [];
  const inner = sb.client.callTool.bind(sb.client);
  (sb.client as unknown as { callTool: unknown }).callTool = async (tool: string, args: Record<string, unknown>) => {
    if (String(args.command).includes(BEGIN)) timeouts.push(args.timeout);
    return inner(tool, args);
  };

  await syncWorkspaceToS3(sb.client, "sess-git", "user-1", { gitLimits: LIMITS });
  await syncWorkspaceToS3(sb.client, "sess-git", "user-1", { gitLimits: LIMITS, gitProbeTimeoutSec: SIGTERM_PROBE_TIMEOUT_SEC });

  assert.deepEqual(timeouts, [60, SIGTERM_PROBE_TIMEOUT_SEC],
    "a SIGTERM sync with the shared disk unset is an S3 sync, and its budget has no room for a minute");
});

test("many small repositories are held to a limit of their own, largest first", async () => {
  const sb = new Sandbox();
  // Twelve clones of three files: each is far under the per-repository bound of ten.
  for (let i = 0; i < 12; i++) {
    const n = String(i).padStart(2, "0");
    sb.put(`vendor/r${n}/.git/HEAD`, "ref: refs/heads/main\n");
    sb.put(`vendor/r${n}/.git/config`, "[core]\n");
    sb.put(`vendor/r${n}/.git/packed-refs`, "\n");
  }
  sb.put("vendor/r11/.git/objects/extra", "o\n"); // the largest, so the first to go
  sb.put("src.txt", "s\n");

  const r = await sb.sync({ ...LIMITS, totalFiles: 30 });

  const gitFiles = [...sb.uploadedSet].filter((p) => p.includes(".git/"));
  assert.ok(gitFiles.length <= 30, `${gitFiles.length} files of repositories went up; the total bound is 30`);
  assert.ok(!gitFiles.some((p) => p.startsWith("vendor/r11/")), "the largest was dropped first, whole");
  assert.ok(sb.uploadedSet.has("src.txt"));
  const dropped = r.git!.skipped.filter((s) => s.reason === "over_total_files");
  assert.ok(dropped.length > 0);
  assert.deepEqual(r.git!.skipped.filter((s) => s.reason !== "over_total_files"), []);
  assert.equal(r.git!.unmeasured, false);
  assert.match(r.git!.note, /together the repositories are over 30 files/);
  for (const d of dropped) {
    assert.deepEqual(gitFiles.filter((p) => p.startsWith(d.path.replace("/workspace/", "").replace(".git", ".git/"))), []);
  }
});

test("switched off, no repository is uploaded and no measurement is made", async () => {
  const sb = new Sandbox();
  sb.put("proj/.git/HEAD", "ref: refs/heads/main\n");
  sb.put("proj/src/a.ts", "a\n");

  const r = await sb.sync({ ...LIMITS, maxBytes: 0 });

  assert.deepEqual([...sb.uploadedSet].filter((p) => p.includes(".git")), []);
  assert.ok(sb.uploadedSet.has("proj/src/a.ts"));
  assert.equal(sb.commands.some((c) => c.includes(BEGIN)), false);
  assert.equal(r.git, undefined, "an operator's choice is not news to the user");
});

// ── Restoring ───────────────────────────────────────────────────────────

test("restoredGitDirs: only repositories whose HEAD came back", () => {
  assert.deepEqual(
    restoredGitDirs([
      "a.txt", "p/.git/HEAD", "p/.git/objects/pack/x.pack", "p/.git/refs/heads/main",
      "q/r/.git/HEAD", "orphan/.git/objects/x", ".git/HEAD",
      "p/.git/modules/s/HEAD", // a submodule's git dir is not named .git
      "sub/.git", // a submodule's pointer file
    ]),
    [".git", "p/.git", "q/r/.git"],
  );
});

test("an object store keeps no empty directories, and a restore has to put them back", async () => {
  // The whole scenario: work in a repository, the sandbox is reclaimed, a new one
  // is rebuilt from the object store.
  const sb = new Sandbox();
  const repo = join(sb.root, "proj");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "unpushed work");
  // A repository that has been through `git gc` keeps its refs in packed-refs and
  // its objects in a pack: every directory that used to hold a loose file is empty.
  git(repo, "gc", "-q");
  const head = git(repo, "rev-parse", "HEAD");

  await sb.sync();

  // The next sandbox: what the store has, written back as files, which is what
  // `download_from_s3` does. Empty directories were never objects.
  const fresh = new Sandbox();
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [relative(sb.store, p)];
  });
  const rels = walk(sb.store);
  for (const rel of rels) fresh.put(rel, readFileSync(join(sb.store, rel)));
  const restored = join(fresh.root, "proj");

  assert.throws(
    () => git(restored, "rev-parse", "HEAD"),
    /not a git repository/,
    "without the empty directories git does not see a repository, which is the failure this guards",
  );

  await ensureGitSkeleton(fresh.client, "/workspace", rels);

  assert.equal(git(restored, "rev-parse", "HEAD"), head, "the commit that was never pushed");
  assert.equal(git(restored, "log", "-1", "--format=%s"), "unpushed work");
  assert.equal(git(restored, "status", "--porcelain"), "");
});

test("the skeleton is put back only where a repository came back, and is idempotent", () => {
  const sb = new Sandbox();
  sb.put("p/.git/HEAD", "ref: refs/heads/main\n");
  const cmd = buildGitSkeletonCommand("/workspace", restoredGitDirs(["p/.git/HEAD", "ghost/.git/objects/x"]));
  for (let i = 0; i < 2; i++) {
    const r = spawnSync("bash", ["-c", cmd.replaceAll("/workspace", sb.root)], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /OK/);
  }
  for (const d of ["refs/heads", "refs/tags", "objects/pack", "objects/info"]) {
    assert.ok(existsSync(join(sb.root, "p/.git", d)), d);
  }
  assert.ok(!existsSync(join(sb.root, "ghost")), "no .git is conjured for a path whose HEAD did not come back");
});

// ── The shared-disk sync ────────────────────────────────────────────────

const UID = "0123456789abcdef0123456789abcdef";
const SID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

test("the shared-disk sync goes on when it cannot measure, and the script keeps the saved repositories", async () => {
  // It used to stop, which left the snapshot where it was for as long as the
  // workspace was slow to walk -- and a snapshot that never advances loses
  // everything since it when the sandbox is reclaimed, which is worse than the
  // thing it was protecting. What stops a snapshot written without a measurement
  // from losing a `.git` is the script's carry step, so that is what has to be in it.
  const commands: string[] = [];
  const hands = {
    callTool: async (tool: string, args: { command?: string }) => {
      if (tool === "read") return JSON.stringify({ size_bytes: 5, inode_count: 1 });
      commands.push(String(args.command));
      return commands.length === 1 ? "garbage" : "OK";
    },
  } as unknown as HandsClient;

  const r = await syncWorkspace(hands, SID, UID, 1);

  assert.equal(commands.length, 2, "the measurement ran, and so did the script that writes the snapshot");
  assert.ok(commands[1].includes("carry_git"), "which keeps what the previous snapshot holds");
  assert.ok(commands[1].includes(`--exclude '.git'`), "and does not copy a repository it never measured");
  assert.equal(r.git?.unmeasured, true, "the caller can tell the user");
  assert.match(r.git!.note, /Could not measure/);
  assert.equal(classifySyncFailure(new Error("workspace_sync_git_unmeasured")), "rsync_error", "no longer a failure of its own");
});

test("the measurement is given as long as the listing beside it, and a SIGTERM sync is given less", async () => {
  const budgets: Array<{ timeout?: number }> = [];
  const hands = {
    callTool: async (tool: string, args: { command?: string; timeout?: number }) => {
      if (tool === "read") return JSON.stringify({ size_bytes: 5, inode_count: 1 });
      if (String(args.command).includes(BEGIN)) budgets.push({ timeout: args.timeout });
      return String(args.command).includes(BEGIN) ? probeOutput([]) : "OK";
    },
  } as unknown as HandsClient;

  await syncWorkspace(hands, SID, UID, 1);
  await syncWorkspace(hands, SID, UID, 2, { kind: "sigterm" });

  assert.deepEqual(budgets.map((b) => b.timeout), [60, SIGTERM_PROBE_TIMEOUT_SEC]);
  assert.ok(SIGTERM_PROBE_TIMEOUT_SEC <= 10, "the SIGTERM budget has no room for a long measurement");
});

test("the shared-disk sync tells the script which repositories to leave out, and reports them", async () => {
  const commands: string[] = [];
  const hands = {
    callTool: async (tool: string, args: { command?: string }) => {
      if (tool === "read") return JSON.stringify({ size_bytes: 5, inode_count: 1 });
      commands.push(String(args.command));
      if (commands.length === 1) {
        return probeOutput([`${5 * 1024 * 1024 * 1024} 10 ${hex("/workspace/it's big/.git")}`, `10 3 ${hex("/workspace/small/.git")}`]);
      }
      return "OK";
    },
  } as unknown as HandsClient;

  const r = await syncWorkspace(hands, SID, UID, 1);

  assert.deepEqual(r.git?.skipped.map((s) => [s.path, s.reason]), [["/workspace/it's big/.git", "too_large"]]);
  assert.equal(r.git?.unmeasured, false);
  assert.match(r.git!.note, /big\/\.git/, "the note the user is shown comes with the result");
  const script = commands[1];
  assert.ok(script.includes(`--exclude '/it'\\''s big/.git'`), "the repository over the bound, quoted for the shell");
  assert.ok(!script.includes("small/.git"), "and only that one");
  assert.ok(script.includes(`--exclude '.git/**.lock'`), "git's transient files are always left behind");
});
