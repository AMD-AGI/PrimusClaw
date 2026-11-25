// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The Claude Code hooks are the connector's to keep in place, like its own version: every start of the connector (and so the
 * first run after an auto-upgrade) makes sure the session hooks and the approval hooks are in each Claude config directory it
 * serves, pointing at the program that is running now, and `init` and `pair` do the same without asking. Nothing is printed
 * to the person beyond one line in the connector's log when something changed.
 *
 * Only an explicit no stops it, and it is kept for good (in the configuration directory, next to agents.toml, so it outlives
 * the state directory): `hooks uninstall` (both sets, or `--approvals` for the approval hooks only) for the directories it
 * names, `--no-hooks` / `--no-approval-hooks` on `init` or `pair` for every directory, and a "no" to the question 0.1.23 to
 * 0.3.3 asked once per directory (approval-hooks-offer.json in the state directory). `hooks install` takes a no back for the
 * directories it names, as `init --hooks` / `pair --hooks` do for every directory.
 *
 * Versions up to 0.3.3 recorded no other no: `hooks uninstall`, `--no-hooks` and a "n" at the init/pair question only left the
 * hooks out of settings.json. So the first time this version needs the choices and finds no claude-hooks.json, anywhere but in
 * `init` and `pair` it reads them from what is in place ({@link migrateHookPrefs}): a set that is missing from an existing
 * directory was taken out, and stays out.
 */
import fs from "node:fs";
import path from "node:path";
import type { Dirs } from "./paths.js";

export type HookSet = "session" | "approvals";
export type Choice = Partial<Record<HookSet, "on" | "off">>;
/** `pending`: directories whose settings could not be read when what 0.3.3 or earlier left was carried over ({@link settlePending}). */
interface Prefs { v: 1; all: Choice; dirs: Record<string, Choice>; pending?: string[] }

export const hookPrefsFile = (d: Dirs): string => path.join(d.config, "claude-hooks.json");
/** Where 0.1.23 to 0.3.3 kept the answer to the question they asked once per directory about the approval hooks. */
export const legacyOfferFile = (d: Dirs): string => path.join(d.state, "approval-hooks-offer.json");

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const choice = (x: unknown): Choice => {
  const out: Choice = {};
  if (!isObj(x)) return out;
  for (const k of ["session", "approvals"] as const) if (x[k] === "on" || x[k] === "off") out[k] = x[k];
  return out;
};

function readPrefs(d: Dirs): Prefs {
  try {
    const doc: unknown = JSON.parse(fs.readFileSync(hookPrefsFile(d), "utf8"));
    if (isObj(doc)) {
      const dirs: Record<string, Choice> = {};
      if (isObj(doc.dirs)) for (const [k, v] of Object.entries(doc.dirs)) dirs[k] = choice(v);
      const pending = Array.isArray(doc.pending) ? doc.pending.filter((x): x is string => typeof x === "string") : [];
      return { v: 1, all: choice(doc.all), dirs, ...(pending.length ? { pending } : {}) };
    }
  } catch { /* none yet */ }
  return { v: 1, all: {}, dirs: {} };
}

function writePrefs(d: Dirs, p: Prefs): void {
  const file = hookPrefsFile(d);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The directories 0.1.23 to 0.3.3 were told no for, in their one-time question about the approval hooks. */
function legacyNoDirs(d: Dirs): string[] {
  try {
    const doc: unknown = JSON.parse(fs.readFileSync(legacyOfferFile(d), "utf8"));
    if (!isObj(doc) || !isObj(doc.answered)) return [];
    return Object.entries(doc.answered).filter(([, a]) => isObj(a) && a.answer === "no").map(([dir]) => dir);
  } catch { return []; }
}

/**
 * Once, when there is no claude-hooks.json yet: write it, so the choices of a person who used 0.3.3 or earlier are kept.
 * A no to the one-time question 0.1.23 to 0.3.3 asked is carried over as "off" for its directory, so `--hooks` and
 * `hooks install --approvals` take it back like any other no. With `fresh` (`init` and `pair`, which add both sets now) nothing
 * else is carried over. Otherwise, in each of `dirs` that exists, a set
 * with none of its hooks there was taken out or never agreed to (`hooks uninstall`, `--no-hooks`, `--no-approval-hooks`, a "n"
 * at init/pair or to the one-time question): "off" for that directory, so it stays out until `hooks install` or `--hooks`.
 * `present` says whether any hook of that set is in that directory's settings, or null when they cannot be read (then the
 * directory is kept pending, and its sets are carried over the first time they can be read: {@link settlePending}). Never throws: it returns why the file could not be
 * written (then the caller adds nothing, since a no it cannot see yet would be undone), and it is tried again next time.
 */
export function migrateHookPrefs(d: Dirs, dirs: string[], present: (dir: string, set: HookSet) => boolean | null, fresh: boolean): string | null {
  try {
    if (fs.existsSync(hookPrefsFile(d))) return null;
    const p: Prefs = { v: 1, all: {}, dirs: {} };
    for (const dir of legacyNoDirs(d)) p.dirs[dir] = { approvals: "off" };
    if (!fresh) {
      for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        const c: Choice = { ...p.dirs[dir] };
        let unread = false;
        for (const set of ["session", "approvals"] as const) {
          const has = present(dir, set);
          if (has === false) c[set] = "off";
          else if (has === null) unread = true;
        }
        if (unread) (p.pending ??= []).push(dir);
        if (Object.keys(c).length) p.dirs[dir] = c;
      }
    }
    if (fs.existsSync(hookPrefsFile(d))) return null;
    writePrefs(d, p);
    return null;
  } catch (e) { return `could not write ${hookPrefsFile(d)}: ${(e as Error).message}`; }
}

/**
 * A directory whose settings could not be read when what 0.3.3 or earlier left was carried over: the first time they can be,
 * a set with none of its hooks there is recorded "off" (unless a choice was made for it since), as the carry-over would have.
 * Returns why nothing may be added to it yet, or null once it is settled (or was never pending). Throws when the choice cannot
 * be written.
 */
export function settlePending(d: Dirs, dir: string, present: (dir: string, set: HookSet) => boolean | null): string | null {
  const p = readPrefs(d);
  if (!p.pending?.includes(dir)) return null;
  const has = { session: present(dir, "session"), approvals: present(dir, "approvals") };
  if (has.session === null || has.approvals === null) return "its settings could not be read when the choices of an older connector were carried over; the hooks are added once they can be";
  const c: Choice = { ...p.dirs[dir] };
  for (const set of ["session", "approvals"] as const) if (has[set] === false && c[set] === undefined && p.all[set] === undefined) c[set] = "off";
  if (Object.keys(c).length) p.dirs[dir] = c;
  p.pending = p.pending.filter((x) => x !== dir);
  if (!p.pending.length) delete p.pending;
  writePrefs(d, p);
  return null;
}

/** Which sets of hooks belong in this directory: a choice made for the directory, else one made for all, else both. */
export function wantedHooks(d: Dirs, dir: string): Record<HookSet, boolean> {
  const p = readPrefs(d);
  const own = p.dirs[dir] ?? {};
  const session = (own.session ?? p.all.session ?? "on") === "on";
  return { session, approvals: (own.approvals ?? p.all.approvals ?? "on") === "on" };
}

/**
 * Record a choice for one or both sets, for one directory or (`dir` null) for every directory, in one write: both sets are kept,
 * or neither. A choice for every directory replaces what was said per directory before it (the latest word wins); a later choice
 * for one directory overrides it there.
 */
export function recordHooksChoice(d: Dirs, dir: string | null, choices: Choice): void {
  const p = readPrefs(d);
  for (const set of ["session", "approvals"] as const) {
    const value = choices[set];
    if (value === undefined) continue;
    if (dir === null) {
      if (value === "on") delete p.all[set]; else p.all[set] = "off";
      for (const c of Object.values(p.dirs)) delete c[set];
      // A yes for every directory (`--hooks`) leaves nothing to carry over.
      if (value === "on") delete p.pending;
    } else {
      p.dirs[dir] = { ...(p.dirs[dir] ?? {}), [set]: value };
    }
  }
  for (const [k, c] of Object.entries(p.dirs)) if (Object.keys(c).length === 0) delete p.dirs[k];
  writePrefs(d, p);
}
