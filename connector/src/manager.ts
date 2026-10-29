// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Turns the commands Claw sends into session operations. The command set is closed: anything else is dropped and audited. */
import type { AgentConfig } from "./config.js";
import { Session, type SessionEnv } from "./session.js";
import { checkCwd } from "./roots.js";
import { REMOTE_COMMAND_TYPES, isRemoteCommandType } from "./protocol.js";
import { sha256, errMessage } from "./util.js";

export interface Command {
  cmd_id: string;
  type: string;
  session_id: string;
  [k: string]: unknown;
}

const MAX_ACTIVE_SESSIONS = 10;

export class SessionManager {
  readonly sessions = new Map<string, Session>();
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly env: SessionEnv) {}

  private agent(id: unknown): AgentConfig | undefined {
    return typeof id === "string" ? this.env.config.agents.find((a) => a.id === id) : undefined;
  }

  /** Commands of one session run one after another; sessions run side by side. */
  handle(cmd: Command): Promise<void> {
    const sid = cmd.session_id;
    const prev = this.chains.get(sid) ?? Promise.resolve();
    const next = prev.then(() => this.dispatch(cmd)).catch((e) => {
      this.env.log.error("command failed", { type: cmd.type, session: sid, error: errMessage(e) });
      this.env.audit.record("command_failed", { type: cmd.type, session_id: sid, cmd_id: cmd.cmd_id, error: errMessage(e).slice(0, 300) });
    });
    this.chains.set(sid, next);
    void next.finally(() => { if (this.chains.get(sid) === next) this.chains.delete(sid); });
    return next;
  }

  private async dispatch(cmd: Command): Promise<void> {
    const { type, session_id: sid, cmd_id: cmdId } = cmd;
    // What a prompt says is never written to the audit trail, only its hash and size.
    const detail = type === "prompt" && typeof cmd.text === "string" ? { sha256: sha256(cmd.text), length: cmd.text.length } : {};
    this.env.audit.record("command", { type, session_id: sid, cmd_id: cmdId, ...detail });

    if (type === "session.new") return this.sessionNew(cmd);
    if (!isRemoteCommandType(type)) {
      this.env.audit.record("command_dropped", { type: String(type).slice(0, 64), session_id: sid, cmd_id: cmdId, reason: "not_a_known_command", known: [...REMOTE_COMMAND_TYPES, "session.new"] });
      return;
    }
    const s = await this.lookup(sid);
    if (!s) {
      this.env.emit(sid, "session_closed", { reason: "unknown_session" });
      return;
    }
    switch (type) {
      case "prompt":
        if (typeof cmd.text !== "string" || cmd.text === "") return s.rejectCommand("prompt", cmdId, "text_required");
        return s.enqueuePrompt(cmd.text, cmdId);
      case "cancel":
        return s.cancel();
      case "set_mode":
        if (typeof cmd.mode_id !== "string") return s.rejectCommand("set_mode", cmdId, "mode_id_required");
        return s.setMode(cmd.mode_id, cmdId);
      case "resume":
        return s.resume(cmdId);
      case "close":
        return s.close("closed");
      case "decision":
        if (typeof cmd.action_id !== "string" || typeof cmd.option_id !== "string") return s.rejectCommand("decision", cmdId, "action_and_option_required");
        return s.decide(cmd.action_id, cmd.option_id, typeof cmd.by === "string" ? cmd.by : null, cmdId);
    }
  }

  private async sessionNew(cmd: Command): Promise<void> {
    const sid = cmd.session_id;
    if (this.sessions.has(sid)) return; // a repeat of a command already carried out
    const agent = this.agent(cmd.agent_id);
    if (!agent) {
      this.env.audit.record("session_refused", { session_id: sid, reason: "unknown_agent", agent_id: String(cmd.agent_id).slice(0, 64) });
      this.env.emit(sid, "session_closed", { reason: "unknown_agent" });
      return;
    }
    const verdict = checkCwd(typeof cmd.cwd === "string" ? cmd.cwd : "", agent.roots);
    if (!verdict.ok) {
      // The directory is outside everything this agent may touch: no process is started.
      this.env.audit.record("session_refused", { session_id: sid, agent_id: agent.id, reason: verdict.reason, cwd: String(cmd.cwd).slice(0, 300) });
      this.env.emit(sid, "session_closed", { reason: verdict.reason });
      return;
    }
    const active = [...this.sessions.values()].filter((s) => !s.closed).length;
    if (active >= MAX_ACTIVE_SESSIONS) {
      this.env.audit.record("session_refused", { session_id: sid, agent_id: agent.id, reason: "too_many_sessions" });
      this.env.emit(sid, "session_closed", { reason: "too_many_sessions" });
      return;
    }
    const s = new Session(sid, agent, verdict.real, this.env);
    this.sessions.set(sid, s);
    await s.create(typeof cmd.mode === "string" ? cmd.mode : null);
  }

  /** A session this process knows, or one it made earlier (before a restart) and can bring back. */
  private async lookup(sid: string): Promise<Session | null> {
    const have = this.sessions.get(sid);
    if (have) return have;
    const rec = this.env.store.get(sid);
    if (!rec || rec.status !== "active") return null;
    const agent = this.agent(rec.agent_id);
    // The policy is read again: a directory that left the whitelist since stays out.
    const verdict = agent ? checkCwd(rec.cwd, agent.roots) : null;
    if (!agent || !verdict?.ok) {
      this.env.store.patch(sid, { status: "closed" });
      this.env.audit.record("session_refused", { session_id: sid, reason: agent ? "cwd_outside_roots" : "unknown_agent" });
      this.env.emit(sid, "session_closed", { reason: agent ? "cwd_outside_roots" : "unknown_agent" });
      return null;
    }
    const s = new Session(sid, agent, verdict.real, this.env, rec.acp_session_id, rec.mode);
    this.sessions.set(sid, s);
    return s;
  }

  /** After the command stream reconnects: cards still waiting are shown again. */
  resendPending(): void {
    for (const s of this.sessions.values()) s.resendPending();
  }

  get pendingPermissions(): number {
    return [...this.sessions.values()].reduce((n, s) => n + s.pendingCount, 0);
  }

  /** The kill switch: every adapter process, now. Sessions stay recorded and can be resumed. */
  async killAll(reason: string): Promise<void> {
    for (const s of this.sessions.values()) {
      this.env.audit.record("session_killed", { session_id: s.id, reason });
    }
    await this.env.registry.killAll();
    this.sessions.clear();
  }
}
