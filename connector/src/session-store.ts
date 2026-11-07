// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Sessions the connector has created, so a later `resume` (or a restart) can find the adapter's own session id. */
import fs from "node:fs";
import { SnapshotFile, STATE_WRITE_WAIT_MS, type WriteReport } from "./statefile.js";

export interface SessionRecord {
  agent_id: string;
  acp_session_id: string | null;
  cwd: string;
  status: "active" | "closed";
  /** The mode the session was last verified in. */
  mode: string | null;
  /** A conversation open in a terminal, watched without taking it over (session.ts `spectate`). */
  read_only?: boolean;
  created_at: string;
  /** When a prompt last reached the session's agent (absent on records written before this was kept). */
  used_at?: string;
  /** Started new by this connector and no prompt has reached it yet; absent when unknown (older records, takeovers). */
  unused?: boolean;
}

/** A turn the agent was running, kept from the moment its prompt reaches the agent until its `turn_end` is emitted. */
export interface TurnRecord {
  session_id: string;
  cmd_id: string | null;
  cmd_seq: number | null;
  started_at: string;
  /** The agent was waiting for a person's answer: a permission request, a plan or a question card. */
  waiting?: boolean;
  /** ... and at least one of those was a permission request for a tool call (not a plan or a question). */
  waiting_permission?: boolean;
}

export class SessionStore {
  private recs: Record<string, SessionRecord> = {};
  private pending: Array<{ session_id: string; action_id: string }> = [];
  private readonly pendingFile: string;
  private turns: Record<string, TurnRecord> = {};
  private readonly turnsFile: string;
  /** The files are written off the event loop (see statefile.ts); read synchronously once, at start. */
  private readonly recsOut: SnapshotFile;
  private readonly pendingOut: SnapshotFile;
  private readonly turnsOut: SnapshotFile;

  constructor(file: string, report?: WriteReport) {
    this.pendingFile = `${file}.pending`;
    this.turnsFile = `${file}.turns`;
    this.recsOut = new SnapshotFile(file, report);
    this.pendingOut = new SnapshotFile(this.pendingFile, report);
    this.turnsOut = new SnapshotFile(this.turnsFile, report);
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.turnsFile, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [k, t] of Object.entries(raw as Record<string, TurnRecord>)) if (t && typeof t.session_id === "string") this.turns[k] = t;
      }
    } catch { /* none */ }
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.pendingFile, "utf8"));
      if (Array.isArray(raw)) this.pending = raw.filter((p) => p && typeof p.session_id === "string" && typeof p.action_id === "string");
    } catch { /* none */ }
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) this.recs = raw as Record<string, SessionRecord>;
    } catch { /* first run */ }
  }

  get(id: string): SessionRecord | undefined {
    return this.recs[id];
  }

  put(id: string, rec: SessionRecord): void {
    this.recs[id] = rec;
    this.save();
  }

  patch(id: string, p: Partial<SessionRecord>): void {
    const cur = this.recs[id];
    if (!cur) return;
    this.recs[id] = { ...cur, ...p };
    this.save();
  }

  /**
   * Permission requests a person has not answered. They live in the adapter's memory, so a crash
   * of the connector ends them; the next run reads this list and closes each card (cancelled).
   */
  addPending(sessionId: string, actionId: string): void {
    this.pending.push({ session_id: sessionId, action_id: actionId });
    this.savePending();
  }

  removePending(sessionId: string, actionId: string): void {
    const before = this.pending.length;
    this.pending = this.pending.filter((p) => !(p.session_id === sessionId && p.action_id === actionId));
    if (this.pending.length !== before) this.savePending();
  }

  /** Return what was pending and forget it. */
  takePending(): Array<{ session_id: string; action_id: string }> {
    const out = this.pending;
    this.pending = [];
    if (out.length) this.savePending();
    return out;
  }

  private savePending(): void {
    this.pendingOut.save(JSON.stringify(this.pending));
  }

  /**
   * Resolves once everything saved so far has been written (or the write failed), however long the disk takes: an
   * event that depends on a record (`session_started`, a `permissionRequest`) waits for it, so what a phone was shown
   * is always what the next run can find after a crash.
   */
  written(): Promise<boolean> {
    return this.flushed(Infinity);
  }

  /** Whether everything saved so far is on disk (false when a write failed, or after `ms`). */
  async flushed(ms: number = STATE_WRITE_WAIT_MS): Promise<boolean> {
    const all = await Promise.all([this.recsOut.settled(ms), this.pendingOut.settled(ms), this.turnsOut.settled(ms)]);
    return all.every(Boolean);
  }

  /**
   * The turn a session's agent is running. It lives in the adapter's memory, so a connector that dies (or is stopped)
   * mid-turn would leave the prompt open for ever: the next run reads these and ends or continues each one.
   */
  beginTurn(t: TurnRecord): void {
    this.turns[t.session_id] = t;
    this.saveTurns();
  }

  /** The turn's agent is waiting for a person (`true`; `permission`: a tool call's permission request), or no longer (`false`). */
  markWaiting(sessionId: string, waiting: boolean, permission = false): void {
    const t = this.turns[sessionId];
    if (!t) return;
    const next = { ...t, waiting, waiting_permission: waiting && (permission || Boolean(t.waiting_permission)) };
    if (Boolean(t.waiting) === next.waiting && Boolean(t.waiting_permission) === next.waiting_permission) return;
    this.turns[sessionId] = next;
    this.saveTurns();
  }

  turn(sessionId: string): TurnRecord | undefined {
    return this.turns[sessionId];
  }

  endTurn(sessionId: string): void {
    if (!(sessionId in this.turns)) return;
    delete this.turns[sessionId];
    this.saveTurns();
  }

  /** The turns recorded as running. Each stays until it is ended ({@link endTurn}) or a new turn of its session replaces it. */
  listTurns(): TurnRecord[] {
    return Object.values(this.turns).map((t) => ({ ...t }));
  }

  private saveTurns(): void {
    this.turnsOut.save(JSON.stringify(this.turns));
  }

  ids(): string[] {
    return Object.keys(this.recs);
  }

  private save(): void {
    this.recsOut.save(JSON.stringify(this.recs));
  }
}
