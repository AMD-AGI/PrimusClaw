// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The adapter processes this connector started, recorded so that stopping the
 * connector (or a later run, or `claw-connector stop`) kills exactly those and
 * nothing else. There is no pattern-kill anywhere: a process is signalled only
 * if its pid is in this file AND its start time still matches, so a recycled pid
 * is never hit.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sleep } from "./util.js";

export interface ChildRecord {
  pid: number;
  /** The process group the adapter leads (it is started detached, so pgid = pid). */
  pgid: number;
  /** The process's start time as the OS reports it, to tell it from a later process with the same pid. */
  start: string;
  agent_id: string;
  session_id: string;
  started_at: string;
}

/** The start time of a process in a form that does not change while it lives, or null if it is gone. */
export function processStart(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // Field 22, counted after the parenthesised command name (which may itself contain spaces and parentheses).
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return rest[19] ?? null;
    }
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

export const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

export class ChildRegistry {
  private recs = new Map<number, ChildRecord>();

  constructor(private readonly file: string) {
    this.recs = new Map(readRecords(file).map((r) => [r.pid, r]));
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.recs.values()]), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  add(rec: Omit<ChildRecord, "start" | "started_at"> & { start?: string }): ChildRecord {
    const full: ChildRecord = { ...rec, start: rec.start ?? processStart(rec.pid) ?? "", started_at: new Date().toISOString() };
    this.recs.set(full.pid, full);
    this.save();
    return full;
  }

  remove(pid: number): void {
    if (this.recs.delete(pid)) this.save();
  }

  list(): ChildRecord[] {
    return [...this.recs.values()];
  }

  /**
   * True when the recorded process group is ours to signal.
   *
   * Either its leader is still the process we started (same pid and start time), or the leader is gone and members
   * remain: a process group id is a pid that cannot be handed to another process while any member lives, so a
   * group that is still alive under a recorded id with a dead leader can only be the one we started (an `npx`
   * wrapper exits and the agent below it stays). A leader pid that now belongs to a different process is a
   * recycled id and is left alone.
   */
  isOurs(rec: ChildRecord): boolean {
    if (rec.start === "") return false;
    const now = processStart(rec.pid);
    if (now === rec.start) return true;
    if (now === null) return groupAlive(rec.pgid);
    return false;
  }

  /**
   * The leader exited: stop whatever it left behind in its group, then forget it.
   * Called at the moment of exit, while the group id cannot yet belong to anyone else.
   */
  async reap(pid: number, graceMs = 1000): Promise<void> {
    const r = this.recs.get(pid);
    if (!r) return;
    if (groupAlive(r.pgid)) {
      signalGroup(r.pgid, "SIGTERM");
      const deadline = Date.now() + graceMs;
      while (Date.now() < deadline && groupAlive(r.pgid)) await sleep(25);
      if (groupAlive(r.pgid)) signalGroup(r.pgid, "SIGKILL");
    }
    this.recs.delete(pid);
    this.save();
  }

  /** Stop one recorded process group (the same way {@link killAll} does), and only that one. */
  async kill(pid: number, graceMs = 1500): Promise<boolean> {
    const r = this.recs.get(pid);
    if (!r) return false;
    if (!this.isOurs(r)) {
      this.recs.delete(pid);
      this.save();
      return false;
    }
    signalGroup(r.pgid, "SIGTERM");
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && groupAlive(r.pgid)) await sleep(25);
    if (groupAlive(r.pgid)) signalGroup(r.pgid, "SIGKILL");
    this.recs.delete(pid);
    this.save();
    return true;
  }

  /**
   * Stop every recorded process group: SIGTERM, a short grace, then SIGKILL.
   * Records that are not ours (see {@link isOurs}: a recycled pid, or a group with nobody left in it) are dropped
   * without signalling anything.
   */
  async killAll(graceMs = 2000): Promise<{ killed: number[]; skipped: number[] }> {
    const killed: number[] = [];
    const skipped: number[] = [];
    const mine = this.list().filter((r) => {
      if (this.isOurs(r)) return true;
      skipped.push(r.pid);
      this.recs.delete(r.pid);
      return false;
    });
    for (const r of mine) signalGroup(r.pgid, "SIGTERM");
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && mine.some((r) => groupAlive(r.pgid))) await sleep(50);
    for (const r of mine) {
      if (groupAlive(r.pgid)) signalGroup(r.pgid, "SIGKILL");
      killed.push(r.pid);
      this.recs.delete(r.pid);
    }
    this.save();
    return { killed, skipped };
  }
}

function readRecords(file: string): ChildRecord[] {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(raw) ? (raw as ChildRecord[]).filter((r) => Number.isInteger(r?.pid) && Number.isInteger(r?.pgid) && r.pgid > 1) : [];
  } catch {
    return [];
  }
}

function signalGroup(pgid: number, sig: NodeJS.Signals): void {
  try { process.kill(-pgid, sig); } catch { /* already gone */ }
}

function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
