// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What `status` and a supervisor need to know about the connection: why it last went down, and whether a person
 * must sign in again before another start can help. Both are small files in the state directory, written only
 * when something happens (never on a timer), and every write is best effort: a full or stuck disk must not take
 * the connection down with it.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
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

/**
 * Appends one disconnect, off the event loop (a stream drop can coincide with a stalled network disk); one at a time,
 * in order, so the size check and the cut never race another append of this process. Never rejects.
 */
export function recordDisconnect(dirs: Dirs, d: Omit<Disconnect, "at"> & { at?: string }): Promise<void> {
  const line = JSON.stringify({ at: d.at ?? new Date().toISOString(), reason: d.reason, ...(d.detail ? { detail: d.detail.slice(0, 300) } : {}) }) + "\n";
  const next = disconnectWrites.then(() => appendDisconnect(disconnectsFile(dirs), line)).catch(() => { /* best effort */ });
  disconnectWrites = next;
  return next;
}
let disconnectWrites: Promise<void> = Promise.resolve();

async function appendDisconnect(file: string, line: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // One descriptor for the append, the size and the read, so all three see the same file.
  const fh = await fsp.open(file, "a+", 0o600);
  let lines: string[] | null = null;
  try {
    await fh.write(line);
    const size = (await fh.stat()).size;
    if (size > MAX_BYTES) {
      // From offset 0: after the append the descriptor's position is at the end.
      const buf = Buffer.alloc(size);
      let got = 0;
      while (got < size) { const { bytesRead } = await fh.read(buf, got, size - got, got); if (bytesRead === 0) break; got += bytesRead; }
      lines = buf.subarray(0, got).toString("utf8").split("\n").filter(Boolean);
    }
  } finally { await fh.close(); }
  if (lines) {
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, lines.slice(Math.floor(lines.length / 2)).join("\n") + "\n", { mode: 0o600 });
    await fsp.rename(tmp, file);
  }
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
