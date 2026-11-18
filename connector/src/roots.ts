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

// --- what a phone sends ----------------------------------------------------------------

export interface ResolveOptions {
  /** The home directory `~` stands for: the one the agent's adapter runs with. */
  home: string;
  /** How long one look at a root or the folder may take before it counts as unavailable (a stalled network mount). */
  timeoutMs?: number;
  /** The file system calls (tests stand in a mount that never answers). */
  fs?: Pick<typeof fs.promises, "realpath" | "stat">;
}

/** A root whose last look never came back: asked again only once that look ends, so a dead mount ties up one thread, not all. */
const stalled = new Set<string>();

class Stalled extends Error {}

/** `fs.promises` call `f` with a deadline; the event loop never waits on the file system. */
async function bounded<T>(what: string, f: () => Promise<T>, ms: number): Promise<T> {
  if (stalled.has(what)) throw new Stalled(what);
  let timer: NodeJS.Timeout | undefined;
  const call = f();
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Stalled(what)), ms); timer.unref?.(); });
  try {
    return await Promise.race([call, late]);
  } catch (e) {
    if (e instanceof Stalled) {
      stalled.add(what);
      void call.then(() => stalled.delete(what), () => stalled.delete(what));
    }
    throw e;
  } finally { clearTimeout(timer); }
}

type Fsp = Pick<typeof fs.promises, "realpath" | "stat">;
const realpathOf = (p: string, ms: number, f: Fsp = fs.promises) => bounded(p, () => f.realpath(p), ms);
const isDir = async (p: string, ms: number, f: Fsp = fs.promises) => {
  try { return (await bounded(`stat:${p}`, () => f.stat(p), ms)).isDirectory(); } catch (e) { if (e instanceof Stalled) throw e; return false; }
};

/**
 * Turn what a person typed on a phone into a folder this agent may work in, and check it as {@link checkCwd} does:
 *  - `~` and `~/x`: the agent's home directory;
 *  - a relative path (`repo`, `repo/sub`): looked up under each root, and taken when exactly one root has it; a name
 *    that is a root's own last segment is that root (`repo-a` for a root `~/work/repo-a`);
 *  - anything else: as before, an absolute path whose canonical form is inside a root.
 * Every look at the disk is asynchronous and bounded: a root on a network mount that stopped answering gives
 * `root_unavailable` for that session instead of freezing the whole connector (heartbeats included).
 */
export async function resolveCwd(cwd: string, roots: string[], o: ResolveOptions): Promise<CwdVerdict> {
  const ms = o.timeoutMs ?? 10_000;
  if (typeof cwd !== "string" || cwd.trim() === "" || cwd.includes("\0")) return { ok: false, reason: "invalid_cwd" };
  const typed = cwd.trim();
  let candidates: string[];
  if (typed === "~" || typed.startsWith("~/")) candidates = [path.join(o.home, typed.slice(2))];
  else if (path.isAbsolute(typed)) candidates = [typed];
  else if (typed.startsWith("~")) return { ok: false, reason: "cwd_not_absolute" }; // ~otheruser: another account's home
  else {
    const clean = path.normalize(typed).replace(/\/+$/, "");
    if (clean === ".." || clean.startsWith("../")) return { ok: false, reason: "cwd_outside_roots" };
    candidates = [...new Set([
      ...roots.map((r) => path.join(r, clean)),
      ...roots.filter((r) => path.basename(r) === clean),
    ])];
  }
  // Each root on its own: one that is missing or stalled takes out its own folders, never those under a healthy root.
  const realRoots: string[] = [];
  const down: string[] = [];
  await Promise.all(roots.map(async (r) => {
    try { realRoots.push(await realpathOf(r, ms, o.fs)); } catch { down.push(path.resolve(r)); }
  }));
  const underDown = (p: string) => down.some((r) => inside(path.resolve(p), r));
  const hits = new Map<string, true>();
  let unavailable = false;
  for (const c of candidates) {
    // A folder under a root that is not there (a mount not mounted yet, or not answering) is not looked at at all.
    if (underDown(c)) { unavailable = true; continue; }
    let real: string;
    try { real = await realpathOf(c, ms, o.fs); } catch (e) { if (e instanceof Stalled) unavailable = true; continue; }
    let dir: boolean;
    try { dir = await isDir(real, ms, o.fs); } catch { unavailable = true; continue; }
    if (!dir) { if (candidates.length === 1) return { ok: false, reason: "cwd_not_directory" }; continue; }
    if (realRoots.some((r) => inside(real, r))) hits.set(real, true);
    else if (candidates.length === 1) return { ok: false, reason: "cwd_outside_roots" };
  }
  if (hits.size > 1) return { ok: false, reason: "cwd_ambiguous" };
  // A name found under a healthy root while another root cannot be read could be ambiguous; the healthy one is taken.
  if (hits.size === 1) return { ok: true, real: [...hits.keys()][0]! };
  return { ok: false, reason: unavailable ? "root_unavailable" : "cwd_not_found" };
}

/**
 * The roots of these agents that cannot be used now, one sentence each, for `run` to print. A root that is missing or
 * does not answer is not a configuration error: a network mount may come back, and its sessions work again then.
 */
export async function rootProblems(agents: Array<{ id: string; roots: string[] }>, timeoutMs = 10_000): Promise<string[]> {
  const out: string[] = [];
  await Promise.all(agents.flatMap((a) => a.roots.map(async (r) => {
    try {
      const real = await realpathOf(r, timeoutMs);
      if (!(await isDir(real, timeoutMs))) out.push(`${a.id}: root ${r} is not a directory; sessions there are refused`);
    } catch (e) {
      out.push(e instanceof Stalled
        ? `${a.id}: root ${r} does not answer (a stalled network mount?); its sessions are refused (root_unavailable) until it does`
        : `${a.id}: root ${r} does not exist (yet); its sessions are refused until it does (create it, or fix roots in agents.toml)`);
    }
  })));
  return out.sort();
}

/** Whether `p` (absolute or relative to `cwd`) is a path inside `cwd`, for auto-allow rules. */
export function relativeInside(p: string, cwd: string): string | null {
  const abs = path.resolve(cwd, p);
  let real: string;
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
