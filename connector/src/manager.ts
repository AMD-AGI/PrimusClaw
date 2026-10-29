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

  /**
   * Commands of one session run one after another; sessions run side by side.
   * `handled` is called exactly once, when the command counts as carried out: for most that is when the
   * handler returns; for a prompt it is when the prompt reaches the adapter (see Session.enqueuePrompt).
   */
  handle(cmd: Command, handled: () => void = () => {}): Promise<void> {
    const sid = cmd.session_id;
    let done = false;
    const once = () => { if (!done) { done = true; handled(); } };
    const prev = this.chains.get(sid) ?? Promise.resolve();
    const next = prev.then(() => this.dispatch(cmd, once)).catch((e) => {
      this.env.log.error("command failed", { type: cmd.type, session: sid, error: errMessage(e) });
      this.env.audit.record("command_failed", { type: cmd.type, session_id: sid, cmd_id: cmd.cmd_id, error: errMessage(e).slice(0, 300) });
      once();
    });
    this.chains.set(sid, next);
    void next.finally(() => { if (this.chains.get(sid) === next) this.chains.delete(sid); });
    return next;
  }

  private async dispatch(cmd: Command, handled: () => void): Promise<void> {
    let deferred = false;
    try {
      deferred = await this.run(cmd, handled);
    } finally {
      if (!deferred) handled();
    }
  }

  /** Returns true when `handled` will be called later by the session itself (a prompt). */
  private async run(cmd: Command, handled: () => void): Promise<boolean> {
    const { type, session_id: sid, cmd_id: cmdId } = cmd;
    // What a prompt says is never written to the audit trail, only its hash and size.
    const detail = type === "prompt" && typeof cmd.text === "string" ? { sha256: sha256(cmd.text), length: cmd.text.length } : {};
    this.env.audit.record("command", { type, session_id: sid, cmd_id: cmdId, ...detail });

    if (type === "session.new") { await this.sessionNew(cmd); return false; }
    if (!isRemoteCommandType(type)) {
      this.env.audit.record("command_dropped", { type: String(type).slice(0, 64), session_id: sid, cmd_id: cmdId, reason: "not_a_known_command", known: [...REMOTE_COMMAND_TYPES, "session.new"] });
      return false;
    }
    const s = await this.lookup(sid);
    if (!s) {
      this.env.emit(sid, "session_closed", { reason: "unknown_session" });
      return false;
    }
    switch (type) {
      case "prompt":
        if (typeof cmd.text !== "string" || cmd.text === "") { s.rejectCommand("prompt", cmdId, "text_required"); return false; }
        s.enqueuePrompt(cmd.text, cmdId, handled);
        return true;
      case "cancel":
        await s.cancel();
        return false;
      case "set_mode":
        if (typeof cmd.mode_id !== "string") s.rejectCommand("set_mode", cmdId, "mode_id_required");
        else await s.setMode(cmd.mode_id, cmdId);
        return false;
      case "resume":
        await s.resume(cmdId);
        return false;
      case "close":
        await s.close("closed");
        return false;
      case "decision":
        if (typeof cmd.action_id !== "string" || typeof cmd.option_id !== "string") s.rejectCommand("decision", cmdId, "action_and_option_required");
        else s.decide(cmd.action_id, cmd.option_id, typeof cmd.by === "string" ? cmd.by : null, cmdId);
        return false;
    }
    return false;
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
      s.dropQueued();
    }
    await this.env.registry.killAll();
    this.sessions.clear();
  }
}
