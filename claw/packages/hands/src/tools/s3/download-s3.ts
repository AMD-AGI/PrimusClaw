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
 * Open `rel` below the workspace root for writing, one name at a time from a
 * descriptor of the directory above it, never through a symbolic link, making
 * the directories on the way. Each name is looked up through
 * /proc/self/fd/<dir>/<name>, i.e. relative to that open directory, so swapping
 * a directory for a link at any moment cannot redirect the open.
 *
 * Hands writes as its own identity, which can differ from the one the model's
 * commands run as, and a download into a sandbox that is already running (the
 * uploads a reused sandbox is given) lands where links made there point. Only
 * the part below the workspace root is checked: the root itself is the
 * deployment's to place.
 */
function openBelow(root: string, rel: string): { fd: number; created: boolean } | { not: string } {
  const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_DIRECTORY, O_NONBLOCK } = fs.constants;
  const WRITE = O_WRONLY | O_NOFOLLOW | O_NONBLOCK;   // a FIFO planted there fails instead of hanging the call
  const parts = rel.split(path.sep);
  const name = parts.pop()!;
  let dir = fs.openSync(root, O_RDONLY | O_DIRECTORY);
  let shown = root;
  const notThrough = (e: any, at: string): { not: string } => {
    if (e?.code !== "ELOOP" && e?.code !== "ENOTDIR") throw e;
    let link = false;
    try {
      link = fs.lstatSync(at).isSymbolicLink();
    } catch {
      // gone again: report it as what the open saw
    }
    return { not: `${shown} is ${link || e.code === "ELOOP" ? "a symbolic link" : "not a directory"}` };
  };
  try {
    for (const part of parts) {
      const at = `/proc/self/fd/${dir}/${part}`;
      shown = path.join(shown, part);
      try {
        fs.mkdirSync(at);
      } catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
      }
      let next: number;
      try {
        next = fs.openSync(at, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      } catch (e: any) {
        return notThrough(e, at);
      }
      fs.closeSync(dir);
      dir = next;
    }
    const at = `/proc/self/fd/${dir}/${name}`;
    shown = path.join(shown, name);
    try {
      return { fd: fs.openSync(at, WRITE | O_CREAT | O_EXCL), created: true };
    } catch (e: any) {
      if (e?.code !== "EEXIST") return notThrough(e, at);
    }
    try {
      return { fd: fs.openSync(at, WRITE), created: false };
    } catch (e: any) {
      return notThrough(e, at);
    }
  } finally {
    fs.closeSync(dir);
  }
}

/**
 * Write `body` to `p` only if the file opened is the one `p` names inside the
 * workspace; returns why not, or null when written.
 *
 * The file is opened by openBelow and written only through that descriptor, so
 * the bytes can reach no file but the one opened inside the workspace. Nothing
 * stops another process renaming a directory holding it while it is written, so
 * where it is is asked again after the write: a file moved out meanwhile, or a
 * write that failed part way, is emptied again (and removed, if this call
 * created it). A move after that is a move of a finished file, which no write
 * can prevent.
 */
function writeWhereNamed(p: string, body: Buffer): string | null {
  const named = path.relative(path.resolve(WORKSPACE), p);
  if (!named || named.startsWith("..") || path.isAbsolute(named)) {
    // a path the caller named outside the workspace is written as it always was
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return null;
  }
  const root = fs.realpathSync(path.resolve(WORKSPACE));
  const opened = openBelow(root, named);
  if ("not" in opened) return `not written: ${opened.not}`;
  const { fd, created } = opened;
  const undo = () => {
    fs.ftruncateSync(fd, 0);
    if (created) removeCreated(fd);
  };
  try {
    const before = placeOf(fd, root);
    if ("not" in before) {
      if (created) removeCreated(fd);
      return `not written: ${p} ${before.not}`;
    }
    try {
      fs.ftruncateSync(fd, 0);
      fs.writeFileSync(fd, body);
    } catch (e) {
      undo();
      throw e;
    }
    const after = placeOf(fd, root);
    if ("not" in after) {
      undo();
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
