// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
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
 * Where the file or directory open on `fd` is now, or why it does not count as
 * inside `root`. The path is the kernel's, read back from /proc, so it follows
 * renames.
 */
function placeOf(fd: number, root: string): string | null {
  let at: string;
  try {
    at = fs.readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return "cannot tell which file was opened";
  }
  return below(root, at) === null ? `resolved to ${at}, outside the workspace` : null;
}

/** `p` relative to `root`, or null when it is not `root` or below it. A name like `..x` is below. */
function below(root: string, p: string): string | null {
  const rel = path.relative(root, p);
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) ? null : rel;
}

/**
 * Open the directory `parts` names below the workspace root, one name at a time
 * from a descriptor of the directory above it, never through a symbolic link,
 * making the directories on the way. Each name is looked up through
 * /proc/self/fd/<dir>/<name>, i.e. relative to that open directory, so swapping
 * a directory for a link at any moment cannot redirect the open.
 *
 * Hands writes as its own identity, which can differ from the one the model's
 * commands run as, and a download into a sandbox that is already running (the
 * uploads a reused sandbox is given) lands where links made there point. Only
 * the part below the workspace root is checked: the root itself is the
 * deployment's to place.
 */
function openDirBelow(root: string, parts: string[]): number | string {
  const { O_RDONLY, O_NOFOLLOW, O_DIRECTORY } = fs.constants;
  let dir = fs.openSync(root, O_RDONLY | O_DIRECTORY);
  let shown = root;
  for (const part of parts) {
    const at = `/proc/self/fd/${dir}/${part}`;
    shown = path.join(shown, part);
    let next: number;
    try {
      try {
        fs.mkdirSync(at);
      } catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
      }
      next = fs.openSync(at, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    } catch (e: any) {
      let link = e?.code === "ELOOP";
      try {
        link ||= fs.lstatSync(at).isSymbolicLink();
      } catch {
        // gone again: report it as what the open saw
      }
      fs.closeSync(dir);
      if (e?.code !== "ELOOP" && e?.code !== "ENOTDIR") throw e;
      return `${shown} is ${link ? "a symbolic link" : "not a directory"}`;
    }
    fs.closeSync(dir);
    dir = next;
  }
  return dir;
}

/**
 * Write `body` to `p` only if it lands where `p` names inside the workspace;
 * returns why not, or null when written.
 *
 * The bytes go into a new file only Hands can open (made next to the target
 * through the directory's descriptor), which then takes the target's name in
 * that same directory: no other name, link or file can receive them, and a
 * file already at `p` is replaced rather than written into. Nothing stops
 * another process renaming a directory while this runs, so where the file is
 * is asked after the rename and again after it is opened to others: one moved
 * out before either answer is closed again, emptied and removed. Only a process
 * that can rename a directory in the workspace can move it, and it can read the
 * finished download anyway; a move after the last answer is a move of a
 * finished file, which no write can prevent.
 */
function writeWhereNamed(p: string, body: Buffer): string | null {
  const named = below(path.resolve(WORKSPACE), p);
  if (!named) {
    // a path the caller named outside the workspace is written as it always was
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return null;
  }
  const root = fs.realpathSync(path.resolve(WORKSPACE));
  const parts = named.split(path.sep);
  const name = parts.pop()!;
  const dir = openDirBelow(root, parts);
  if (typeof dir === "string") return `not written: ${dir}`;
  const part = `/proc/self/fd/${dir}/.${name}.${randomBytes(6).toString("hex")}.part`;
  const target = `/proc/self/fd/${dir}/${name}`;
  let fd: number | undefined;
  try {
    const away = placeOf(dir, root);
    if (away) return `not written: ${p} ${away}`;
    const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
    fd = fs.openSync(part, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(fd, body);
      fs.renameSync(part, target);
    } catch (e) {
      fs.rmSync(part, { force: true });
      throw e;
    }
    let moved = placeOf(fd, root);
    if (!moved) {
      fs.fchmodSync(fd, 0o666 & ~process.umask());
      moved = placeOf(fd, root);
    }
    if (moved) {
      fs.fchmodSync(fd, 0o600);
      fs.ftruncateSync(fd, 0);
      const mine = fs.fstatSync(fd);
      const there = fs.lstatSync(target, { throwIfNoEntry: false });
      if (there && there.ino === mine.ino && there.dev === mine.dev) fs.unlinkSync(target);
      return `not written: ${p} was moved while being written and ${moved}`;
    }
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.closeSync(dir);
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
