// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Installing the two Claude Code hooks that tell the connector which sessions are open in a terminal (terminals.ts).
 *
 * They go into the user-level `<config dir>/settings.json`, merged into whatever is already there: only entries this
 * file recognises as its own (a command that runs `terminal-hook.js start|end`) are ever added, changed or removed, and
 * a settings file that cannot be understood is left exactly as it was. Installing twice changes nothing the second time.
 */
import fs from "node:fs";
import path from "node:path";
import { TERMINALS_DIR, terminalsDir } from "./terminals.js";

export class HooksError extends Error {}

/** The events hooked, and how long Claude Code may wait for each: SessionStart holds up the first turn, and SessionEnd is cut off at about 1.5 s anyway. */
export const HOOKED = [
  { event: "SessionStart", arg: "start", timeout: 2 },
  { event: "SessionEnd", arg: "end", timeout: 1 },
] as const;

/** A hook entry is ours when its command runs the hook script with one of our two arguments. */
const OURS_RE = /terminal-hook\.(?:js|ts)["']?\s+(?:start|end)(?:\s|$)/;

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The command a hook entry runs: this node, the hook script, the event, and the config dir the rows go under. */
export function hookCommand(node: string, script: string, arg: "start" | "end", configDir: string): string {
  return `${shellQuote(node)} ${shellQuote(script)} ${arg} --dir ${shellQuote(configDir)}`;
}

export const settingsFile = (configDir: string): string => path.join(configDir, "settings.json");

type Json = Record<string, unknown>;
const isObject = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const isOurs = (h: unknown): boolean => isObject(h) && h.type === "command" && typeof h.command === "string" && OURS_RE.test(h.command);

interface Loaded { doc: Json; text: string | null; file: string }

/** The settings as they are now. A missing file is an empty object; one that is not a JSON object is an error, never overwritten. */
function load(configDir: string): Loaded {
  const given = settingsFile(configDir);
  let file = given;
  try { file = fs.realpathSync(given); } catch { /* not there yet */ }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { doc: {}, text: null, file };
    throw new HooksError(`cannot read ${given}: ${(e as Error).message}`);
  }
  if (text.trim() === "") return { doc: {}, text, file };
  let doc: unknown;
  try { doc = JSON.parse(text); } catch (e) { throw new HooksError(`${given} is not valid JSON (${(e as Error).message.split("\n")[0]}); left untouched`); }
  if (!isObject(doc)) throw new HooksError(`${given} is not a JSON object; left untouched`);
  return { doc, text, file };
}

/** Write through a temp file in the same directory and a rename, keeping the file's mode; a symlinked settings.json keeps being a symlink. */
function save(l: Loaded, doc: Json): void {
  const indent = l.text?.match(/^([ \t]+)"/m)?.[1] ?? "  ";
  const body = JSON.stringify(doc, null, indent) + "\n";
  fs.mkdirSync(path.dirname(l.file), { recursive: true, mode: 0o700 });
  let mode = 0o600;
  try { mode = fs.statSync(l.file).mode & 0o777; } catch { /* a new file */ }
  const tmp = `${l.file}.claw-connector.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode });
  try { fs.renameSync(tmp, l.file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

function hooksOf(doc: Json, where: string): Json | null {
  if (doc.hooks === undefined) return null;
  if (!isObject(doc.hooks)) throw new HooksError(`${where}: "hooks" is not an object; left untouched`);
  return doc.hooks;
}

function groupsOf(hooks: Json, event: string, where: string): unknown[] | null {
  const g = hooks[event];
  if (g === undefined) return null;
  if (!Array.isArray(g)) throw new HooksError(`${where}: hooks.${event} is not a list; left untouched`);
  return g;
}

export interface InstallResult { changed: boolean; file: string }

/**
 * Add (or bring up to date) our entry for each hooked event. Everything else in the file is carried over as it was.
 * `node` and `script` are what the entries will run.
 */
export function installHooks(configDir: string, node: string, script: string): InstallResult {
  const l = load(configDir);
  const where = settingsFile(configDir);
  const before = JSON.stringify(l.doc);
  const doc: Json = JSON.parse(before);
  const hooks: Json = hooksOf(doc, where) ?? (doc.hooks = {}) as Json;
  for (const h of HOOKED) {
    const entry = { type: "command", command: hookCommand(node, script, h.arg, configDir), timeout: h.timeout };
    const groups = groupsOf(hooks, h.event, where) ?? (hooks[h.event] = []) as unknown[];
    let seen = false;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (!isObject(g) || !Array.isArray(g.hooks)) continue;
      const kept: unknown[] = [];
      let dropped = false;
      for (const x of g.hooks) {
        if (!isOurs(x)) { kept.push(x); continue; }
        if (seen) { dropped = true; continue; } // a second copy of ours (a hand edit) is dropped
        seen = true;
        kept.push({ ...(x as Json), ...entry });
      }
      g.hooks = kept;
      // A group that held only a duplicate of ours is empty now; it is ours to drop, and nothing else is.
      if (dropped && kept.length === 0 && Object.keys(g).length === 1) { groups.splice(i, 1); i--; }
    }
    if (!seen) groups.push({ hooks: [entry] });
  }
  const changed = JSON.stringify(doc) !== before || l.text === null;
  if (changed) save(l, doc);
  return { changed, file: l.file };
}

/** Remove our entries, and only the containers that removing them left empty; delete the rows we wrote. */
export function uninstallHooks(configDir: string): InstallResult {
  const l = load(configDir);
  const where = settingsFile(configDir);
  const doc: Json = JSON.parse(JSON.stringify(l.doc));
  const hooks = hooksOf(doc, where);
  let touchedAny = false;
  if (hooks) {
    for (const h of HOOKED) {
      const groups = groupsOf(hooks, h.event, where);
      if (!groups) continue;
      let touched = false;
      for (let i = groups.length - 1; i >= 0; i--) {
        const g = groups[i];
        if (!isObject(g) || !Array.isArray(g.hooks)) continue;
        const rest = g.hooks.filter((x) => !isOurs(x));
        if (rest.length === g.hooks.length) continue;
        touched = true;
        g.hooks = rest;
        if (rest.length === 0 && Object.keys(g).length === 1) groups.splice(i, 1);
      }
      if (touched && groups.length === 0) delete hooks[h.event];
      touchedAny ||= touched;
    }
    if (touchedAny && Object.keys(hooks).length === 0) delete doc.hooks;
  }
  if (touchedAny) save(l, doc);
  fs.rmSync(terminalsDir(configDir), { recursive: true, force: true });
  return { changed: touchedAny, file: l.file };
}

export interface HooksStatus {
  /** Both events have our entry. */
  installed: boolean;
  /** Which events have it. */
  events: string[];
  /** Every entry's node and script still exist (a moved or upgraded node leaves entries that fail on every start). */
  healthy: boolean;
  problem: string | null;
}

/** Where the hooks stand in a config directory; never throws. */
export function hooksStatus(configDir: string): HooksStatus {
  let l: Loaded;
  try { l = load(configDir); } catch (e) { return { installed: false, events: [], healthy: false, problem: (e as Error).message }; }
  const events: string[] = [];
  let healthy = true;
  let problem: string | null = null;
  const hooks = isObject(l.doc.hooks) ? l.doc.hooks : {};
  for (const h of HOOKED) {
    const groups = Array.isArray(hooks[h.event]) ? (hooks[h.event] as unknown[]) : [];
    const mine = groups.flatMap((g) => (isObject(g) && Array.isArray(g.hooks) ? g.hooks.filter(isOurs) : []) as Json[]);
    if (mine.length === 0) continue;
    events.push(h.event);
    for (const x of mine) {
      const m = /^'((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)' /.exec(String(x.command));
      if (!m) continue;
      for (const f of [m[1]!, m[2]!].map((s) => s.replace(/'\\''/g, "'"))) {
        if (!fs.existsSync(f)) { healthy = false; problem ??= `${f} (named by the ${h.event} hook) does not exist; run: claw-connector hooks install`; }
      }
    }
  }
  return { installed: events.length === HOOKED.length, events, healthy, problem };
}

export { TERMINALS_DIR };
