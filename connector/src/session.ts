// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One remote session: an adapter process, the ACP session inside it, and every
 * rule the machine's owner put on it.
 *
 * Three guards live here and fail closed:
 *  - the working directory must be inside the agent's roots (checked by the caller before this runs);
 *  - the session is forced into the agent's ask mode and the mode is READ BACK from the adapter before any
 *    prompt runs. A user's own settings can start an adapter in a mode that never asks (bypass, full access),
 *    in which case it would not send a single permission request. A mode the adapter does not confirm, or a
 *    warning that its permission callback will not be invoked, closes the session instead of opening it;
 *  - a permission answer must be one of the options the adapter offered.
 *
 * The owner can opt an agent out of per-step approval (`approval = "never"`, or `allow_unsafe_modes`). Then the
 * unsafe modes may be used and an adapter's "will not ask" warning is accepted (audited) instead of closing the
 * session. Without that opt-in every one of these guards stays as it was. Whichever way a session runs, every
 * event that names its mode also says whether it is `unattended`, so a phone always shows it.
 */
import path from "node:path";
import type { Audit } from "./audit.js";
import { AdapterProcess, type AcpParams, type AdapterHooks } from "./adapter.js";
import type { ChildRegistry } from "./children.js";
import type { AgentConfig, ConnectorConfig } from "./config.js";
import {
  PermissionBook, boundedInput, matchAutoAllow, normalizeOptions, type OfferedOption,
} from "./permissions.js";
import { redactDeep } from "./redact.js";
import type { SessionStore } from "./session-store.js";
import { errMessage, isObject, sleep, truncateBytes, type Logger } from "./util.js";

export type Emit = (sessionId: string, type: string, data: Record<string, unknown>) => void;

export interface SessionTiming {
  /** A session with no activity for this long loses its adapter process (the session itself stays and resumes on demand). */
  idleMs: number;
  /** A permission request nobody answers is answered `cancelled` after this long. */
  permissionTtlMs: number;
  /** How long to wait for an adapter to confirm a mode change by notification when it has no other way to be asked. */
  modeConfirmMs: number;
}

export const DEFAULT_SESSION_TIMING: SessionTiming = { idleMs: 30 * 60_000, permissionTtlMs: 10 * 60_000, modeConfirmMs: 3_000 };

export interface SessionEnv {
  config: ConnectorConfig;
  audit: Audit;
  registry: ChildRegistry;
  emit: Emit;
  store: SessionStore;
  timing: SessionTiming;
  logDir: string;
  version: string;
  log: Logger;
}

export interface ModeInfo { id: string; name?: string; description?: string }

/** A refusal that closes the session, with a stable reason a client can show. */
export class SessionRefusal extends Error {
  constructor(readonly reason: string, message?: string) { super(message ?? reason); }
}

const MAX_TOOL_OUTPUT_BYTES = 8 * 1024;
const MAX_QUEUED_PROMPTS = 5;
const PERMISSION_WARNING_RE = /canUseTool will not be invoked/i;

export class Session {
  cwd: string;
  acpId: string | null;
  adapter: AdapterProcess | null = null;
  currentMode: string | null = null;
  modes: ModeInfo[] = [];
  closed = false;
  /** The adapter warned that it will not ask for permission and the owner's opt-in accepted that. Per adapter process. */
  private noAskWarning = false;
  /** The phone already knows this session: a mode change is worth an event. */
  private announced: boolean;
  private modeConfigId: string | null = null;
  private targetMode: string;
  private enforcing = false;
  private modeSeen: string[] = [];
  private replaying = false;
  private turnRunning = false;
  private queue: Array<{ text: string; cmdId: string | null; started: () => void }> = [];
  private launching: Promise<void> | null = null;
  private idle: NodeJS.Timeout | undefined;
  private readonly book: PermissionBook;

  constructor(readonly id: string, readonly agent: AgentConfig, cwd: string, private readonly env: SessionEnv, acpId: string | null = null, mode: string | null = null) {
    this.cwd = cwd;
    this.acpId = acpId;
    this.announced = acpId !== null;
    this.targetMode = mode ?? agent.askMode;
    // The policy is read again after a restart: a mode the owner no longer allows is not brought back.
    if (!agent.safeModes.includes(this.targetMode) && !agent.allowUnsafeModes && this.targetMode !== agent.askMode) {
      this.env.audit.record("mode_reverted", { session_id: id, agent_id: agent.id, from: this.targetMode, to: agent.askMode, reason: "no_longer_allowed" });
      this.targetMode = agent.askMode;
    }
    this.book = new PermissionBook(env.timing.permissionTtlMs, (actionId) => {
      this.env.audit.record("permission_expired", { session_id: this.id, action_id: actionId });
      this.emit("permission_resolved", { actionId, optionId: null, outcome: "cancelled", by: "timeout" });
    });
  }

  // --- helpers -----------------------------------------------------------------

  private emit(type: string, data: Record<string, unknown>): void {
    this.env.emit(this.id, type, data);
  }

  private audit(kind: string, detail: Record<string, unknown> = {}): void {
    this.env.audit.record(kind, { session_id: this.id, agent_id: this.agent.id, ...detail });
  }

  private touch(): void {
    clearTimeout(this.idle);
    if (this.closed) return;
    this.idle = setTimeout(() => void this.recycle(), this.env.timing.idleMs);
    this.idle.unref?.();
  }

  get pendingCount(): number { return this.book.size; }
  get busy(): boolean { return this.turnRunning || this.queue.length > 0 || this.book.size > 0; }

  /** Whether `mode` may be selected from a phone. */
  modeAllowed(mode: string): boolean {
    return this.agent.safeModes.includes(mode) || (this.agent.allowUnsafeModes && (this.modes.length === 0 || this.modes.some((m) => m.id === mode)));
  }

  /** Whether this session runs without asking before every write and command: its mode is not a safe one, or its adapter said it will not ask. */
  get unattended(): boolean {
    return this.noAskWarning || (this.currentMode !== null && !this.agent.safeModes.includes(this.currentMode));
  }

  private shownModes(): Array<ModeInfo & { unattended: boolean }> {
    return this.modes.filter((m) => this.modeAllowed(m.id)).map((m) => ({ ...m, unattended: !this.agent.safeModes.includes(m.id) }));
  }

  // --- starting ----------------------------------------------------------------

  /** `session.new`: start the adapter, create the ACP session, lock the mode. A refusal closes the session with a reason. */
  async create(requestedMode: string | null): Promise<void> {
    if (requestedMode && !this.agent.safeModes.includes(requestedMode) && !this.agent.allowUnsafeModes) {
      return this.refuse(new SessionRefusal("mode_not_allowed", `mode ${requestedMode} needs approval = "never" for this agent (or allow_unsafe_modes) on this machine`));
    }
    if (requestedMode) this.targetMode = requestedMode;
    try {
      await this.launch("new");
    } catch (e) {
      return this.refuse(e);
    }
    if (this.closed) return;
    this.env.store.put(this.id, { agent_id: this.agent.id, acp_session_id: this.acpId, cwd: this.cwd, status: "active", mode: this.currentMode, created_at: new Date().toISOString() });
    this.audit("session_started", { cwd: this.cwd, mode: this.currentMode, unattended: this.unattended, acp_session_id: this.acpId });
    this.emit("session_started", { acp_session_id: this.acpId, agent_id: this.agent.id, kind: this.agent.kind, cwd: this.cwd, modes: this.shownModes(), currentMode: this.currentMode, unattended: this.unattended });
    this.announced = true;
    this.touch();
  }

  /** Start (or restart) the adapter and bring the ACP session up in a verified mode. One at a time. */
  private launch(how: "new" | "resume"): Promise<void> {
    this.launching ??= this.doLaunch(how).finally(() => { this.launching = null; });
    return this.launching;
  }

  private async doLaunch(how: "new" | "resume"): Promise<void> {
    // A warning belongs to the adapter process that printed it; a new process says its own.
    this.noAskWarning = false;
    const adapter = await AdapterProcess.start({
      cfg: this.agent, registry: this.env.registry, sessionId: this.id, cwd: this.cwd, hooks: this.hooks(),
      logFile: path.join(this.env.logDir, `adapter-${this.agent.id}.log`), version: this.env.version,
    }).catch((e) => { throw new SessionRefusal("adapter_start_failed", errMessage(e)); });
    // A refusal that came in while the adapter was starting (its own start-up warning) leaves nothing running.
    if (this.closed) { await adapter.kill(); throw new SessionRefusal("session_closed"); }
    this.adapter = adapter;
    this.modeSeen = [];
    try {
      if (how === "new") {
        const res = await adapter.request("session/new", { cwd: this.cwd, mcpServers: [] });
        if (typeof res.sessionId !== "string") throw new SessionRefusal("adapter_protocol", "session/new returned no session id");
        this.acpId = res.sessionId;
        this.absorb(res);
      } else {
        if (!this.acpId) throw new SessionRefusal("adapter_cannot_resume", "no adapter session to resume");
        const caps = adapter.caps.sessionCapabilities as AcpParams | undefined;
        if (caps?.resume) {
          // `resume` does not replay the history, and the adapter's own settings apply again: the mode is re-locked below.
          this.absorb(await adapter.request("session/resume", { sessionId: this.acpId, cwd: this.cwd, mcpServers: [] }));
        } else if (adapter.caps.loadSession) {
          this.replaying = true;
          try { this.absorb(await adapter.requestUnbounded("session/load", { sessionId: this.acpId, cwd: this.cwd, mcpServers: [] })); } finally { this.replaying = false; }
        } else {
          throw new SessionRefusal("adapter_cannot_resume", "the adapter can neither resume nor load a session");
        }
      }
      await this.enforceMode(this.targetMode);
      if (this.closed) throw new SessionRefusal("session_closed");
    } catch (e) {
      await this.dropAdapter();
      throw e instanceof SessionRefusal ? e : mapAdapterError(e);
    }
  }

  /** Take the modes and the mode config option out of a `session/new|resume|load` answer. */
  private absorb(res: AcpParams): void {
    const modes = res.modes as AcpParams | undefined;
    if (modes && Array.isArray(modes.availableModes)) {
      this.modes = modes.availableModes.filter((m: unknown) => isObject(m) && typeof m.id === "string").map((m: AcpParams) => ({ id: m.id, name: m.name, description: m.description }));
    }
    const opts = res.configOptions;
    if (Array.isArray(opts)) {
      const mode = opts.find((o: unknown) => isObject(o) && o.category === "mode" && typeof o.id === "string");
      if (mode) this.modeConfigId = mode.id as string;
    }
    this.currentMode = typeof modes?.currentModeId === "string" ? modes.currentModeId : this.currentMode;
  }

  // --- the mode lock --------------------------------------------------------------

  /**
   * Put the session in `mode` and read the adapter's own answer back.
   *
   * The read-back is not the answer to `set_mode` (that is empty). It is the
   * adapter reporting its current mode: the mode option's value in the answer to
   * `session/set_config_option`, or, for an adapter with no such option, a mode
   * notification that arrives after the change. If neither confirms `mode`, the
   * session is not opened.
   */
  private async enforceMode(mode: string): Promise<void> {
    const a = this.adapter;
    if (!a || !this.acpId) throw new SessionRefusal("adapter_gone");
    if (this.modes.length && !this.modes.some((m) => m.id === mode)) throw new SessionRefusal("mode_unavailable", `the adapter offers no mode ${mode}`);
    this.enforcing = true;
    this.modeSeen = [];
    try {
      try {
        await a.request("session/set_mode", { sessionId: this.acpId, modeId: mode });
      } catch (e) {
        throw new SessionRefusal("mode_not_enforced", `set_mode ${mode} failed: ${errMessage(e)}`);
      }
      const confirmed = await this.readBackMode(a, mode);
      if (confirmed === null) throw new SessionRefusal("mode_not_confirmed", `the adapter did not confirm mode ${mode}`);
      if (confirmed !== mode) throw new SessionRefusal("mode_mismatch", `asked for mode ${mode}, the adapter reports ${confirmed}`);
      this.currentMode = confirmed;
      this.targetMode = mode;
      this.env.store.patch(this.id, { mode: confirmed });
    } finally {
      this.enforcing = false;
    }
  }

  private async readBackMode(a: AdapterProcess, mode: string): Promise<string | null> {
    if (this.modeConfigId && this.acpId) {
      // Idempotent: it sets the option to the value just set and answers with every option's current value.
      try {
        const res = await a.request("session/set_config_option", { sessionId: this.acpId, configId: this.modeConfigId, value: mode });
        const opt = Array.isArray(res.configOptions) ? res.configOptions.find((o: AcpParams) => o?.id === this.modeConfigId) : undefined;
        if (opt && typeof opt.currentValue === "string") return opt.currentValue;
      } catch { /* fall through to notifications */ }
    }
    const deadline = Date.now() + this.env.timing.modeConfirmMs;
    while (Date.now() < deadline) {
      const last = this.modeSeen[this.modeSeen.length - 1];
      if (last !== undefined) return last;
      await sleep(25);
    }
    return this.modeSeen[this.modeSeen.length - 1] ?? null;
  }

  /** An adapter reported its mode. A mode this machine does not allow is undone at once. */
  private noteMode(mode: string): void {
    this.modeSeen.push(mode);
    if (this.enforcing) return;
    if (mode === this.currentMode) return;
    const from = this.currentMode;
    this.currentMode = mode;
    if (!this.modeAllowed(mode)) {
      this.audit("mode_reverted", { from, to: mode, back_to: this.agent.askMode });
      this.emit("mode_update", { currentMode: mode, reverted: true, unattended: this.unattended });
      void this.enforceMode(this.agent.askMode).then(
        () => this.emit("mode_update", { currentMode: this.currentMode, unattended: this.unattended }),
        (e) => this.refuse(e),
      );
      return;
    }
    this.emit("mode_update", { currentMode: mode, unattended: this.unattended });
  }

  /** `set_mode`: a user-chosen mode, only from the allowed list, always read back. */
  async setMode(modeId: string, cmdId: string | null): Promise<void> {
    if (!this.adapter) await this.ensureAdapter();
    if (!this.modeAllowed(modeId)) return this.rejectCommand("set_mode", cmdId, "mode_not_allowed");
    if (this.modes.length && !this.modes.some((m) => m.id === modeId)) return this.rejectCommand("set_mode", cmdId, "mode_unavailable");
    const previous = this.targetMode;
    try {
      await this.enforceMode(modeId);
      this.audit("mode_set", { mode: modeId, unattended: this.unattended });
      this.emit("mode_update", { currentMode: this.currentMode, unattended: this.unattended });
    } catch (e) {
      // The adapter did not take it: go back to a mode known to ask.
      this.audit("mode_set_failed", { mode: modeId, error: errMessage(e) });
      try { await this.enforceMode(previous); } catch (again) { return this.refuse(again); }
      this.rejectCommand("set_mode", cmdId, e instanceof SessionRefusal ? e.reason : "set_mode_failed");
    }
  }

  // --- adapter callbacks ------------------------------------------------------------

  private hooks(): AdapterHooks {
    return {
      onUpdate: (update, params) => this.onUpdate(update, params),
      onPermission: (params) => this.onPermission(params),
      onExtension: (method, params) => this.onExtension(method, params),
      onNotification: (method, params) => this.onNotification(method, params),
      onStderr: (line) => { if (PERMISSION_WARNING_RE.test(line)) this.onUnsafeWarning(line); },
      onExit: (info) => this.onExit(info),
    };
  }

  /**
   * The adapter says it will not ask for permission (its own settings start it in a mode that does not, or an allow
   * rule shadows the callback). With the owner's opt-in for this agent that is accepted: audited, and the session says
   * it is unattended. Without it the session is closed, as before.
   */
  private onUnsafeWarning(text: string): void {
    const accepted = this.agent.allowUnsafeModes;
    this.audit("permission_callback_warning", { text: text.slice(0, 300), accepted });
    if (!accepted) {
      void this.refuse(new SessionRefusal("mode_not_enforced", "the adapter warned that it will not ask for permission"));
      return;
    }
    if (this.noAskWarning) return;
    this.noAskWarning = true;
    if (this.announced && !this.closed) this.emit("mode_update", { currentMode: this.currentMode, unattended: true });
  }

  private onExit(info: { code: number | null; signal: NodeJS.Signals | null }): void {
    this.adapter = null;
    const hadTurn = this.turnRunning;
    const cancelled = this.book.cancelAll();
    for (const actionId of cancelled) this.emit("permission_resolved", { actionId, optionId: null, outcome: "cancelled", by: "adapter_exit" });
    if (!this.closed) this.audit("adapter_exited", { code: info.code, signal: info.signal, during_turn: hadTurn });
  }

  private onUpdate(update: AcpParams, params: AcpParams): void {
    this.touch();
    const type = typeof update?.sessionUpdate === "string" ? update.sessionUpdate : null;
    if (!type) return;
    if (type === "current_mode_update" && typeof update.currentModeId === "string") return this.noteMode(update.currentModeId);
    if (type === "config_option_update" && Array.isArray(update.configOptions)) {
      const mode = update.configOptions.find((o: AcpParams) => o?.category === "mode");
      if (mode && typeof mode.currentValue === "string") this.noteMode(mode.currentValue);
      return;
    }
    // A long list of slash commands is of no use to a phone.
    if (type === "available_commands_update") return;
    const text = type === "agent_message_chunk" && isObject(update.content) && typeof update.content.text === "string" ? update.content.text : "";
    if (text) {
      if (PERMISSION_WARNING_RE.test(text)) return this.onUnsafeWarning(text);
      if (this.env.config.dropMessagePatterns.some((re) => re.test(text))) return;
    }
    const data = limitStrings(redactDeep({ sessionId: params.sessionId, update }) as Record<string, unknown>, MAX_TOOL_OUTPUT_BYTES);
    if (this.replaying) {
      // History replayed by `session/load`: kept, marked, so a client does not render it as new.
      if (type === "user_message_chunk" || type === "agent_message_chunk" || type === "agent_thought_chunk" || type === "tool_call") this.emit(type, { ...data, replay: true });
      return;
    }
    this.emit(type, data);
  }

  private onNotification(method: string, params: AcpParams): void {
    this.touch();
    // Notifications outside ACP proper (Cursor's todo and task updates): shown, never needed.
    const type = method.replace(/[^A-Za-z0-9._:-]/g, ".").slice(0, 64);
    this.emit(type, limitStrings(redactDeep({ method, params }) as Record<string, unknown>, MAX_TOOL_OUTPUT_BYTES));
  }

  // --- permissions ------------------------------------------------------------------

  private onPermission(params: AcpParams): Promise<AcpParams> {
    this.touch();
    const toolCall = (isObject(params.toolCall) ? params.toolCall : {}) as AcpParams;
    const options = normalizeOptions(params.options);
    if (this.closed || options.length === 0) return Promise.resolve({ outcome: { outcome: "cancelled" } });

    const rule = matchAutoAllow(this.agent.autoAllow, toolCall, this.cwd);
    const allowOnce = options.find((o) => o.kind === "allow_once");
    if (rule && allowOnce) {
      // Decided here, on this machine, by the owner's own rule; never by anything Claw sent.
      this.audit("auto_allow", { rule: `${rule.kind}:${rule.pathGlob}`, tool: toolCall.title, tool_kind: toolCall.kind, option_id: allowOnce.optionId });
      this.emit("permission_auto_allowed", { tool: str(toolCall.title, 200), kind: str(toolCall.kind, 64), rule: `${rule.kind}:${rule.pathGlob}`, optionId: allowOnce.optionId });
      return Promise.resolve({ outcome: { outcome: "selected", optionId: allowOnce.optionId } });
    }
    return this.askPerson(options, {
      tool: str(toolCall.title, 200), kind: str(toolCall.kind, 64), input: boundedInput(toolCall.rawInput), toolCallId: str(toolCall.toolCallId, 128),
    }, (optionId) => (optionId === null ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId } }));
  }

  /** Put a question on the phone and wait for the answer, a cancel or the timeout. `shape` turns the answer into what the adapter expects. */
  private askPerson(options: OfferedOption[], info: Record<string, unknown>, shape: (optionId: string | null) => AcpParams): Promise<AcpParams> {
    return new Promise<AcpParams>((resolve) => {
      const p = this.book.open(options, (actionId) => redactDeep({ actionId, ...info, options, timeout_ms: this.book.ttl }) as Record<string, unknown>, (optionId) => {
        this.env.store.removePending(this.id, p.actionId);
        resolve(shape(optionId));
      });
      this.env.store.addPending(this.id, p.actionId);
      this.audit("permission_requested", { action_id: p.actionId, tool: info.tool, tool_kind: info.kind, options: options.map((o) => o.optionId) });
      this.emit("permissionRequest", p.payload);
    });
  }

  /** A person's answer from the phone. Only an option that was offered is accepted. */
  decide(actionId: string, optionId: string, by: string | null, cmdId: string | null): void {
    this.touch();
    const result = this.book.decide(actionId, optionId);
    if (!result.ok) {
      this.audit("decision_refused", { action_id: actionId, option_id: optionId, reason: result.reason, cmd_id: cmdId });
      return;
    }
    this.audit("permission_resolved", { action_id: actionId, option_id: optionId, by });
    this.emit("permission_resolved", { actionId, optionId, by });
  }

  /** After a reconnect: the cards that are still waiting, sent again (same `actionId`, so a client treats them as the same card). */
  resendPending(): void {
    for (const p of this.book.list()) this.emit("permissionRequest", { ...p.payload, resent: true });
  }

  /** The Cursor extension requests the adapter blocks on. Never left unanswered. */
  private onExtension(method: string, params: AcpParams): Promise<AcpParams> {
    this.touch();
    if (method === "cursor/create_plan") {
      const options: OfferedOption[] = [
        { optionId: "plan-accept", name: "Accept the plan", kind: "allow_once" },
        { optionId: "plan-reject", name: "Reject the plan", kind: "reject_once" },
      ];
      return this.askPerson(options, {
        tool: `Plan: ${str(params.name, 150) || "proposed plan"}`, kind: "switch_mode",
        input: boundedInput({ overview: params.overview, plan: params.plan, todos: params.todos }), toolCallId: str(params.toolCallId, 128),
      }, (id) => ({ outcome: id === "plan-accept" ? { outcome: "accepted" } : id === "plan-reject" ? { outcome: "rejected", reason: "rejected from the phone" } : { outcome: "cancelled" } }));
    }
    if (method === "cursor/ask_question") {
      const qs = Array.isArray(params.questions) ? params.questions : [];
      const q = qs.length === 1 && isObject(qs[0]) ? (qs[0] as AcpParams) : null;
      const opts = q && Array.isArray(q.options) ? q.options.filter((o: unknown) => isObject(o) && typeof o.id === "string" && o.id !== "skip") : [];
      if (!q || q.allowMultiple === true || opts.length === 0 || opts.length > 8) {
        // More than one question, or a multi-select: no single card can carry it. Say so and let the agent go on.
        this.audit("extension_skipped", { method, questions: qs.length });
        this.emit("extension_skipped", { method, reason: "unsupported_question_shape", questions: redactDeep(qs) });
        return Promise.resolve({ outcome: { outcome: "skipped", reason: "this client cannot show that question" } });
      }
      const options: OfferedOption[] = [
        ...opts.map((o: AcpParams) => ({ optionId: String(o.id), name: String(o.label ?? o.id).slice(0, 200), kind: "allow_once" })),
        { optionId: "skip", name: "Skip the question", kind: "reject_once" },
      ];
      return this.askPerson(options, { tool: str(q.prompt, 200) || "Question", kind: "question", input: null, toolCallId: str(params.toolCallId, 128) },
        (id) => id === null ? { outcome: { outcome: "cancelled" } }
          : id === "skip" ? { outcome: { outcome: "skipped" } }
          : { outcome: { outcome: "answered", answers: [{ questionId: String(q.id), selectedOptionIds: [id] }] } });
    }
    return Promise.reject(new Error(`unsupported extension ${method}`));
  }

  // --- turns ----------------------------------------------------------------------------

  /**
   * `prompt`: queued behind a running turn, run in order. Returns once accepted, not when the turn ends.
   * `started` is called exactly once, when the prompt reaches the adapter or is dropped (refused, cancelled,
   * the session closed): only then does the connector count the command as handled, so a restart before that
   * delivers it again instead of losing it.
   */
  enqueuePrompt(text: string, cmdId: string | null, started: () => void = () => {}): void {
    if (this.closed) { this.rejectCommand("prompt", cmdId, "session_closed"); return started(); }
    if (this.queue.length >= MAX_QUEUED_PROMPTS) { this.rejectCommand("prompt", cmdId, "too_many_queued_prompts"); return started(); }
    this.queue.push({ text, cmdId, started });
    if (!this.turnRunning) void this.pump();
  }

  /** Prompts that will now never run (the process is being stopped): they count as handled. */
  dropQueued(): void {
    const q = this.queue;
    this.queue = [];
    for (const item of q) item.started();
  }

  private async pump(): Promise<void> {
    if (this.turnRunning) return;
    this.turnRunning = true;
    try {
      while (this.queue.length && !this.closed) {
        const next = this.queue.shift()!;
        await this.runTurn(next.text, next.started);
      }
    } finally {
      this.turnRunning = false;
      this.touch();
    }
  }

  private async runTurn(text: string, started: () => void): Promise<void> {
    try {
      await this.ensureAdapter();
    } catch (e) {
      started();
      this.emit("turn_end", { stopReason: "error", error: e instanceof SessionRefusal ? e.reason : "adapter_unavailable" });
      return this.refuse(e);
    }
    const a = this.adapter!;
    this.audit("turn_started", { length: text.length });
    try {
      const reply = a.requestUnbounded("session/prompt", { sessionId: this.acpId, prompt: [{ type: "text", text }] });
      started();
      const res = await reply;
      const usage = isObject(res.usage) ? res.usage : undefined;
      this.emit("turn_end", { stopReason: typeof res.stopReason === "string" ? res.stopReason : "end_turn", ...(usage ? { usage } : {}) });
    } catch (e) {
      this.audit("turn_failed", { error: errMessage(e) });
      this.emit("turn_end", { stopReason: "error", error: errMessage(e).slice(0, 300) });
    }
  }

  /** A recycled (or crashed) adapter comes back on demand. */
  private async ensureAdapter(): Promise<void> {
    if (this.adapter && !this.adapter.exited) return;
    this.adapter = null;
    await this.launch("resume");
    this.audit("session_resumed", { mode: this.currentMode });
  }

  /** `resume`: bring the session back. A live adapter is NOT asked to resume (that would reset its mode); the mode is re-asserted instead. */
  async resume(cmdId: string | null): Promise<void> {
    if (this.closed) return this.rejectCommand("resume", cmdId, "session_closed");
    try {
      if (this.adapter && !this.adapter.exited) await this.enforceMode(this.targetMode);
      else await this.launch("resume");
    } catch (e) {
      return this.refuse(e);
    }
    this.audit("session_resumed", { mode: this.currentMode, unattended: this.unattended });
    this.emit("session_resumed", { acp_session_id: this.acpId, modes: this.shownModes(), currentMode: this.currentMode, unattended: this.unattended });
    this.touch();
  }

  /** `cancel`: stop the turn, drop what was queued, answer every waiting permission request `cancelled`. */
  async cancel(): Promise<void> {
    const queued = this.queue.length;
    this.dropQueued();
    const wasRunning = this.turnRunning;
    if (wasRunning && this.adapter && this.acpId) await this.adapter.notify("session/cancel", { sessionId: this.acpId }).catch(() => undefined);
    for (const actionId of this.book.cancelAll()) this.emit("permission_resolved", { actionId, optionId: null, outcome: "cancelled", by: "cancel" });
    this.audit("cancelled", { turn_running: wasRunning, queued_dropped: queued });
    // A running turn ends with its own `turn_end` (stopReason cancelled). With none running, say so once.
    if (!wasRunning) this.emit("turn_end", { stopReason: "cancelled" });
  }

  // --- ending ----------------------------------------------------------------------------

  /** The adapter's process goes away; the session stays and resumes on demand. */
  async recycle(): Promise<void> {
    if (this.closed || this.busy || !this.adapter) return;
    this.audit("adapter_recycled", { idle_ms: this.env.timing.idleMs });
    await this.dropAdapter();
  }

  private async dropAdapter(): Promise<void> {
    const a = this.adapter;
    this.adapter = null;
    if (a) await a.kill();
  }

  /** `close`, and the common end of every refusal. */
  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idle);
    this.dropQueued();
    for (const actionId of this.book.cancelAll()) this.emit("permission_resolved", { actionId, optionId: null, outcome: "cancelled", by: reason });
    const a = this.adapter;
    if (a && this.acpId && (a.caps.sessionCapabilities as AcpParams | undefined)?.close) await a.request("session/close", { sessionId: this.acpId }, 5_000).catch(() => undefined);
    await this.dropAdapter();
    this.env.store.patch(this.id, { status: "closed" });
    this.audit("session_closed", { reason });
    this.emit("session_closed", { reason });
  }

  /** A session that cannot be opened (or kept safe) is closed with the reason, never left half-open. */
  private async refuse(e: unknown): Promise<void> {
    const r = e instanceof SessionRefusal ? e : mapAdapterError(e);
    this.env.log.warn("session refused", { session: this.id, reason: r.reason, message: r.message });
    this.audit("session_refused", { reason: r.reason, message: r.message.slice(0, 300) });
    await this.close(r.reason);
  }

  rejectCommand(type: string, cmdId: string | null, reason: string): void {
    this.audit("command_rejected", { type, cmd_id: cmdId, reason });
    this.emit("command_rejected", { type, cmd_id: cmdId, reason });
  }
}

function mapAdapterError(e: unknown): SessionRefusal {
  const message = errMessage(e);
  if (/authentication required|auth_required|not logged in|login required/i.test(message) || (isObject(e) && (e as { code?: unknown }).code === -32000)) {
    return new SessionRefusal("agent_auth_required", message);
  }
  return new SessionRefusal("adapter_error", message);
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/** Cut every long string in an event (tool output, a diff) to `max` bytes, saying how much was cut. */
export function limitStrings<T>(value: T, max: number): T {
  if (typeof value === "string") return truncateBytes(value, max).text as T;
  if (Array.isArray(value)) return value.map((v) => limitStrings(v, max)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = limitStrings(v, max);
    return out as T;
  }
  return value;
}
