// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORKSPACE } from "../../config.js";

/** The largest diff a file tool returns; a bigger one is left out (`diff_omitted: "too_large"`), never cut. */
export const DIFF_MAX_BYTES = 64 * 1024;
/** A file bigger than this before or after the change is not diffed at all. */
const DIFF_INPUT_MAX_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5_000;

/** A file as it was before a tool changed it: its bytes and mode, or null for a file that did not exist. */
export interface FileBefore {
  abs: string;
  content: Buffer | null;
  mode: number | null;
  /** Too big to diff, or unreadable: no diff is made. */
  skip?: "too_large" | "unavailable";
}

/** What a file tool's result says about its change (`structuredContent`). */
export type FileDiff = { diff: string } | { diff_omitted: "too_large" | "unavailable" } | Record<string, never>;

/** Read `abs` before it is changed. */
export function fileBefore(abs: string): FileBefore {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return { abs, content: null, mode: null, skip: "unavailable" };
    if (st.size > DIFF_INPUT_MAX_BYTES) return { abs, content: null, mode: null, skip: "too_large" };
    return { abs, content: fs.readFileSync(abs), mode: st.mode & 0o777 };
  } catch (e: any) {
    if (e?.code === "ENOENT") return { abs, content: null, mode: null };
    return { abs, content: null, mode: null, skip: "unavailable" };
  }
}

function git(args: string[], cwd: string): { status: number | null; stdout: string } {
  const r = spawnSync("git", ["-c", "safe.directory=*", ...args], {
    cwd, encoding: "utf-8", timeout: GIT_TIMEOUT_MS, maxBuffer: DIFF_MAX_BYTES * 4,
    // Never a pager or a prompt: this runs with no terminal.
    env: { ...process.env, GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
  });
  if (r.error) return { status: null, stdout: "" };
  return { status: r.status, stdout: r.stdout };
}

/**
 * Where `git diff` in this file's repository names it: the repository's top level and the path from there. A file outside
 * any repository is named from the workspace, or from its own directory when it is outside that too.
 */
function nameOf(abs: string): { root: string; rel: string } {
  const top = git(["rev-parse", "--show-toplevel"], path.dirname(abs));
  const candidates = top.status === 0 && top.stdout.trim() ? [top.stdout.trim(), WORKSPACE] : [WORKSPACE];
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
  for (const root of candidates) {
    const rel = path.relative(real(root), real(abs));
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return { root, rel: rel.split(path.sep).join("/") };
  }
  return { root: path.dirname(abs), rel: path.basename(abs) };
}

/**
 * One file's change as `git diff` shows it in its repository: `git diff --no-index` of the old bytes against the file, run from
 * the repository's top level so that its config (diff algorithm, abbreviation, prefixes) is the one a `git diff` there reads,
 * then with the old copy's temporary name replaced by the file's own. So for a file that was clean before the change the text is
 * byte for byte what `git diff` (or, for a new file, `git add -N` then `git diff`) prints. Null: no change. Throws when git is
 * missing or failed.
 */
function diffOne(before: FileBefore): { rel: string; text: string } | null {
  const { root, rel } = nameOf(before.abs);
  let tmpDir: string | null = null;
  let oldArg = "/dev/null";
  try {
    if (before.content !== null) {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hands-diff-"));
      oldArg = path.join(tmpDir, "old");
      fs.writeFileSync(oldArg, before.content);
      if (before.mode !== null) fs.chmodSync(oldArg, before.mode);
    }
    const r = git(["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--", oldArg, rel], root);
    if (r.status === 0) return null;
    if (r.status !== 1) throw new Error(`git diff exited ${r.status}`);
    return { rel, text: oldArg === "/dev/null" ? r.stdout : renameOld(r.stdout, oldArg) };
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** The old side of a `--no-index` diff names the temporary copy; name it as the file itself, as `git diff` does. */
function renameOld(out: string, tmp: string): string {
  const lines = out.split("\n");
  const plusAt = lines.findIndex((l) => l.startsWith("+++ "));
  const binaryAt = lines.findIndex((l) => l.startsWith("Binary files "));
  let bSide: string | undefined;
  if (plusAt !== -1 && (binaryAt === -1 || plusAt < binaryAt)) bSide = lines[plusAt]!.slice(4);
  else if (binaryAt !== -1) bSide = / and (.*) differ$/.exec(lines[binaryAt]!)?.[1];
  if (!bSide) throw new Error("unrecognised git diff header");
  const aSide = bSide.replace(/^("?)b\//, "$1a/");
  const tmpA = `a/${tmp.replace(/^\/+/, "")}`;
  const headerEnd = lines.findIndex((l) => l.startsWith("@@"));
  for (let i = 0; i < (headerEnd === -1 ? lines.length : headerEnd); i++) {
    const l = lines[i]!;
    if (l.startsWith("diff --git ")) lines[i] = `diff --git ${aSide} ${bSide}`;
    else if (l.startsWith("--- ") && l.includes(tmpA)) lines[i] = `--- ${aSide}`;
    else if (l.startsWith("Binary files ") && l.includes(tmpA)) lines[i] = `Binary files ${aSide} and ${bSide} differ`;
  }
  return lines.join("\n");
}

/**
 * The change a file tool made to `befores` (each file as it was before), as one unified diff in the order `git diff` lists
 * files, for the tool's `structuredContent`. Empty when nothing changed; `diff_omitted` when there is a change that is not
 * shown: too large, or no git in the sandbox to make it.
 */
export function diffOf(befores: FileBefore[]): FileDiff {
  const skipped = befores.find((b) => b.skip);
  if (skipped?.skip) return { diff_omitted: skipped.skip };
  const parts: Array<{ rel: string; text: string }> = [];
  try {
    for (const b of befores) {
      const one = diffOne(b);
      if (one) parts.push(one);
    }
  } catch {
    return { diff_omitted: "unavailable" };
  }
  if (!parts.length) return {};
  parts.sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0));
  const diff = parts.map((p) => p.text).join("");
  if (Buffer.byteLength(diff) > DIFF_MAX_BYTES) return { diff_omitted: "too_large" };
  return { diff };
}
