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

  constructor(private readonly file: string) {
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
