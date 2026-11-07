// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Turns the commands Claw sends into session operations. The command set is closed: anything else is dropped and audited. */
import type { AgentConfig } from "./config.js";
import { SESSION_REF_RE } from "./attach.js";
import { Session, type SessionEnv } from "./session.js";
import type { TurnRecord } from "./session-store.js";
import { checkCwd } from "./roots.js";
import { REMOTE_COMMAND_TYPES, isRemoteCommandType } from "./protocol.js";
import { sha256, errMessage } from "./util.js";

export interface Command {
  cmd_id: string;
  type: string;
  session_id: string;
  /** The frame's id on the command stream (`cmd_seq`), when it came from there. */
  cmd_seq?: number;
  [k: string]: unknown;
}

const MAX_ACTIVE_SESSIONS = 10;

/** A session used this recently is told, after a restart, that it is back (Claude Code keeps a conversation resumable for hours). */
export const RECOVER_NOTICE_MS = 4 * 3600_000;

/**
 * What the agent is told when its turn was cut off by a restart while it waited for a person's permission. The request
 * died with the adapter; going on from the transcript makes the agent ask again, so the card comes back by itself.
 */
export const CONTINUE_PROMPT = "[claw-connector] The connector on this machine restarted while you were waiting for my permission, so that "
  + "request was cancelled. Continue the task from where you left off, and ask again for anything that still needs my permission.";

const cmdSeqOf = (cmd: Command): number | null => (Number.isSafeInteger(cmd.cmd_seq) ? cmd.cmd_seq! : null);

export class SessionManager {
  readonly sessions = new Map<string, Session>();
  /** Takeovers that have passed the "already attached" check and have not yet registered their session (`agent:ref`). */
  private readonly attaching = new Set<string>();
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
        if (typeof cmd.text !== "string" || cmd.text === "") { s.rejectCommand("prompt", cmdId, "text_required", cmdSeqOf(cmd)); return false; }
        s.enqueuePrompt(cmd.text, cmdId, handled, cmdSeqOf(cmd));
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
    // A repeat that comes after a restart (the cursor was not yet saved) finds the session recorded. A read-only one is
    // brought back read-only: it must not become a takeover because the terminal has closed in the meantime.
    if (this.env.store.get(sid)?.read_only) { await this.lookup(sid); return; }
    const agent = this.agent(cmd.agent_id);
    if (!agent) {
      this.env.audit.record("session_refused", { session_id: sid, reason: "unknown_agent", agent_id: String(cmd.agent_id).slice(0, 64) });
      this.env.emit(sid, "session_closed", { reason: "unknown_agent" });
      return;
    }
    const ref = cmd.resume_ref;
    if (agent.attach) return this.attachNew(cmd, agent);
    if (ref !== undefined && ref !== null) {
      // Starting a new session would answer a request to continue an old one with a different conversation.
      this.env.audit.record("session_refused", { session_id: sid, agent_id: agent.id, reason: "resume_not_supported" });
      this.env.emit(sid, "session_closed", { reason: "resume_not_supported" });
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

  /**
   * `session.new` for an agent that takes over an existing session: `resume_ref` names it, and it must be one the
   * adapter lists under this agent's roots. The directory it is resumed in is the one the session itself records;
   * the one Claw sent has to be the same. Whether another process has it open is checked when it is launched.
   */
  private async attachNew(cmd: Command, agent: AgentConfig): Promise<void> {
    const sid = cmd.session_id;
    const refuse = (reason: string, extra: Record<string, unknown> = {}) => {
      this.env.audit.record("session_refused", { session_id: sid, agent_id: agent.id, reason, ...extra });
      this.env.emit(sid, "session_closed", { reason });
    };
    const ref = typeof cmd.resume_ref === "string" ? cmd.resume_ref : "";
    if (!ref) return refuse("resume_ref_required");
    if (!SESSION_REF_RE.test(ref)) return refuse("invalid_resume_ref");
    const support = this.env.attach.get(agent.id);
    if (!support) return refuse("attach_unavailable");
    const want = ref.toLowerCase();
    // Commands of different Claw sessions run side by side, so the check and the claim on the conversation are one
    // synchronous step: two requests for the same conversation must not both get past it while one is still being
    // looked up, or two adapters would be writing to one transcript.
    const claim = `${agent.id}:${want}`;
    // A read-only session only reads the transcript, so it is no second writer: it does not hold the conversation.
    if (this.attaching.has(claim) || [...this.sessions.values()].some((s) => !s.closed && !s.readOnly && s.agent.id === agent.id && s.acpId?.toLowerCase() === want)) return refuse("already_attached");
    if ([...this.sessions.values()].filter((s) => !s.closed).length + this.attaching.size >= MAX_ACTIVE_SESSIONS) return refuse("too_many_sessions");
    this.attaching.add(claim);
    try {
      const found = await support.resolve(want);
      if (!found.ok) return refuse(found.reason);
      const asked = checkCwd(typeof cmd.cwd === "string" ? cmd.cwd : "", agent.roots);
      if (!asked.ok) return refuse(asked.reason, { cwd: String(cmd.cwd).slice(0, 300) });
      if (asked.real !== found.item.cwd) return refuse("cwd_mismatch", { cwd: String(cmd.cwd).slice(0, 300) });
      // Registered before anything is awaited, so from here the session itself is the claim.
      const s = new Session(sid, agent, found.item.cwd, this.env, found.item.ref);
      this.sessions.set(sid, s);
      this.attaching.delete(claim);
      await s.attach(typeof cmd.mode === "string" ? cmd.mode : null, found.item.title);
    } finally {
      this.attaching.delete(claim);
    }
  }

  /** The ids of the existing sessions this connector holds open, by agent. */
  attachedRefs(agentId: string): Set<string> {
    const out = new Set<string>();
    // (A read-only one is not: the conversation is the terminal's, and the list says so.)
    for (const s of this.sessions.values()) if (!s.closed && !s.readOnly && s.agent.id === agentId && s.acpId) out.add(s.acpId.toLowerCase());
    return out;
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
    // It stays read-only: a prompt to it after a restart is refused as before, never a takeover by surprise.
    if (rec.read_only) s.restoreSpectate();
    return s;
  }

  /** At start: every session that was watching a terminal's conversation goes on watching it (and notices when it ends). */
  async restoreReadOnly(): Promise<void> {
    for (const sid of this.env.store.ids()) {
      const rec = this.env.store.get(sid);
      if (rec?.read_only && rec.status === "active" && !this.sessions.has(sid)) await this.lookup(sid);
    }
  }

  /** After the command stream reconnects: cards still waiting are shown again. */
  resendPending(): void {
    for (const s of this.sessions.values()) s.resendPending();
  }

  get pendingPermissions(): number {
    return [...this.sessions.values()].reduce((n, s) => n + s.pendingCount, 0);
  }

  /**
   * After a restart (a crash, a kill, a supervisor's restart, an upgrade): every turn the previous run left running is
   * ended or carried on, and every session used lately is told it is back (`session_recovered`), once.
   *
   * A turn whose agent was waiting for a person's permission, cut off no longer ago than a card lives, goes on with
   * {@link CONTINUE_PROMPT} under the same prompt (`cmd_id`, `cmd_seq`): the agent asks again, so the card comes back,
   * and the prompt's own `turn_end` still ends it. It only asks, so nothing runs that a person has not approved. Any
   * other turn ends with `turn_end` `error: "connector_restarted"`, naming its prompt, so the phone stops waiting for it;
   * whether the agent finished what it was doing is in the conversation, which the next message resumes.
   */
  recover(o: { turns: TurnRecord[]; waiting: ReadonlySet<string>; downForMs: number | null; now?: number }): void {
    const now = o.now ?? Date.now();
    const told = new Set<string>();
    for (const t of o.turns) {
      const sid = t.session_id;
      const rec = this.env.store.get(sid);
      const active = rec?.status === "active";
      const waiting = Boolean(t.waiting) || o.waiting.has(sid);
      const recent = o.downForMs !== null && o.downForMs <= this.env.timing.permissionTtlMs;
      if (active && waiting && recent) {
        this.env.audit.record("turn_continued", { session_id: sid, cmd_id: t.cmd_id, cmd_seq: t.cmd_seq, down_ms: o.downForMs });
        this.env.emit(sid, "session_recovered", { reason: "connector_restart", interrupted: true, continuing: true, cmd_id: t.cmd_id, cmd_seq: t.cmd_seq });
        void this.handle({ cmd_id: t.cmd_id ?? `continue-${t.cmd_seq ?? sid}`, type: "prompt", session_id: sid, text: CONTINUE_PROMPT, ...(t.cmd_seq !== null ? { cmd_seq: t.cmd_seq } : {}) });
      } else {
        this.env.audit.record("turn_interrupted", { session_id: sid, cmd_id: t.cmd_id, cmd_seq: t.cmd_seq, waiting, down_ms: o.downForMs });
        // Before the turn_end: a phone reading the turn hears why it ended in the same place it hears that it ended.
        if (active) this.env.emit(sid, "session_recovered", { reason: "connector_restart", interrupted: true, continuing: false, cmd_id: t.cmd_id, cmd_seq: t.cmd_seq });
        this.env.emit(sid, "turn_end", { stopReason: "error", error: "connector_restarted", cmd_id: t.cmd_id, cmd_seq: t.cmd_seq });
      }
      told.add(sid);
    }
    for (const sid of this.env.store.ids()) {
      const rec = this.env.store.get(sid);
      if (told.has(sid) || rec?.status !== "active" || !rec.used_at) continue;
      const used = Date.parse(rec.used_at);
      if (!Number.isFinite(used) || now - used > RECOVER_NOTICE_MS) continue;
      this.env.emit(sid, "session_recovered", { reason: "connector_restart", interrupted: false, continuing: false });
    }
  }

  /**
   * Every adapter process, now. Sessions stay recorded and can be resumed. `restarting`: the connector is only going away
   * for a while (stopped, or restarted by its supervisor); what is in flight is left for the next run ({@link recover})
   * instead of being ended, and queued prompts are delivered again. Otherwise (the kill switch: revoked, paused) every
   * turn ends here and queued prompts count as handled.
   */
  async killAll(reason: string, restarting = false): Promise<void> {
    for (const s of this.sessions.values()) {
      this.env.audit.record("session_killed", { session_id: s.id, reason });
      if (restarting) s.shutdown();
      else s.dropQueued();
      s.stopTail();
    }
    await this.env.registry.killAll();
    this.sessions.clear();
  }
}
