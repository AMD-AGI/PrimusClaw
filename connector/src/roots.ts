// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The directory whitelist: where an agent is allowed to work. */
import fs from "node:fs";
import path from "node:path";

export type CwdVerdict = { ok: true; real: string } | { ok: false; reason: string };

/** The canonical form of a root, or null when it does not exist. */
export function realRoot(root: string): string | null {
  try {
    return fs.realpathSync.native(root);
  } catch {
    return null;
  }
}

const inside = (child: string, root: string): boolean =>
  child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * `cwd` is acceptable only when its canonical path (symlinks resolved) is a
 * directory inside one of the canonical roots. The canonical path is what the
 * agent is started in, so a symlink swapped in after the check changes nothing.
 */
export function checkCwd(cwd: string, roots: string[]): CwdVerdict {
  if (typeof cwd !== "string" || cwd === "" || cwd.includes("\0")) return { ok: false, reason: "invalid_cwd" };
  if (!path.isAbsolute(cwd)) return { ok: false, reason: "cwd_not_absolute" };
  let real: string;
  try {
    real = fs.realpathSync.native(cwd);
  } catch {
    return { ok: false, reason: "cwd_not_found" };
  }
  try {
    if (!fs.statSync(real).isDirectory()) return { ok: false, reason: "cwd_not_directory" };
  } catch {
    return { ok: false, reason: "cwd_not_found" };
  }
  for (const root of roots) {
    const r = realRoot(root);
    if (r && inside(real, r)) return { ok: true, real };
  }
  return { ok: false, reason: "cwd_outside_roots" };
}

/** Whether `p` (absolute or relative to `cwd`) is a path inside `cwd`, for auto-allow rules. */
export function relativeInside(p: string, cwd: string): string | null {
  const abs = path.resolve(cwd, p);
  let real = abs;
  try {
    real = fs.realpathSync.native(abs);
  } catch {
    // Not there yet (a file about to be created): resolve the parent instead.
    try {
      real = path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs));
    } catch {
      return null;
    }
  }
  if (!inside(real, cwd)) return null;
  return path.relative(cwd, real).split(path.sep).join("/");
}
