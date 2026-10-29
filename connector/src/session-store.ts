// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Sessions the connector has created, so a later `resume` (or a restart) can find the adapter's own session id. */
import fs from "node:fs";
import path from "node:path";

export interface SessionRecord {
  agent_id: string;
  acp_session_id: string | null;
  cwd: string;
  status: "active" | "closed";
  /** The mode the session was last verified in. */
  mode: string | null;
  created_at: string;
}

export class SessionStore {
  private recs: Record<string, SessionRecord> = {};
  private pending: Array<{ session_id: string; action_id: string }> = [];
  private readonly pendingFile: string;

  constructor(private readonly file: string) {
    this.pendingFile = `${file}.pending`;
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
    fs.mkdirSync(path.dirname(this.pendingFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.pendingFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.pending), { mode: 0o600 });
    fs.renameSync(tmp, this.pendingFile);
  }

  ids(): string[] {
    return Object.keys(this.recs);
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.recs), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
