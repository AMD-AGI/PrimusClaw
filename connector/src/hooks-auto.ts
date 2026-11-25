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
type Choice = Partial<Record<HookSet, "on" | "off">>;
interface Prefs { v: 1; all: Choice; dirs: Record<string, Choice> }

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
      return { v: 1, all: choice(doc.all), dirs };
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

function legacyNo(d: Dirs, dir: string): boolean {
  try {
    const doc: unknown = JSON.parse(fs.readFileSync(legacyOfferFile(d), "utf8"));
    const a = isObj(doc) && isObj(doc.answered) ? doc.answered[dir] : undefined;
    return isObj(a) && a.answer === "no";
  } catch { return false; }
}

/**
 * Once, when there is no claude-hooks.json yet: write it, so the choices of a person who used 0.3.3 or earlier are kept. With
 * `fresh` (`init` and `pair`, which add both sets now) nothing is carried over. Otherwise, in each of `dirs` that exists, a set
 * with none of its hooks there was taken out or never agreed to (`hooks uninstall`, `--no-hooks`, `--no-approval-hooks`, a "n"
 * at init/pair or to the one-time question): "off" for that directory, so it stays out until `hooks install` or `--hooks`.
 * `present` says whether any hook of that set is in that directory's settings, or null when they cannot be read (then nothing is
 * recorded for it, and the hooks go in once the file can be merged into). Never throws: a failure is retried next time.
 */
export function migrateHookPrefs(d: Dirs, dirs: string[], present: (dir: string, set: HookSet) => boolean | null, fresh: boolean): void {
  try {
    if (fs.existsSync(hookPrefsFile(d))) return;
    const p: Prefs = { v: 1, all: {}, dirs: {} };
    if (!fresh) {
      for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        const c: Choice = {};
        for (const set of ["session", "approvals"] as const) if (present(dir, set) === false) c[set] = "off";
        if (Object.keys(c).length) p.dirs[dir] = c;
      }
    }
    if (fs.existsSync(hookPrefsFile(d))) return;
    writePrefs(d, p);
  } catch { /* tried again next time */ }
}

/** Which sets of hooks belong in this directory: a choice made for the directory, else one made for all, else both. */
export function wantedHooks(d: Dirs, dir: string): Record<HookSet, boolean> {
  const p = readPrefs(d);
  const own = p.dirs[dir] ?? {};
  const session = (own.session ?? p.all.session ?? "on") === "on";
  const approvalsChoice = own.approvals ?? p.all.approvals ?? (legacyNo(d, dir) ? "off" : "on");
  return { session, approvals: approvalsChoice === "on" };
}

/**
 * Record a choice, for one directory or (`dir` null) for every directory. A choice for every directory replaces what was said per
 * directory before it (the latest word wins); a later choice for one directory overrides it there.
 */
export function recordHooksChoice(d: Dirs, dir: string | null, set: HookSet, value: "on" | "off"): void {
  const p = readPrefs(d);
  if (dir === null) {
    if (value === "on") delete p.all[set]; else p.all[set] = "off";
    for (const c of Object.values(p.dirs)) delete c[set];
  } else {
    p.dirs[dir] = { ...(p.dirs[dir] ?? {}), [set]: value };
  }
  for (const [k, c] of Object.entries(p.dirs)) if (Object.keys(c).length === 0) delete p.dirs[k];
  writePrefs(d, p);
}
