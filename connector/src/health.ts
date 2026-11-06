// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What `status` and a supervisor need to know about the connection: why it last went down, and whether a person
 * must sign in again before another start can help. Both are small files in the state directory, written only
 * when something happens (never on a timer), and every write is best effort: a full or stuck disk must not take
 * the connection down with it.
 */
import fs from "node:fs";
import path from "node:path";
import { disconnectsFile, needsLoginFile, type Dirs } from "./paths.js";
import { isObject } from "./util.js";

export interface Disconnect {
  at: string;
  /** stream_lost (network or HTTP), server_closed (a Claw release, `superseded`, `token_expired`), stopped, paused,
   *  revoked, auth_failed, process_died (a run that ended without shutting down: killed, crashed, machine restart). */
  reason: string;
  detail?: string;
}

/** Past this size the file is cut to its newer half: a week of Claw releases is a few hundred short lines. */
const MAX_BYTES = 128 * 1024;

export function recordDisconnect(dirs: Dirs, d: Omit<Disconnect, "at"> & { at?: string }): void {
  const file = disconnectsFile(dirs);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify({ at: d.at ?? new Date().toISOString(), reason: d.reason, ...(d.detail ? { detail: d.detail.slice(0, 300) } : {}) }) + "\n", { mode: 0o600 });
    if (fs.statSync(file).size > MAX_BYTES) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, lines.slice(Math.floor(lines.length / 2)).join("\n") + "\n", { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
  } catch { /* best effort */ }
}

/** The newest `n` disconnects, oldest first. */
export function recentDisconnects(dirs: Dirs, n = 1): Disconnect[] {
  try {
    const out: Disconnect[] = [];
    for (const line of fs.readFileSync(disconnectsFile(dirs), "utf8").split("\n").filter(Boolean).slice(-n)) {
      try {
        const v: unknown = JSON.parse(line);
        if (isObject(v) && typeof v.at === "string" && typeof v.reason === "string") out.push({ at: v.at, reason: v.reason, ...(typeof v.detail === "string" ? { detail: v.detail } : {}) });
      } catch { /* a torn line */ }
    }
    return out;
  } catch { return []; }
}

export interface NeedsLogin { at: string; reason: string }

/** A run ended in a way only a person can fix (revoked, a key or sign-in refused): a supervisor must not start it again. */
export function markNeedsLogin(dirs: Dirs, reason: string): void {
  try {
    fs.mkdirSync(dirs.state, { recursive: true, mode: 0o700 });
    fs.writeFileSync(needsLoginFile(dirs), JSON.stringify({ at: new Date().toISOString(), reason: reason.slice(0, 300) }), { mode: 0o600 });
  } catch { /* best effort: the exit code says the same */ }
}

export function needsLogin(dirs: Dirs): NeedsLogin | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(needsLoginFile(dirs), "utf8"));
    if (isObject(v) && typeof v.reason === "string") return { at: typeof v.at === "string" ? v.at : "", reason: v.reason };
    return { at: "", reason: "unreadable needs-login.json" };
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : { at: "", reason: "unreadable needs-login.json" };
  }
}

export function clearNeedsLogin(dirs: Dirs): void {
  fs.rmSync(needsLoginFile(dirs), { force: true });
}
