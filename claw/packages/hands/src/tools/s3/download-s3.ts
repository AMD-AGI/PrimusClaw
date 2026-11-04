// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { guardPath } from "../../runtime/path-guard.js";
import { WORKSPACE } from "../../config.js";

const downloadItem = z.object({
  local_path: z.string(),
  presigned_url: z.string(),
  // The object's size: a file already there with this size is not fetched again.
  size: z.number().int().nonnegative().optional(),
});

const schema = {
  files: z.array(downloadItem).describe("Array of {local_path, presigned_url} to download"),
};

function sizeOf(p: string): number | null {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/**
 * The first symbolic link on the way from the workspace root to `p`, if any.
 *
 * Hands writes as its own identity, which can differ from the one the model's
 * commands run as, and a download into a sandbox that is already running (the
 * uploads a reused sandbox is given) lands where links made there point. Only
 * the part below the workspace root is checked: the root itself is the
 * deployment's to place.
 */
function linkOnTheWay(p: string): string | null {
  const root = path.resolve(WORKSPACE);
  const rel = path.relative(root, p);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  let at = root;
  for (const part of rel.split(path.sep)) {
    at = path.join(at, part);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(at);
    } catch {
      return null;   // nothing there yet: the rest is created below, as directories
    }
    if (st.isSymbolicLink()) return at;
  }
  return null;
}

/**
 * Where the file open on `fd` is now, or why it does not count as inside `root`.
 *
 * The path is the kernel's, read back from /proc, so it follows renames. A file
 * with a second name could be one outside the workspace under a name inside it.
 */
function placeOf(fd: number, root: string): { at: string } | { not: string } {
  let at: string;
  try {
    at = fs.readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return { not: "cannot tell which file was opened" };
  }
  const st = fs.fstatSync(fd);
  if (!st.isFile() || st.nlink !== 1) return { not: `${at} is not a file with one name` };
  const rel = path.relative(root, at);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return { not: `resolved to ${at}, outside the workspace` };
  return { at };
}

/** Remove the file this call created on `fd`, under whatever name it has now, if that name is still it. */
function removeCreated(fd: number): void {
  try {
    const at = fs.readlinkSync(`/proc/self/fd/${fd}`);
    const mine = fs.fstatSync(fd);
    const there = fs.lstatSync(at);
    if (there.ino === mine.ino && there.dev === mine.dev) fs.unlinkSync(at);
  } catch {
    // already gone, or no longer reachable by that name
  }
}

/**
 * Write `body` to `p` only if the file opened is the one `p` names inside the
 * workspace; returns why not, or null when written.
 *
 * Any path check can be raced: a directory on the way can be swapped for a link
 * before the open, or renamed out of the workspace after it. So the file is
 * opened first (not truncated, not through a final link), and only a file the
 * kernel says is inside the workspace is written, through that descriptor; the
 * bytes then can only reach that one file. Where it is is asked again after the
 * write: a file moved out meanwhile is emptied again (and removed, if this call
 * created it). A move after that is a move of a finished file, which no write
 * can prevent.
 */
function writeWhereNamed(p: string, body: Buffer): string | null {
  const named = path.relative(path.resolve(WORKSPACE), p);
  if (!named || named.startsWith("..") || path.isAbsolute(named)) {
    fs.writeFileSync(p, body);   // a path the caller named outside the workspace is written as it always was
    return null;
  }
  const root = fs.realpathSync(path.resolve(WORKSPACE));
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
  let created = true;
  let fd: number;
  try {
    fd = fs.openSync(p, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW);
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
    created = false;
    fd = fs.openSync(p, O_WRONLY | O_NOFOLLOW);
  }
  try {
    const before = placeOf(fd, root);
    if ("not" in before) {
      if (created) removeCreated(fd);
      return `not written: ${p} ${before.not}`;
    }
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, body);
    const after = placeOf(fd, root);
    if ("not" in after) {
      fs.ftruncateSync(fd, 0);
      if (created) removeCreated(fd);
      return `not written: ${p} was moved while being written and ${after.not}`;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Counterpart to upload_to_s3 — pulls files from S3 into the sandbox using
 * pre-signed GET URLs. Same zero-credential model: Brain signs, Hands fetches.
 * Returns a structured JSON envelope so Brain can retry failures.
 */
export const downloadS3 = {
  name: "download_from_s3",
  description: "Download files from S3 using pre-signed GET URLs (no S3 credentials needed)",
  zodSchema: schema,
  execute: async (args: { files: Array<{ local_path: string; presigned_url: string; size?: number }> }) => {
    const ok: string[] = [];
    const failed: Array<{ path: string; status: number; error: string }> = [];
    for (const file of args.files) {
      try {
        const safePath = guardPath(file.local_path);
        if (file.size !== undefined && sizeOf(safePath) === file.size) {
          ok.push(file.local_path);
          continue;
        }
        const resp = await fetch(file.presigned_url);
        if (!resp.ok) {
          failed.push({ path: file.local_path, status: resp.status, error: (await resp.text().catch(() => "")).slice(0, 200) });
          continue;
        }
        const body = Buffer.from(await resp.arrayBuffer());
        const link = linkOnTheWay(safePath);
        if (link) {
          failed.push({ path: file.local_path, status: 0, error: `not written: ${link} is a symbolic link` });
          continue;
        }
        fs.mkdirSync(path.dirname(safePath), { recursive: true });
        const written = writeWhereNamed(safePath, body);
        if (written) {
          failed.push({ path: file.local_path, status: 0, error: written });
          continue;
        }
        ok.push(file.local_path);
      } catch (e: any) {
        failed.push({ path: file.local_path, status: 0, error: e?.message || String(e) });
      }
    }
    const result = { ok, failed, total: args.files.length };
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
};
