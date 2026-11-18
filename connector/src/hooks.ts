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

/**
 * What marks an entry as ours: the command ends with this, and runs the hook script. Both, so that a user's own hook that
 * happens to be called `terminal-hook.js start` is never taken for ours (overwritten by install, deleted by uninstall).
 */
export const MANAGED_MARK = "--managed-by claw-connector";
const OURS_RE = /terminal-hook\.(?:js|ts)["']?\s+(?:start|end)\s/;

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The command a hook entry runs: this node, the hook script, the event, the config dir the rows go under, and the mark that says it is ours. */
export function hookCommand(node: string, script: string, arg: "start" | "end", configDir: string): string {
  return `${shellQuote(node)} ${shellQuote(script)} ${arg} --dir ${shellQuote(configDir)} ${MANAGED_MARK}`;
}

export const settingsFile = (configDir: string): string => path.join(configDir, "settings.json");

type Json = Record<string, unknown>;
const isObject = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const isOurs = (h: unknown): boolean =>
  isObject(h) && h.type === "command" && typeof h.command === "string" && h.command.endsWith(` ${MANAGED_MARK}`) && OURS_RE.test(h.command);

interface Loaded { doc: Json; text: string | null; file: string }

/** The settings as they are now. A missing file is an empty object; one that is not a JSON object is an error, never overwritten. */
function load(configDir: string, given = settingsFile(configDir)): Loaded {
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
      // A group that held only a duplicate of ours is empty now (whatever matcher it has): it is ours to drop, and nothing else is.
      if (dropped && kept.length === 0) { groups.splice(i, 1); i--; }
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
        if (rest.length === 0) groups.splice(i, 1);
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

// --- the approval hooks (approvals.ts) --------------------------------------------------

/**
 * The approval hooks, installed only when asked for (`hooks install --approvals`): `PermissionRequest` hands a question the
 * terminal is asking to the connector and waits for the owner's answer (Claude Code shows its own dialog meanwhile, so the hook
 * may wait as long as the question is open); the others run in the background (`async`) and only tell the connector that the
 * terminal answered. `SessionEnd` cannot run in the background and has about a second, which is plenty for one local write.
 */
export const APPROVAL_HOOKED = [
  { event: "PermissionRequest", arg: "ask", timeout: 3600, async: false },
  { event: "PostToolUse", arg: "settled", timeout: 5, async: true },
  { event: "PostToolUseFailure", arg: "settled", timeout: 5, async: true },
  { event: "UserPromptSubmit", arg: "settled", timeout: 5, async: true },
  { event: "Stop", arg: "settled", timeout: 5, async: true },
  { event: "SessionEnd", arg: "settled", timeout: 1, async: false },
] as const;

const APPROVAL_RE = /approval-hook\.(?:js|ts)["']?\s+(?:ask|settled)\s/;
const isOursApproval = (h: unknown): boolean =>
  isObject(h) && h.type === "command" && typeof h.command === "string" && h.command.endsWith(` ${MANAGED_MARK}`) && APPROVAL_RE.test(h.command);

export function approvalHookCommand(node: string, script: string, arg: "ask" | "settled", configDir: string, socket: string): string {
  return `${shellQuote(node)} ${shellQuote(script)} ${arg} --dir ${shellQuote(configDir)} --socket ${shellQuote(socket)} ${MANAGED_MARK}`;
}

/** Add (or bring up to date) the approval hooks; the same merge rules as {@link installHooks}. */
export function installApprovalHooks(configDir: string, node: string, script: string, socket: string): InstallResult {
  return installApprovalEntries(settingsFile(configDir), APPROVAL_HOOKED.map((h) => ({
    event: h.event, entry: { type: "command", command: approvalHookCommand(node, script, h.arg, configDir, socket), timeout: h.timeout, ...(h.async ? { async: true } : {}) },
  })), configDir);
}

function installApprovalEntries(where: string, entries: Array<{ event: string; entry: Json }>, configDir: string): InstallResult {
  const l = load(configDir, where);
  const before = JSON.stringify(l.doc);
  const doc: Json = JSON.parse(before);
  const hooks: Json = hooksOf(doc, where) ?? (doc.hooks = {}) as Json;
  for (const { event, entry } of entries) {
    const groups = groupsOf(hooks, event, where) ?? (hooks[event] = []) as unknown[];
    let seen = false;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (!isObject(g) || !Array.isArray(g.hooks)) continue;
      const kept: unknown[] = [];
      let dropped = false;
      for (const x of g.hooks) {
        if (!isOursApproval(x)) { kept.push(x); continue; }
        if (seen) { dropped = true; continue; }
        seen = true;
        const { async: _a, statusMessage: _s, ...rest } = x as Json;
        kept.push({ ...rest, ...entry });
      }
      g.hooks = kept;
      if (dropped && kept.length === 0) { groups.splice(i, 1); i--; }
    }
    if (!seen) groups.push({ hooks: [entry] });
  }
  const changed = JSON.stringify(doc) !== before || l.text === null;
  if (changed) save(l, doc);
  return { changed, file: l.file };
}

/** Remove the approval hooks only (the session hooks stay). */
export function uninstallApprovalHooks(configDir: string): InstallResult {
  return uninstallApprovalEntries(settingsFile(configDir), APPROVAL_HOOKED.map((h) => h.event), configDir);
}

function uninstallApprovalEntries(where: string, events: readonly string[], configDir: string): InstallResult {
  const l = load(configDir, where);
  const doc: Json = JSON.parse(JSON.stringify(l.doc));
  const hooks = hooksOf(doc, where);
  let touchedAny = false;
  if (hooks) {
    for (const event of new Set(events)) {
      const groups = groupsOf(hooks, event, where);
      if (!groups) continue;
      let touched = false;
      for (let i = groups.length - 1; i >= 0; i--) {
        const g = groups[i];
        if (!isObject(g) || !Array.isArray(g.hooks)) continue;
        const rest = g.hooks.filter((x) => !isOursApproval(x));
        if (rest.length === g.hooks.length) continue;
        touched = true;
        g.hooks = rest;
        if (rest.length === 0) groups.splice(i, 1);
      }
      if (touched && groups.length === 0) delete hooks[event];
      touchedAny ||= touched;
    }
    if (touchedAny && Object.keys(hooks).length === 0) delete doc.hooks;
  }
  if (touchedAny) save(l, doc);
  return { changed: touchedAny, file: l.file };
}

/** Whether the approval hooks are in place (all of them), and whether what they run still exists; never throws. */
export function approvalHooksStatus(configDir: string): HooksStatus {
  return approvalEntriesStatus(settingsFile(configDir), APPROVAL_HOOKED.map((h) => h.event), configDir, "hooks install --approvals");
}

function approvalEntriesStatus(where: string, wanted: readonly string[], configDir: string, fix: string): HooksStatus {
  let l: Loaded;
  try { l = load(configDir, where); } catch (e) { return { installed: false, events: [], healthy: false, problem: (e as Error).message }; }
  const events: string[] = [];
  let healthy = true;
  let problem: string | null = null;
  const hooks = isObject(l.doc.hooks) ? l.doc.hooks : {};
  for (const event of wanted) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const mine = groups.flatMap((g) => (isObject(g) && Array.isArray(g.hooks) ? g.hooks.filter(isOursApproval) : []) as Json[]);
    if (mine.length === 0) continue;
    events.push(event);
    for (const x of mine) {
      const m = /^'((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)' /.exec(String(x.command));
      if (!m) continue;
      for (const f of [m[1]!, m[2]!].map((s) => s.replace(/'\\''/g, "'"))) {
        if (!fs.existsSync(f)) { healthy = false; problem ??= `${f} (named by the ${event} approval hook) does not exist; run: claw-connector ${fix}`; }
      }
    }
  }
  return { installed: events.length === wanted.length, events, healthy, problem };
}

// --- the Codex approval hook (approvals.ts, approval-hook.ts) ----------------------------

/** Codex's own hooks file in a CODEX_HOME (Codex also reads inline `[hooks]` in config.toml; this file is the one written). */
export const codexHooksFile = (codexHome: string): string => path.join(codexHome, "hooks.json");

/** How long nobody must have typed in a Codex terminal before its question goes to the phone (seconds). */
export const CODEX_IDLE_S = 30;

/**
 * The Codex approval hooks. `PermissionRequest` waits as long as a card may (Codex shows its own prompt only after it exits, so
 * it gives the question back as soon as someone types in the terminal); `SessionEnd` closes the conversation's Claw session.
 * Codex runs hooks only once the person has trusted them (it asks at its next start, or under /hooks).
 */
export const CODEX_APPROVAL_HOOKED = [
  { event: "PermissionRequest", arg: "ask", timeout: 3600, statusMessage: "Asked on your phone (Claw); type anything here to answer in this terminal" },
  { event: "SessionEnd", arg: "settled", timeout: 1 },
] as const;

export function codexApprovalHookCommand(node: string, script: string, arg: "ask" | "settled", codexHome: string, socket: string): string {
  return `${shellQuote(node)} ${shellQuote(script)} ${arg} --dir ${shellQuote(codexHome)} --socket ${shellQuote(socket)} --agent codex --idle ${CODEX_IDLE_S} ${MANAGED_MARK}`;
}

/** Add (or bring up to date) the Codex approval hooks in CODEX_HOME/hooks.json; the same merge rules as {@link installHooks}. */
export function installCodexApprovalHooks(codexHome: string, node: string, script: string, socket: string): InstallResult {
  return installApprovalEntries(codexHooksFile(codexHome), CODEX_APPROVAL_HOOKED.map((h) => ({
    event: h.event,
    entry: { type: "command", command: codexApprovalHookCommand(node, script, h.arg, codexHome, socket), timeout: h.timeout, ...("statusMessage" in h ? { statusMessage: h.statusMessage } : {}) },
  })), codexHome);
}

export function uninstallCodexApprovalHooks(codexHome: string): InstallResult {
  return uninstallApprovalEntries(codexHooksFile(codexHome), CODEX_APPROVAL_HOOKED.map((h) => h.event), codexHome);
}

export function codexApprovalHooksStatus(codexHome: string): HooksStatus {
  return approvalEntriesStatus(codexHooksFile(codexHome), CODEX_APPROVAL_HOOKED.map((h) => h.event), codexHome, "hooks install --agent codex");
}

// --- Cursor's approval hooks (cursor-approvals.ts) ---------------------------------------

/**
 * The Cursor hooks (`hooks install --approvals --agent cursor`), in the user-level `hooks.json` of the Cursor configuration
 * directory. The before-hooks hold the call while it is on the phone (Cursor waits for them; their `timeout` is the hold plus a
 * margin, and a hook Cursor stops at its timeout changes nothing); the others only tell the connector what happened and take
 * a few milliseconds. Cursor runs every hook of every source, so ours sit next to the user's own entries.
 */
export const CURSOR_APPROVAL_HOOKED = [
  { event: "beforeShellExecution", arg: "ask" },
  { event: "beforeMCPExecution", arg: "ask" },
  { event: "afterShellExecution", arg: "settled" },
  { event: "afterMCPExecution", arg: "settled" },
  { event: "postToolUseFailure", arg: "settled" },
  { event: "beforeSubmitPrompt", arg: "settled" },
  { event: "stop", arg: "settled" },
  { event: "sessionEnd", arg: "settled" },
] as const;
/** How much longer than the hold Cursor may wait for an `ask` hook, and how long for the others. */
const CURSOR_ASK_MARGIN_S = 30;
const CURSOR_SETTLED_TIMEOUT_S = 5;

export const cursorHooksFile = (cursorDir: string): string => path.join(cursorDir, "hooks.json");

const CURSOR_RE = /approval-hook\.(?:js|ts)["']?\s+(?:ask|settled)\s+--agent\s+cursor\s/;
const isOursCursor = (h: unknown): boolean =>
  isObject(h) && typeof h.command === "string" && h.command.endsWith(` ${MANAGED_MARK}`) && CURSOR_RE.test(h.command) && (h.type === undefined || h.type === "command");

export function cursorHookCommand(node: string, script: string, arg: "ask" | "settled", cursorDir: string, socket: string, holdS: number): string {
  return `${shellQuote(node)} ${shellQuote(script)} ${arg} --agent cursor${arg === "ask" ? ` --hold ${holdS}` : ""} --dir ${shellQuote(cursorDir)} --socket ${shellQuote(socket)} ${MANAGED_MARK}`;
}

/** Cursor's `hooks.json` as it is now: a missing file is a new one; one that is not `{"version": 1, ...}` is an error, never overwritten. */
function loadCursor(cursorDir: string): Loaded {
  const given = cursorHooksFile(cursorDir);
  let file = given;
  try { file = fs.realpathSync(given); } catch { /* not there yet */ }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { doc: { version: 1, hooks: {} }, text: null, file };
    throw new HooksError(`cannot read ${given}: ${(e as Error).message}`);
  }
  if (text.trim() === "") return { doc: { version: 1, hooks: {} }, text, file };
  let doc: unknown;
  try { doc = JSON.parse(text); } catch (e) { throw new HooksError(`${given} is not valid JSON (${(e as Error).message.split("\n")[0]}); left untouched`); }
  if (!isObject(doc)) throw new HooksError(`${given} is not a JSON object; left untouched`);
  if (doc.version !== undefined && doc.version !== 1) throw new HooksError(`${given} has version ${JSON.stringify(doc.version)}, not 1; left untouched`);
  return { doc, text, file };
}

/** Add (or bring up to date) the Cursor approval hooks; every other entry in the file is carried over as it was. */
export function installCursorApprovalHooks(cursorDir: string, node: string, script: string, socket: string, holdS: number): InstallResult {
  const l = loadCursor(cursorDir);
  const where = cursorHooksFile(cursorDir);
  const before = JSON.stringify(l.doc);
  const doc: Json = JSON.parse(before);
  doc.version ??= 1;
  const hooks: Json = hooksOf(doc, where) ?? (doc.hooks = {}) as Json;
  for (const h of CURSOR_APPROVAL_HOOKED) {
    const entry: Json = {
      command: cursorHookCommand(node, script, h.arg, cursorDir, socket, holdS),
      timeout: h.arg === "ask" ? holdS + CURSOR_ASK_MARGIN_S : CURSOR_SETTLED_TIMEOUT_S,
    };
    const list = groupsOf(hooks, h.event, where) ?? (hooks[h.event] = []) as unknown[];
    let seen = false;
    for (let i = 0; i < list.length; i++) {
      if (!isOursCursor(list[i])) continue;
      if (seen) { list.splice(i, 1); i--; continue; } // a second copy of ours (a hand edit) is dropped
      seen = true;
      list[i] = { ...(list[i] as Json), ...entry };
    }
    if (!seen) list.push(entry);
  }
  const changed = JSON.stringify(doc) !== before || l.text === null;
  if (changed) save(l, doc);
  return { changed, file: l.file };
}

/** Remove the Cursor approval hooks, and only the lists that removing them left empty. */
export function uninstallCursorApprovalHooks(cursorDir: string): InstallResult {
  if (!fs.existsSync(cursorHooksFile(cursorDir))) return { changed: false, file: cursorHooksFile(cursorDir) };
  const l = loadCursor(cursorDir);
  const where = cursorHooksFile(cursorDir);
  const doc: Json = JSON.parse(JSON.stringify(l.doc));
  const hooks = hooksOf(doc, where);
  let touchedAny = false;
  if (hooks) {
    for (const event of new Set(CURSOR_APPROVAL_HOOKED.map((h) => h.event))) {
      const list = groupsOf(hooks, event, where);
      if (!list) continue;
      const rest = list.filter((x) => !isOursCursor(x));
      if (rest.length === list.length) continue;
      touchedAny = true;
      if (rest.length === 0) delete hooks[event]; else hooks[event] = rest;
    }
  }
  if (touchedAny) save(l, doc);
  return { changed: touchedAny, file: l.file };
}

/** Whether the Cursor approval hooks are all in place, and whether what they run still exists; never throws. */
export function cursorApprovalHooksStatus(cursorDir: string): HooksStatus & { holdS: number | null } {
  let l: Loaded;
  try { l = loadCursor(cursorDir); } catch (e) { return { installed: false, events: [], healthy: false, problem: (e as Error).message, holdS: null }; }
  const events: string[] = [];
  let healthy = true;
  let problem: string | null = null;
  let holdS: number | null = null;
  const hooks = isObject(l.doc.hooks) ? l.doc.hooks : {};
  for (const h of CURSOR_APPROVAL_HOOKED) {
    const mine = (Array.isArray(hooks[h.event]) ? (hooks[h.event] as unknown[]) : []).filter(isOursCursor) as Json[];
    if (mine.length === 0) continue;
    events.push(h.event);
    for (const x of mine) {
      const hold = / --hold (\d+) /.exec(String(x.command));
      if (hold) holdS = Number(hold[1]);
      const m = /^'((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)' /.exec(String(x.command));
      if (!m) continue;
      for (const f of [m[1]!, m[2]!].map((s) => s.replace(/'\\''/g, "'"))) {
        if (!fs.existsSync(f)) { healthy = false; problem ??= `${f} (named by the ${h.event} hook) does not exist; run: claw-connector hooks install --approvals --agent cursor`; }
      }
    }
  }
  return { installed: events.length === CURSOR_APPROVAL_HOOKED.length, events, healthy, problem, holdS };
}
