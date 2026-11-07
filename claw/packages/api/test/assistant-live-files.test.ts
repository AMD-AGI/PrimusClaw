// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What `work_recall(item, "live")` reads from a running worker's workspace (`live-files.ts`): the script run by a real bash over a real
 * directory, as Hands runs it in the sandbox, and its output as the router is given it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe } from "node:test";

import { LIVE_FILE_TAIL_CHARS, LIVE_FILES_MAX, liveFilesScript, parseLiveFiles } from "../src/assistant/live-files.js";

const root = mkdtempSync(join(tmpdir(), "claw-live-files-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** Write a file with its modification time `secondsAgo` before now. */
function put(path: string, content: string | Buffer, secondsAgo: number): void {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  const t = Date.now() / 1000 - secondsAgo;
  utimesSync(full, t, t);
}

const run = (dir: string): string => execFileSync("bash", ["-c", liveFilesScript(dir)], { encoding: "utf8", timeout: 10_000 });

describe("a running worker's files, read now", () => {
  test("the newest text files of the workspace, their tails, masked, each with the time it was written", () => {
    const steps = Array.from({ length: 5 }, (_, i) => `2026-11-06T23:0${i}:27Z step ${i + 1}/16 acc=${i * 7}`).join("\n");
    put("job/progress.log", `${steps}\n`, 5);
    put("job/stdout.log", `${"noise line\n".repeat(600)}last output line GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n`, 20);
    put("job/stderr.log", "", 30);
    put("job/result.bin", Buffer.from([0, 1, 2, 3, 0, 255, 0, 7]), 1);
    put("job/old.log", "an hour and more ago\n", 2 * 3600);
    put("job/fourth.log", "older than the three newest\n", 60);
    put(".env", "SECRET=hidden\n", 0);
    put("repo/.git/HEAD", "ref: refs/heads/main\n", 0);
    put("repo/node_modules/pkg/install.log", "a dependency\n", 0);

    const out = parseLiveFiles(run(root));
    assert.equal(out.status, "read");
    if (out.status !== "read") return;
    assert.equal(out.files.length, LIVE_FILES_MAX);
    assert.deepEqual(out.files.map((f) => f.path), ["job/progress.log", "job/stdout.log", "job/stderr.log"],
      "newest first; a binary, a hidden file, a dependency tree, an old file and the fourth are not read");
    const [progress, stdout, stderr] = out.files;
    assert.ok(progress.tail.endsWith("2026-11-06T23:04:27Z step 5/16 acc=28"), progress.tail);
    assert.ok(Math.abs(Date.parse(progress.modified_at) - (Date.now() - 5000)) < 3000, "the time it was written");
    assert.ok(Math.abs(Date.parse(out.read_at) - Date.now()) < 5000, "when it was read");
    assert.ok(stdout.tail.length <= LIVE_FILE_TAIL_CHARS + 1 && stdout.tail.startsWith("…"), "the tail of a long file");
    assert.match(stdout.tail, /last output line/);
    assert.ok(!stdout.tail.includes("ghp_abcdefghijklmnop"), "a credential is masked");
    assert.equal(stderr.tail, "");
    assert.equal(stderr.size, 0);
  });

  test("a path with spaces and odd characters is read whole; nothing in a file breaks the framing", () => {
    const dir = mkdtempSync(join(tmpdir(), "claw-live-files-odd-"));
    try {
      writeFileSync(join(dir, "my log @@FILE 1 2 x.txt"), "line one\n@@FILE 9 9 Zm9v\n@@NOW 1\nreal last line\n");
      const out = parseLiveFiles(execFileSync("bash", ["-c", liveFilesScript(dir)], { encoding: "utf8" }));
      assert.equal(out.status, "read");
      if (out.status !== "read") return;
      assert.equal(out.files.length, 1);
      assert.equal(out.files[0].path, "my log @@FILE 1 2 x.txt");
      assert.ok(out.files[0].tail.endsWith("real last line"));
      assert.ok(Math.abs(Date.parse(out.read_at) - Date.now()) < 5000, "the file's text is not the script's clock");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a listed file swapped for a link since is not read: not outside the workspace, not a hidden file", () => {
    const dir = mkdtempSync(join(tmpdir(), "claw-live-files-swap-"));
    const outside = mkdtempSync(join(tmpdir(), "claw-live-files-outside-"));
    const shim = mkdtempSync(join(tmpdir(), "claw-live-files-shim-"));
    try {
      mkdirSync(join(dir, "job"));
      writeFileSync(join(outside, "secret.txt"), "OUTSIDE THE WORKSPACE\n");
      writeFileSync(join(dir, ".env"), "HIDDEN=1\n");
      writeFileSync(join(dir, "job/progress.log"), "step 5/16\n");
      symlinkSync(join(outside, "secret.txt"), join(dir, "job/out.log"));
      symlinkSync(join(dir, ".env"), join(dir, "job/env.log"));
      // What \`find\` listed while these were still regular files: the swap happened after it.
      const now = Math.floor(Date.now() / 1000);
      const listed = ["job/out.log", "job/env.log", "job/progress.log"].map((p) => `'${now} 10 ${p}'`).join(" ");
      writeFileSync(join(shim, "find"), `#!/bin/sh\nprintf '%s\\0' ${listed}\n`);
      chmodSync(join(shim, "find"), 0o755);
      const out = parseLiveFiles(execFileSync("bash", ["-c", liveFilesScript(dir)], {
        encoding: "utf8", env: { ...process.env, PATH: `${shim}:${process.env.PATH}` },
      }));
      assert.equal(out.status, "read");
      if (out.status !== "read") return;
      assert.deepEqual(out.files.map((f) => f.path), ["job/progress.log"], "only the file that is what it was listed as");
      assert.ok(!JSON.stringify(out).includes("OUTSIDE"));
      assert.ok(!JSON.stringify(out).includes("HIDDEN"));
    } finally {
      for (const d of [dir, outside, shim]) rmSync(d, { recursive: true, force: true });
    }
  });

  test("an empty or missing workspace reads as no files", () => {
    const out = parseLiveFiles(run(join(root, "does-not-exist")));
    assert.deepEqual(out.status === "read" ? out.files : null, []);
  });
});
