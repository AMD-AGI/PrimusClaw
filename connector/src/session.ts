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
import { TranscriptTail, isIdleStatus, type AttachSupport, type TranscriptUpdate } from "./attach.js";
import type { Audit } from "./audit.js";
import { TerminalInput, actsAsCommand, cleanInput, tmuxRunner, type PaneRef, type Readiness } from "./terminal-input.js";
import { createHash } from "node:crypto";
import { AdapterProcess, AuthenticateFailed, isAuthRequiredError, type AcpParams, type AdapterHooks } from "./adapter.js";
import type { ChildRegistry } from "./children.js";
import type { AgentConfig, ConnectorConfig } from "./config.js";
import { claudeSessionMeta } from "./claude-mode.js";
import { hintFor, withHint } from "./hints.js";
import {
  PermissionBook, boundedInput, matchAutoAllow, normalizeOptions, type OfferedOption,
} from "./permissions.js";
import { redactDeep } from "./redact.js";
import type { SessionStore } from "./session-store.js";
import { errMessage, isObject, sleep, truncateBytes, verdictOf, type Logger, type MayRun } from "./util.js";

/** `after`: the event is written (and posted) only once that has settled, e.g. the record it depends on is on disk. */
export type Emit = (sessionId: string, type: string, data: Record<string, unknown>, after?: Promise<unknown>) => void;

export interface SessionTiming {
  /** A session with no activity for this long loses its adapter process (the session itself stays and resumes on demand). */
  idleMs: number;
  /** A permission request nobody answers is answered `cancelled` after this long. */
  permissionTtlMs: number;
  /** How long to wait for an adapter to confirm a mode change by notification when it has no other way to be asked. */
  modeConfirmMs: number;
  /** An attach session reads the registry this often while its own agent is starting or running a turn, to see a terminal that opens the conversation meanwhile. */
  twinWatchMs: number;
  /** A read-only session (a conversation open in a terminal) reads its transcript for new lines this often. */
  spectateMs: number;
  /** ... and looks this often whether the terminal still has it open; once it has not, the read-only session ends. */
  spectateCheckMs: number;
  /** One look at a session's folder or root may take this long before it is `root_unavailable` (a stalled network mount). */
  rootCheckMs: number;
  /** How long a new session waits for an adapter that reports its sign-in to say which one it is. */
  authWaitMs: number;
  /** How long a takeover waits for the terminal it ended to exit (the transcript's quiet, `recentWriteMs`, is waited on top). */
  takeoverWaitMs: number;
  /**
   * A message for a terminal whose process cannot be told to hold the conversation still (its Claude Code says nothing of it), or
   * whose box holds someone's half-typed text, or whose screen is scrolled back, waits this long, then is refused
   * (`terminal_state_unknown`, `terminal_busy`). Whether that Claude Code is busy is never waited on, nor a question on its screen.
   */
  terminalWaitMs: number;
  /** A message typed into a terminal must show up in its transcript within this long, or its turn ends `terminal_input_unconfirmed`. */
  terminalEchoMs: number;
  /** A typed message's turn also ends once the terminal has said it is idle for this long (a turn stopped with Esc writes no end). */
  terminalIdleMs: number;
  /**
   * A terminal whose Claude Code says it is idle but whose screen is not its input box (a screen this connector cannot read:
   * another program, a layout it does not know) is read again for this long, then the message is refused (`terminal_screen_unknown`)
   * instead of waiting `terminalWaitMs`. A Claude Code that says it is working or waiting, or whose word cannot be read, keeps that wait.
   */
  terminalScreenWaitMs: number;
}

export const DEFAULT_SESSION_TIMING: SessionTiming = {
  idleMs: 30 * 60_000, permissionTtlMs: 10 * 60_000, modeConfirmMs: 3_000, twinWatchMs: 1_000, spectateMs: 1_000, spectateCheckMs: 5_000,
  rootCheckMs: 10_000, authWaitMs: 3_000, takeoverWaitMs: 15_000, terminalWaitMs: 10 * 60_000, terminalEchoMs: 20_000, terminalIdleMs: 5_000, terminalScreenWaitMs: 30_000,
};

/**
 * Why a command to a read-only session is refused: the conversation is open in a terminal, and a second writer would fork
 * its transcript. The session shows what the terminal does and takes no input.
 */
export const READ_ONLY_REASON = "read_only_live_session";
/** Why a mode change or a decision for a conversation that is typed into in its terminal is refused: the terminal owns those. */
export const TERMINAL_OWNS_REASON = "terminal_session";
/** What a terminal that typed messages wait for is doing, as the queue notice says it. */
const WAIT_WHY: Record<Exclude<Readiness, { ready: true }>["why"] | "other" | "unknown", string> = {
  typing: "terminal_typing", screen: "terminal_screen", copy_mode: "terminal_scrolled", gone: "terminal_gone", dialog: "terminal_dialog", other: "terminal_switched",
  unknown: "terminal_state_unknown",
};

export interface SessionEnv {
  config: ConnectorConfig;
  audit: Audit;
  registry: ChildRegistry;
  emit: Emit;
  store: SessionStore;
  /** The takeover support of each attach agent, by agent id. */
  attach: ReadonlyMap<string, AttachSupport>;
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

/** Why Claude Code leaves `bypassPermissions` out of its modes, for the log line of a refused session (claude-mode.ts). */
const BYPASS_HINT = ` (Claude Code offers it to root only with IS_SANDBOX set, and never when permissions.disableBypassPermissionsMode is "disable"; "claw-connector doctor" names the fix)`;

const MAX_TOOL_OUTPUT_BYTES = 8 * 1024;
const MAX_QUEUED_PROMPTS = 5;
/** How long a prompt waits for an entry the agent is still writing to the transcript to be complete: 8 × 250 ms. */
const PARTIAL_ENTRY_TRIES = 8;
const PARTIAL_ENTRY_WAIT_MS = 250;
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
  /**
   * An attached session starts in the mode its transcript last had, which is often one that never asks, and the
   * adapter says so on stderr while it sets the session up. That warning describes the mode about to be replaced,
   * so it is set aside until the ask mode is locked and read back; one that comes later closes the session as ever.
   */
  private inheritedWarningOk = false;
  /** The transcript's size when this connector last left it (see {@link preflight}). */
  private transcriptMark: number | null = null;
  /**
   * The program (`entrypoint`) the transcript names for what this connector's own agent wrote in its last turn, so that
   * what the same agent writes on its own between turns is told from a terminal's (see {@link preflight}). Null until
   * the agent has taken a turn, and again when it is discarded.
   */
  private ownWriter: string | null = null;
  /** The background tasks the agent started (their ids), so that only their notifications count as its own. */
  private ownTasks = new Set<string>();
  /**
   * Another process was seen holding the conversation open while this connector's own agent was running a turn on
   * it. That agent's memory then lacks whatever the process wrote, and the transcript's size cannot say so (see
   * {@link watchTwins}): the agent is discarded before the next prompt. Cleared when an agent is started afresh.
   */
  private twinSeen = false;
  private turnRunning = false;
  /**
   * The connector is going away (stopped, or restarted by its supervisor) and will come back. What this process cannot
   * finish is left recorded for the next run instead of being ended here: the running turn (no `turn_end`), its waiting
   * permission requests (still pending), and the prompts queued behind it (not counted as handled, so Claw delivers them
   * again). See {@link SessionManager.recover}.
   */
  private stopping = false;
  private queue: Array<{ text: string; cmdId: string | null; cmdSeq: number | null; started: () => void; mayRun?: MayRun }> = [];
  private launching: Promise<void> | null = null;
  private idle: NodeJS.Timeout | undefined;
  /**
   * The conversation is open in a terminal: this session only reads its transcript and shows it (see {@link spectate}).
   * No adapter is ever started for it, and every command that would write is refused.
   */
  readOnly = false;
  /**
   * Set when the terminal that has the conversation open is a tmux pane of this user's: then a message sent to the session is
   * typed into that terminal (terminal-input.ts) and the reply is read from the transcript as for a watch. The session is
   * still {@link readOnly} here (no agent is started, nothing else writes), but not to Claw: it takes prompts.
   */
  private terminal: TerminalInput | null = null;
  private terminalQueue: Array<{ text: string; cmdId: string | null; cmdSeq: number | null; started: () => void; mayRun?: MayRun }> = [];
  private terminalTurn: {
    cmdId: string | null; cmdSeq: number | null; text: string; sentAt: number; seen: boolean; idleSince: number | null; done: () => void;
    /** Claude Code queued it (it was submitted while a turn ran): it is taken in at that turn's next step, or once the turn ends. */
    queued?: boolean;
    /** The keys are being typed, Enter not yet gone (a question on the screen may hold it): the echo is not waited for yet. */
    typing?: boolean;
    /** Its text went into the box: only from then on can the transcript show it (the same words before are someone else's). */
    pasted?: boolean;
    /**
     * It started a turn of its own in the terminal (its prompt is the turn's, submitted at an idle prompt). Only such a turn is the
     * phone's to stop with Esc; one that went through Claude Code's queue (taken into a running turn, or out of the queue after it)
     * is not told apart from the person's for certain, and is left alone.
     */
    own?: boolean;
    /** The keys are going (or went) to the terminal: from here on it is the terminal's turn, which a withdraw leaves alone. */
    keys?: boolean;
    /** Counts its prompt as handled (idempotent): a withdraw that takes the turn back before its keys go calls it itself. */
    started?: () => void;
  } | null = null;
  private terminalPumping = false;
  /** Whether this session recorded once that its terminal's Claude Code version is not one measured for `busy` (it waits as before). */
  private terminalRestoring: Promise<void> | null = null;
  private tail: TranscriptTail | null = null;
  private tailTimer: NodeJS.Timeout | undefined;
  private lastTerminalCheck = 0;
  private checkingTerminal = false;
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

  private emit(type: string, data: Record<string, unknown>, after?: Promise<unknown>): void {
    this.env.emit(this.id, type, data, after);
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
  get busy(): boolean { return this.turnRunning || this.queue.length > 0 || this.book.size > 0 || this.terminalTurn !== null || this.terminalQueue.length > 0; }

  /** Whether what is sent to this session is typed into the terminal that has it open. */
  get typesIntoTerminal(): boolean { return this.terminal !== null; }

  /** Whether `mode` may be selected from a phone. */
  modeAllowed(mode: string): boolean {
    return this.agent.safeModes.includes(mode) || (this.agent.allowUnsafeModes && (this.modes.length === 0 || this.modes.some((m) => m.id === mode)));
  }

  /** Whether this session runs without asking before every write and command: its mode is not a safe one, or its adapter said it will not ask. */
  get unattended(): boolean {
    return this.noAskWarning || (this.currentMode !== null && !this.agent.askingModes.includes(this.currentMode));
  }

  private shownModes(): Array<ModeInfo & { unattended: boolean }> {
    return this.modes.filter((m) => this.modeAllowed(m.id)).map((m) => ({ ...m, unattended: !this.agent.askingModes.includes(m.id), ...(this.agent.readOnlyModes.includes(m.id) ? { read_only: true } : {}) }));
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
    // `unused`: a new conversation of this connector's own making that no message has reached yet (see neverPrompted).
    this.env.store.put(this.id, { agent_id: this.agent.id, acp_session_id: this.acpId, cwd: this.cwd, status: "active", mode: this.currentMode, created_at: new Date().toISOString(), unused: true });
    this.audit("session_started", { cwd: this.cwd, mode: this.currentMode, unattended: this.unattended, acp_session_id: this.acpId });
    this.emit("session_started", { acp_session_id: this.acpId, agent_id: this.agent.id, kind: this.agent.kind, cwd: this.cwd, modes: this.shownModes(), currentMode: this.currentMode, unattended: this.unattended }, this.env.store.written());
    this.announced = true;
    this.touch();
  }

  /**
   * `session.new` that names a session which already exists: resume it in the ask mode. The twin check runs inside
   * the launch (so it also runs again whenever a recycled adapter comes back), and a refusal closes the session.
   */
  async attach(requestedMode: string | null, title: string, takeover = false): Promise<void> {
    if (requestedMode && !this.agent.safeModes.includes(requestedMode) && !this.agent.allowUnsafeModes) {
      return this.refuse(new SessionRefusal("mode_not_allowed", `mode ${requestedMode} needs approval = "never" for this agent (or allow_unsafe_modes) on this machine`));
    }
    // A conversation a terminal has open now is not taken over: it is watched, read-only, for as long as the terminal has
    // it. Unless the person confirmed a takeover: then the terminal's process is ended first (`AttachSupport.endHolders`).
    const support = this.env.attach.get(this.agent.id);
    let tookOver = false;
    if (support && this.acpId) {
      const verdict = await support.check(this.acpId, { transcript: false });
      if (!verdict.ok && verdict.reason === "session_live") {
        if (!takeover) return this.spectate(support, title, verdict.detail, await support.terminalPane(this.acpId));
        const ended = await support.endHolders(this.acpId, { waitMs: this.env.timing.takeoverWaitMs });
        if (!ended.ok) {
          this.audit("takeover_refused", { reason: ended.reason, detail: ended.detail.slice(0, 300) });
          return this.refuse(new SessionRefusal(ended.reason, ended.detail));
        }
        this.audit("terminal_ended", { acp_session_id: this.acpId, pids: ended.ended, detail: verdict.detail.slice(0, 300) });
        tookOver = true;
      }
    }
    if (requestedMode) this.targetMode = requestedMode;
    try {
      await this.launch("resume");
    } catch (e) {
      return this.refuse(e);
    }
    if (this.closed) return;
    this.env.store.put(this.id, { agent_id: this.agent.id, acp_session_id: this.acpId, cwd: this.cwd, status: "active", mode: this.currentMode, created_at: new Date().toISOString() });
    this.audit("session_attached", { cwd: this.cwd, mode: this.currentMode, unattended: this.unattended, acp_session_id: this.acpId });
    this.emit("session_started", { acp_session_id: this.acpId, agent_id: this.agent.id, kind: this.agent.kind, cwd: this.cwd, title, attached: true, ...(tookOver ? { took_over: true } : {}), modes: this.shownModes(), currentMode: this.currentMode, unattended: this.unattended }, this.env.store.written());
    this.touch();
  }

  // --- read-only: a conversation open in a terminal ------------------------------------

  /**
   * Show a conversation that a terminal has open without taking it over. Nothing is started: the transcript the terminal
   * writes is read from its end (`TranscriptTail`, read-only) and each new line goes out as the update an adapter would
   * have sent, scrubbed like every other event, marked `read_only`. What was there just before is sent first, marked
   * `replay`. Prompts, mode changes and decisions are refused (`read_only_live_session`) and never reach anything that
   * could write to the transcript. When the terminal no longer has the conversation open the session ends
   * (`terminal_closed`): taking it over then is a new session, through the full check.
   */
  private async spectate(support: AttachSupport, title: string, detail: string, pane: { ok: true; pane: PaneRef } | { ok: false; why: string }): Promise<void> {
    this.readOnly = true;
    if (pane.ok) this.terminal = new TerminalInput(pane.pane, tmuxRunner(this.agent.attach?.tmux ?? "tmux", pane.pane.socket));
    // The terminal's permission mode now, as its footer names it (null when the screen does not say): the chat tells the person
    // when a message from the phone will run without asking (`MODES_THAT_DO_NOT_ASK`).
    let terminalMode: string | null = null;
    if (this.terminal) { try { const r = await this.terminal.readiness(); terminalMode = r.ready ? r.mode : null; } catch { /* unread */ } }
    if (this.closed) return;
    this.tail = new TranscriptTail(() => (this.acpId ? support.transcriptPath(this.acpId) : null));
    const backlog = this.tail.backlog();
    this.env.store.put(this.id, {
      agent_id: this.agent.id, acp_session_id: this.acpId, cwd: this.cwd, status: "active", mode: null, read_only: true,
      ...(pane.ok ? { terminal_input: true } : {}), created_at: new Date().toISOString(),
    });
    if (pane.ok) {
      this.audit("session_terminal_input", { cwd: this.cwd, acp_session_id: this.acpId, pid: pane.pane.pid, pane: pane.pane.pane, terminal_mode: terminalMode, detail: detail.slice(0, 300) });
      // Not read-only: what is sent is typed into the terminal. The terminal keeps its own mode; it is not the phone's to set.
      this.emit("session_started", {
        acp_session_id: this.acpId, agent_id: this.agent.id, kind: this.agent.kind, cwd: this.cwd, title, attached: true,
        live_terminal: true, input: "terminal", modes: [], currentMode: null, terminal_mode: terminalMode,
      });
    } else {
      this.audit("session_spectating", { cwd: this.cwd, acp_session_id: this.acpId, detail: detail.slice(0, 300), why_not_typed: pane.why.slice(0, 300) });
      this.emit("session_started", {
        acp_session_id: this.acpId, agent_id: this.agent.id, kind: this.agent.kind, cwd: this.cwd, title, attached: true,
        read_only: true, read_only_reason: "session_live", read_only_why: pane.why.slice(0, 200), modes: [], currentMode: null, unattended: false,
      });
    }
    this.announced = true;
    for (const u of backlog) this.emitTranscript(u, true);
    this.followTail(support);
  }

  /** After a restart: a session that was read-only is again, from the transcript's end (what was sent before is not sent twice). */
  restoreSpectate(typed = false): void {
    this.readOnly = true;
    const support = this.env.attach.get(this.agent.id);
    if (!support) return;
    // One that typed into its terminal does again, once the pane is proven again; until then (or if it cannot be) a message is refused.
    if (typed && this.acpId) {
      this.terminalRestoring = support.terminalPane(this.acpId).then((pane) => {
        if (pane.ok && !this.closed) this.terminal = new TerminalInput(pane.pane, tmuxRunner(this.agent.attach?.tmux ?? "tmux", pane.pane.socket));
        else if (!pane.ok) this.audit("terminal_input_lost", { why: pane.why.slice(0, 300) });
      }).finally(() => { this.terminalRestoring = null; });
    }
    this.tail = new TranscriptTail(() => (this.acpId ? support.transcriptPath(this.acpId) : null));
    this.tail.fromEnd();
    this.followTail(support);
  }

  private followTail(support: AttachSupport): void {
    this.lastTerminalCheck = Date.now();
    const tick = () => {
      if (this.closed || !this.tail) return;
      for (const u of this.tail.poll()) this.emitTranscript(u, false);
      this.watchTerminalTurn(support);
      if (!this.checkingTerminal && Date.now() - this.lastTerminalCheck >= this.env.timing.spectateCheckMs) void this.checkTerminal(support);
    };
    this.tailTimer = setInterval(tick, this.env.timing.spectateMs);
    this.tailTimer.unref?.();
  }

  /** Is the conversation still open somewhere else? The cheap look first; only a look that finds nothing asks every source. */
  private async checkTerminal(support: AttachSupport): Promise<void> {
    if (!this.acpId) return;
    this.checkingTerminal = true;
    try {
      this.lastTerminalCheck = Date.now();
      if (support.peek(this.acpId, null)?.twin) return;
      const verdict = await support.check(this.acpId, { transcript: false });
      // Only a clear "nobody has it" ends the watch: a check that could not be made is not one.
      if (verdict.ok && !this.closed) {
        for (const u of this.tail?.poll() ?? []) this.emitTranscript(u, false);
        await this.close("terminal_closed");
      }
    } finally {
      this.checkingTerminal = false;
    }
  }

  private emitTranscript(u: TranscriptUpdate, replay: boolean): void {
    const turn = replay ? null : this.terminalTurn;
    if (u.type === "turn_done") {
      if (turn?.seen) this.endTerminalTurn("end_turn");
      return;
    }
    // What Claude Code did with a message submitted while a turn ran: queued it (taken: the echo), took it into that turn (its start
    // here), or handed the queue back to the terminal's box (withdrawn there). Never sent on: the phone sees the turn's own lines.
    if (u.type === "queued" || u.type === "queued_taken" || u.type === "queue_withdrawn") {
      if (!turn || turn.seen || !turn.pasted) return;
      const said = String(u.update.text ?? "");
      if (u.type === "queued" && sameText(said, turn.text)) turn.queued = true;
      else if (u.type === "queued_taken" && sameText(said, turn.text)) turn.seen = true;
      else if (u.type === "queue_withdrawn" && turn.queued) this.endTerminalTurn("error", "terminal_input_withdrawn");
      return;
    }
    if (u.type === "user_message_chunk" && turn) {
      const said = String((u.update.content as { text?: unknown } | undefined)?.text ?? "");
      // The message typed for the phone comes back as the terminal's own prompt: it is that turn's start, not news.
      // (its own turn only when it was submitted straight, not through Claude Code's queue: there an identical prompt the person
      // queued before it could be the one that came out first, and its turn is the person's)
      if (turn.pasted && !turn.seen && sameText(said, turn.text)) { turn.seen = true; turn.own = !turn.queued; return; }
      // (several queued prompts can come out of Claude Code's queue as one: a queued message is in it, never its own turn)
      if (turn.pasted && !turn.seen && turn.queued && said.replace(/\s+/g, " ").includes(turn.text.replace(/\s+/g, " ").trim())) { turn.seen = true; return; }
      if (turn.seen && /^\[Request interrupted by user/.test(said.trim())) { this.endTerminalTurn("cancelled"); }
    }
    const text = u.type === "agent_message_chunk" ? String((u.update.content as { text?: unknown } | undefined)?.text ?? "") : "";
    if (text && this.env.config.dropMessagePatterns.some((re) => re.test(text))) return;
    const data = limitStrings(redactDeep({ sessionId: this.acpId, update: u.update }) as Record<string, unknown>, MAX_TOOL_OUTPUT_BYTES);
    this.emit(u.type, { ...data, ...(this.terminal ? {} : { read_only: true }), ...(replay ? { replay: true } : {}) });
  }

  // --- typing into the terminal ------------------------------------------------------------

  /**
   * A message for a conversation open in a tmux pane: typed into the terminal at once, one at a time, whatever Claude Code is doing
   * there (a running turn queues it, as one the person at the terminal types). It waits only while it could not be typed safely: the
   * box holds someone's half-typed text, the screen is scrolled back, or a question or a menu is on it (an Enter there would answer
   * it). While it waits the phone is told once why (`terminal_input_queued`).
   */
  private enqueueTerminal(text: string, cmdId: string | null, cmdSeq: number | null, started: () => void, mayRun?: MayRun): void {
    if (this.terminalQueue.length >= MAX_QUEUED_PROMPTS) { this.rejectCommand("prompt", cmdId, "too_many_queued_prompts", cmdSeq); return started(); }
    this.terminalQueue.push({ text, cmdId, cmdSeq, started, mayRun });
    void this.pumpTerminal();
  }

  private async pumpTerminal(): Promise<void> {
    if (this.terminalPumping) return;
    this.terminalPumping = true;
    try {
      while (this.terminalQueue.length && !this.closed) {
        const next = this.terminalQueue[0]!;
        const refused = (reason: string, detail = "", extra: Record<string, unknown> = {}) => {
          this.terminalQueue.shift();
          next.started();
          this.audit("terminal_input_refused", { reason, detail: detail.slice(0, 300), cmd_id: next.cmdId, ...extra });
          this.rejectCommand("prompt", next.cmdId, reason, next.cmdSeq, extra);
          this.emit("turn_end", { stopReason: "error", error: reason, cmd_id: next.cmdId, cmd_seq: next.cmdSeq, ...extra });
        };
        const text = cleanInput(next.text);
        if (!text.trim()) { refused("empty_prompt"); continue; }
        // `!` or `/` first would run a shell command or a slash command there, not ask the agent: never typed.
        if (actsAsCommand(text)) { refused("terminal_command_refused"); continue; }
        if (this.terminalRestoring) await this.terminalRestoring;
        const term = this.terminal;
        if (!term) { refused("terminal_input_unavailable"); continue; }
        let told = "";
        let ready = false;
        // Typed in any permission mode (the terminal's owner chose it); the mode is recorded with what was typed.
        // Since when the screen has been one this connector cannot read (no input box, and no question it knows), and since when
        // Claude Code has said nothing of the process (it cannot be told that the process still holds this conversation).
        let unreadableSince: number | null = null;
        let heldSince: number | null = null;
        let refusal: string | null = null;
        while (!this.closed && this.terminalQueue[0] === next) {
          // Not whether Claude Code is busy (a running turn queues what is typed): only that the process is still the one on this
          // conversation, and that its screen can take the keys without anything on it answering to them.
          const status = this.holderStatus(term);
          let why: string;
          if (status === "other") { told = WAIT_WHY.other; break; }   // (the terminal is on another conversation now, or gone)
          if (status === null) {
            why = WAIT_WHY.unknown;
          } else {
            // (`unread`: Claude Code's row for that process cannot be read, but the process is proven to hold this conversation)
            const r = await term.readiness();
            if (r.ready) { ready = true; break; }
            why = WAIT_WHY[r.why];
            if (r.why === "gone") { told = why; break; }
          }
          // A typed-in, scrolled-back or questioning terminal is waited for (the phone is told it is queued); one that cannot be read
          // is not, nor one whose process cannot be told to be this conversation's.
          if (why === WAIT_WHY.screen) {
            unreadableSince ??= Date.now();
            if (Date.now() - unreadableSince >= this.env.timing.terminalScreenWaitMs) { refusal = "terminal_screen_unknown"; told = why; break; }
          } else {
            unreadableSince = null;
          }
          // (someone's half-typed text in the box, or a screen scrolled back, held for as long as terminalWaitMs: refused then, as
          // before; a question on the screen is waited out however long it is up)
          if (why === WAIT_WHY.unknown || why === WAIT_WHY.typing || why === WAIT_WHY.copy_mode) {
            heldSince ??= Date.now();
            if (Date.now() - heldSince >= this.env.timing.terminalWaitMs) { refusal = why === WAIT_WHY.unknown ? "terminal_state_unknown" : "terminal_busy"; told = why; break; }
          } else {
            heldSince = null;
          }
          if (why !== told) {
            told = why;
            this.emit("terminal_input_queued", { reason: why, cmd_id: next.cmdId, cmd_seq: next.cmdSeq, queued: this.terminalQueue.length });
          }
          await sleep(Math.max(200, Math.min(1_000, this.env.timing.spectateMs * 5)));
        }
        if (this.closed || this.terminalQueue[0] !== next) continue;   // closed, or dropped by a cancel
        if (refusal) { refused(refusal, told); continue; }
        if (!ready) { refused(told === WAIT_WHY.gone ? "terminal_gone" : "terminal_switched", told); continue; }
        // Still live (connector.ts `gateFor`: Claw is asked if the connector stalled since the message came): if not, it was
        // reported as refused already and is only dropped here.
        const verdict = next.mayRun ? await verdictOf(next.mayRun) : "run";
        // Stopping: left unhandled, as `shutdown` leaves the queue, so Claw delivers it again to the next run.
        if (verdict === "keep") break;
        if (verdict === "drop") {
          if (this.terminalQueue[0] === next) this.terminalQueue.shift();
          next.started();
          continue;
        }
        if (this.closed || this.terminalQueue[0] !== next) continue;
        // Asked again just before the keys go: the same process, still on this conversation, still idle.
        if (!this.sameHolder(term)) { refused("terminal_switched", "the terminal changed just before typing"); continue; }
        this.terminalQueue.shift();
        const finished = new Promise<void>((resolve) => {
          this.terminalTurn = { cmdId: next.cmdId, cmdSeq: next.cmdSeq, text, sentAt: Date.now(), seen: false, idleSince: null, done: resolve, started: next.started };
        });
        // At most once: the turn is recorded and the prompt counted as handled BEFORE the keys go, so a restart in between
        // ends this turn (`connector_restarted`, SessionManager.recover) instead of Claw delivering it again and the terminal
        // getting it twice. A person's terminal gets a message once or not at all.
        const startedAt = new Date().toISOString();
        this.env.store.beginTurn({ session_id: this.id, cmd_id: next.cmdId, cmd_seq: next.cmdSeq, started_at: startedAt });
        this.env.store.patch(this.id, { used_at: startedAt });
        const recorded = await this.env.store.flushed(2_000);
        next.started();
        const turn = this.terminalTurn;
        // Everything asked again after that wait, right before the keys go: a cancel or a close meanwhile, a record that did not
        // reach the disk (a restart could not end this turn), and the terminal itself (someone may have started typing, a menu may
        // be open now). Each ends the turn by name and types nothing.
        const giveUp = (reason: string | null, extra: Record<string, unknown> = {}) => {
          const mine = this.terminalTurn === turn;
          if (mine) this.terminalTurn = null;
          // (Going away: the record stays, and the next run ends this turn by name.)
          if (!this.stopping) this.env.store.endTurn(this.id);
          // (A turn taken from here meanwhile, by a withdraw or a cancel, was already answered for by name: not a second time.)
          if (reason === null || !mine) return;
          this.audit("terminal_input_refused", { reason, cmd_id: next.cmdId, ...extra });
          this.rejectCommand("prompt", next.cmdId, reason, next.cmdSeq, extra);
          this.emit("turn_end", { stopReason: "error", error: reason, cmd_id: next.cmdId, cmd_seq: next.cmdSeq, ...extra });
        };
        if (this.closed || this.stopping || !turn || this.terminalTurn !== turn) { giveUp(null); continue; }
        if (!recorded) { giveUp("terminal_input_failed"); continue; }
        // One whose row cannot be read is proven again here, after every wait above: a `/clear` or `/resume` there meanwhile leaves
        // the old task folder open while the new conversation's empty box shows, so a proof that is not fresh is no proof (codex r1).
        if (this.holderStatus(term) === "unread" && !(await this.env.attach.get(this.agent.id)?.refreshBlind())) {
          giveUp("terminal_busy");
          continue;
        }
        // (the screen read again after that wait: someone typing, a question or a scroll meanwhile is waited out as above, not typed over)
        let again = await term.readiness();
        const screenBy = Date.now() + this.env.timing.terminalScreenWaitMs;
        while (!again.ready && again.why !== "gone" && !this.closed && this.terminalTurn === turn && this.sameHolder(term)) {
          if (again.why === "screen" && Date.now() >= screenBy) break;
          await sleep(200);
          again = await term.readiness();
        }
        if (!again.ready && again.why === "gone") { giveUp("terminal_gone"); continue; }
        if (!this.sameHolder(term)) { giveUp("terminal_switched"); continue; }
        if (!again.ready && this.terminalTurn === turn && !this.closed) { giveUp("terminal_screen_unknown"); continue; }
        if (this.closed || this.terminalTurn !== turn) { giveUp(null); continue; }   // (closed, cancelled or withdrawn meanwhile)
        turn.keys = true;
        turn.typing = true;
        try {
          // (a question that shows after the text went in holds the Enter until it is gone; the phone is told why it waits)
          await term.type(text, {
            onDialog: () => this.emit("terminal_input_queued", { reason: WAIT_WHY.dialog, cmd_id: next.cmdId, cmd_seq: next.cmdSeq, queued: this.terminalQueue.length + 1 }),
            stillWanted: () => !this.closed && !this.stopping && this.terminalTurn === turn && this.sameHolder(term),
            submitted: () => turn.seen || turn.queued === true,
            onPaste: () => { turn.pasted = true; },
          });
          turn.typing = false;
          turn.sentAt = Date.now();
        } catch (e) {
          // (taken from here meanwhile, by a cancel or a withdraw, and answered for there: not a second time)
          if (this.terminalTurn !== turn) continue;
          this.terminalTurn = null;
          this.env.store.endTurn(this.id);
          // (`TerminalNotSubmitted`: typed, but the screen did not let Enter go; no key was sent after the text, which stays in the box)
          this.audit("terminal_input_refused", { reason: "terminal_input_failed", detail: errMessage(e).slice(0, 300), cmd_id: next.cmdId });
          this.rejectCommand("prompt", next.cmdId, "terminal_input_failed", next.cmdSeq);
          this.emit("turn_end", { stopReason: "error", error: "terminal_input_failed", cmd_id: next.cmdId, cmd_seq: next.cmdSeq });
          continue;
        }
        // What was typed is the person's own message; the trail keeps its size and a digest, not the words.
        this.audit("terminal_input", {
          acp_session_id: this.acpId, pid: term.ref.pid, pane: term.ref.pane, cmd_id: next.cmdId, terminal_mode: again.ready ? again.mode : null, length: text.length,
          lines: text.split("\n").length, sha256: createHash("sha256").update(text).digest("hex").slice(0, 16),
        });
        await finished;
      }
    } finally {
      this.terminalPumping = false;
    }
  }

  /**
   * Whether the terminal's process is still the one proven to hold this conversation (whatever it is doing there): Claude Code's row
   * names it, or it is proven so without one (`unread`).
   */
  private sameHolder(term: TerminalInput): boolean {
    const status = this.holderStatus(term);
    return status !== null && status !== "other";
  }

  /** What Claude Code says the terminal's process is doing with this conversation (see `AttachSupport.holderStatus`). */
  private holderStatus(term: TerminalInput): string | null {
    return this.env.attach.get(this.agent.id)?.holderStatus(term.ref.pid, this.acpId ?? "", term.ref.procStart) ?? null;
  }

  /** The typed message's turn, from the tick: it must show up in the transcript, and it ends when the terminal says it is idle again. */
  private watchTerminalTurn(support: AttachSupport): void {
    const turn = this.terminalTurn;
    if (!turn || !this.terminal) return;
    const now = Date.now();
    if (!turn.seen) {
      // (the terminal went on to another conversation, or its process is gone: nothing there will take it in now)
      if (!turn.typing && support.holderStatus(this.terminal.ref.pid, this.acpId ?? "", this.terminal.ref.procStart) === "other") {
        this.endTerminalTurn("error", "terminal_switched");
        return;
      }
      // (queued by Claude Code: it waits for the running turn, however long; still being typed: not sent yet)
      if (!turn.queued && !turn.typing && now - turn.sentAt >= this.env.timing.terminalEchoMs) this.endTerminalTurn("error", "terminal_input_unconfirmed");
      return;
    }
    const status = support.holderStatus(this.terminal.ref.pid, this.acpId ?? "", this.terminal.ref.procStart);
    if (status === "other") { this.endTerminalTurn("end_turn"); return; }
    // (`unread`: nothing says it is idle; the transcript's own end of the turn, `turn_done`, ends it)
    if (isIdleStatus(status)) {
      turn.idleSince ??= now;
      if (now - turn.idleSince >= this.env.timing.terminalIdleMs) this.endTerminalTurn("end_turn");
    } else {
      turn.idleSince = null;
    }
  }

  private endTerminalTurn(stopReason: string, error?: string): void {
    const turn = this.terminalTurn;
    if (!turn) return;
    this.terminalTurn = null;
    // (Not when the connector is going away: the record is left for the next run, which ends the turn by name.)
    if (!this.stopping) this.env.store.endTurn(this.id);
    this.audit("terminal_turn_end", { stop_reason: stopReason, ...(error ? { error } : {}), cmd_id: turn.cmdId });
    this.emit("turn_end", { stopReason, ...(error ? { error } : {}), cmd_id: turn.cmdId, cmd_seq: turn.cmdSeq });
    turn.done();
  }

  /** The queued typed messages are dropped: each is refused by name (`cancelled`, or the reason given). */
  private dropTerminalQueue(reason: string): void {
    const q = this.terminalQueue;
    this.terminalQueue = [];
    for (const item of q) { item.started(); this.rejectCommand("prompt", item.cmdId, reason, item.cmdSeq); }
  }

  /** The process is stopping: the transcript is no longer followed (the session itself stays recorded, read-only). */
  stopTail(): void {
    clearInterval(this.tailTimer);
    this.tailTimer = undefined;
    this.tail = null;
  }

  /** Start (or restart) the adapter and bring the ACP session up in a verified mode. One at a time. */
  private launch(how: "new" | "resume"): Promise<void> {
    this.launching ??= this.guardedLaunch(how).finally(() => { this.launching = null; });
    return this.launching;
  }

  /** For an attach agent, nothing is started until no other process holds the session open. */
  private async guardedLaunch(how: "new" | "resume"): Promise<void> {
    if (!this.agent.attach) return this.doLaunch(how);
    const support = this.env.attach.get(this.agent.id);
    if (!support) throw new SessionRefusal("attach_unavailable", "this agent has no takeover support");
    if (!this.acpId) throw new SessionRefusal("adapter_cannot_resume", "no session to resume");
    const verdict = await support.check(this.acpId, { transcript: true });
    if (!verdict.ok) {
      this.audit("attach_refused", { reason: verdict.reason, detail: verdict.detail.slice(0, 300) });
      throw new SessionRefusal(verdict.reason, verdict.detail);
    }
    this.inheritedWarningOk = true;
    const watch = this.watchTwins(support, this.acpId);
    try {
      await this.doLaunch(how);
      // The mark is taken first: whatever is written after it, by a terminal that arrives while the look below is made, changes the size.
      this.markTranscript();
      // The check above is one moment, and the agent reads the transcript some seconds after it. A process that opened
      // the conversation since, even one that has already left, wrote what this agent has not read: not a session to keep.
      if (await watch.finish()) {
        await this.dropAdapter();
        const detail = "another process opened the conversation while it was being resumed";
        this.audit("attach_refused", { reason: "session_live", detail });
        throw new SessionRefusal("session_live", detail);
      }
      this.twinSeen = false;
    } finally {
      watch.stop();
      this.inheritedWarningOk = false;
    }
  }

  /**
   * Watch for a second writer while this connector's own agent is working on the conversation (starting, or running a
   * turn). The check before a prompt is a look at one moment, and the transcript's size cannot stand in for it during
   * the work: the agent's own writes and a terminal's are the same kind of bytes, so a terminal that opens the
   * conversation, takes a turn and exits meanwhile would be gone by the next look and its bytes already counted as
   * the agent's. So the registry is read every `twinWatchMs` for as long as the work lasts (a process that has held the
   * conversation open for longer than that is seen), and once more, in full (the command too), when it ends.
   * `finish()` answers whether another process was seen holding the conversation open at any of those moments, or the
   * last look could not be made.
   */
  private watchTwins(support: AttachSupport, ref: string): { finish(): Promise<boolean>; stop(): void } {
    let seen = false;
    const own = () => (this.adapter && !this.adapter.exited ? this.adapter.pid : null);
    const look = () => {
      if (seen) return;
      const r = support.peek(ref, own());
      if (r?.twin) { seen = true; this.audit("twin_seen", { pid: r.twin.pid, foreign: r.twin.foreign }); }
    };
    const timer = setInterval(look, this.env.timing.twinWatchMs);
    timer.unref?.();
    const stop = () => clearInterval(timer);
    return {
      stop,
      finish: async () => {
        stop();
        look();
        if (!seen) {
          const v = await support.check(ref, { ownPgid: own(), transcript: false });
          if (!v.ok) { seen = true; this.audit("twin_seen", { reason: v.reason, detail: v.detail.slice(0, 300) }); }
        }
        return seen;
      },
    };
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
        const res = await this.signedIn(adapter, () => adapter.request("session/new", { cwd: this.cwd, mcpServers: [], ...claudeSessionMeta(this.agent) }));
        if (typeof res.sessionId !== "string") throw new SessionRefusal("adapter_protocol", "session/new returned no session id");
        this.acpId = res.sessionId;
        this.absorb(res);
        await this.refuseSignedOut(adapter);
      } else {
        if (!this.acpId) throw new SessionRefusal("adapter_cannot_resume", "no adapter session to resume");
        const caps = adapter.caps.sessionCapabilities as AcpParams | undefined;
        try {
          if (caps?.resume) {
            // `resume` does not replay the history, and the adapter's own settings apply again: the mode is re-locked below.
            this.absorb(await this.signedIn(adapter, () => adapter.request("session/resume", { sessionId: this.acpId, cwd: this.cwd, mcpServers: [], ...claudeSessionMeta(this.agent) })));
          } else if (adapter.caps.loadSession) {
            this.replaying = true;
            try { this.absorb(await this.signedIn(adapter, () => adapter.requestUnbounded("session/load", { sessionId: this.acpId, cwd: this.cwd, mcpServers: [], ...claudeSessionMeta(this.agent) }))); } finally { this.replaying = false; }
          } else {
            throw new SessionRefusal("adapter_cannot_resume", "the adapter can neither resume nor load a session");
          }
        } catch (e) {
          if (!this.neverPrompted(e)) throw e;
          // Opened and never sent a message: the agent wrote nothing yet (Claude keeps a conversation only from its first
          // message), so there is nothing to resume and nothing to lose. A fresh one takes its place, in the same folder.
          const res = await this.signedIn(adapter, () => adapter.request("session/new", { cwd: this.cwd, mcpServers: [], ...claudeSessionMeta(this.agent) }));
          if (typeof res.sessionId !== "string") throw new SessionRefusal("adapter_protocol", "session/new returned no session id");
          this.audit("session_recreated", { was: this.acpId, now: res.sessionId, why: errMessage(e).slice(0, 200) });
          this.acpId = res.sessionId;
          this.absorb(res);
          this.env.store.patch(this.id, { acp_session_id: this.acpId });
        }
      }
      await this.enforceMode(this.targetMode);
      if (this.closed) throw new SessionRefusal("session_closed");
    } catch (e) {
      await this.dropAdapter();
      throw e instanceof SessionRefusal ? e : mapAdapterError(e);
    }
  }

  /**
   * `open` (a `session/new`), signing the adapter in first when it needs that and can do it by itself: an adapter that
   * answers "Authentication required" and offers an `api-key` method, while its environment holds a key it reads
   * (codex-acp: OPENAI_API_KEY or CODEX_API_KEY), is told to `authenticate` with it and asked once more. Without this a
   * Codex agent set up with only an API key never opened a session. The key itself is never sent: the adapter reads
   * its own environment. (codex-acp then keeps the key in its auth.json, as `codex login --with-api-key` does.)
   */
  private async signedIn(adapter: AdapterProcess, open: () => Promise<AcpParams>): Promise<AcpParams> {
    try {
      return await adapter.openSignedIn({ ...process.env, ...this.agent.env }, open, (method) => this.audit("agent_authenticate", { method }));
    } catch (e) {
      if (e instanceof AuthenticateFailed) throw new SessionRefusal("agent_auth_required", e.message);
      throw e;
    }
  }

  /**
   * An adapter that reports its sign-in (claude-agent-acp) and says there is none: the session would open, say it is
   * ready and fail at its first message with "Authentication required". A new session is refused now instead, with the
   * fix. A session that already exists (resumed after an idle recycle or a restart) is not: its prompts say why and it
   * stays, so it carries on once someone signs in on the machine.
   */
  private async refuseSignedOut(adapter: AdapterProcess): Promise<void> {
    const st = await adapter.waitAuthStatus(this.env.timing.authWaitMs);
    if (st?.kind === "none") throw new SessionRefusal("agent_auth_required", `the agent reports that it is not signed in${st.label ? ` (${st.label})` : ""}`);
  }

  /**
   * The adapter cannot find the conversation to resume, and this session's record says it was started new by this
   * connector and never had a message (`unused`). Any other failure, a used or taken-over session, or a record that does
   * not say (written by an older version), keeps its error.
   */
  private neverPrompted(e: unknown): boolean {
    if (this.agent.attach || e instanceof SessionRefusal) return false;
    // Only a record that says so: one written before this was kept, or a takeover, may well have had messages.
    const rec = this.env.store.get(this.id);
    if (rec?.unused !== true || rec.used_at) return false;
    return /not found|no (?:such )?(?:session|conversation)/i.test(errMessage(e));
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
    if (this.modes.length && !this.modes.some((m) => m.id === mode)) throw new SessionRefusal("mode_unavailable", `the adapter offers no mode ${mode}${mode === "bypassPermissions" ? BYPASS_HINT : ""}`);
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
    // Not past the end of the session or of its adapter (refused meanwhile, or killed by a stop): nothing can confirm a
    // mode then, and a look that went on would end the opening, and the command, long after the run that took it.
    while (Date.now() < deadline && !this.closed && this.adapter === a) {
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
    if (this.readOnly) return this.rejectCommand("set_mode", cmdId, this.terminal ? TERMINAL_OWNS_REASON : READ_ONLY_REASON);
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
    if (this.inheritedWarningOk) return this.audit("permission_callback_warning_inherited", { text: text.slice(0, 300) });
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
    // Going away: the next run closes these cards (by connector_restart) and knows the turn was waiting on them.
    if (!this.stopping) for (const actionId of cancelled) this.emit("permission_resolved", { actionId, optionId: null, outcome: "cancelled", by: "adapter_exit" });
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
    }, (optionId) => (optionId === null ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId } }), true);
  }

  /** Put a question on the phone and wait for the answer, a cancel or the timeout. `shape` turns the answer into what the adapter expects. */
  private askPerson(options: OfferedOption[], info: Record<string, unknown>, shape: (optionId: string | null) => AcpParams, permission = false): Promise<AcpParams> {
    return new Promise<AcpParams>((resolve) => {
      const p = this.book.open(options, (actionId) => redactDeep({ actionId, ...info, options, timeout_ms: this.book.ttl }) as Record<string, unknown>, (optionId) => {
        if (!this.stopping) {
          this.env.store.removePending(this.id, p.actionId);
          if (this.book.size === 0) this.env.store.markWaiting(this.id, false);
        }
        resolve(shape(optionId));
      });
      this.env.store.addPending(this.id, p.actionId);
      this.env.store.markWaiting(this.id, true, permission);
      this.audit("permission_requested", { action_id: p.actionId, tool: info.tool, tool_kind: info.kind, options: options.map((o) => o.optionId) });
      // Shown once the card is on record: a crash after that closes it on the next run (`takePending`).
      this.emit("permissionRequest", p.payload, this.env.store.written());
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
  enqueuePrompt(text: string, cmdId: string | null, started: () => void = () => {}, cmdSeq: number | null = null, mayRun?: MayRun): void {
    if (this.closed) { this.rejectCommand("prompt", cmdId, "session_closed", cmdSeq); return started(); }
    if (this.readOnly && (this.terminal || this.terminalRestoring)) return this.enqueueTerminal(text, cmdId, cmdSeq, started, mayRun);
    if (this.readOnly) {
      // Never queued, never sent: what the person typed does not reach the conversation the terminal is writing.
      this.audit("prompt_refused", { reason: READ_ONLY_REASON });
      this.rejectCommand("prompt", cmdId, READ_ONLY_REASON, cmdSeq);
      this.emit("turn_end", { stopReason: "error", error: READ_ONLY_REASON, read_only: true, cmd_id: cmdId, cmd_seq: cmdSeq });
      return started();
    }
    if (this.queue.length >= MAX_QUEUED_PROMPTS) { this.rejectCommand("prompt", cmdId, "too_many_queued_prompts", cmdSeq); return started(); }
    this.queue.push({ text, cmdId, cmdSeq, started, mayRun });
    if (!this.turnRunning) void this.pump();
  }

  /** Prompts that will now never run here: they count as handled, unless (`keep`) the connector is only restarting and the next run should get them again. */
  dropQueued(keep = false): void {
    const q = this.queue;
    this.queue = [];
    if (!keep) for (const item of q) item.started();
  }

  /** The connector is about to stop its adapters and will come back: see {@link stopping}. */
  shutdown(): void {
    this.stopping = true;
    this.dropQueued(true);
    // Not counted as handled: Claw delivers the messages that were waiting for the terminal again after the restart.
    this.terminalQueue = [];
  }

  private async pump(): Promise<void> {
    if (this.turnRunning) return;
    this.turnRunning = true;
    try {
      while (this.queue.length && !this.closed) {
        const next = this.queue.shift()!;
        // Still live as it reaches the agent (connector.ts `gateFor`): asked of Claw only if the connector stalled since the
        // prompt came. Refused, it was reported already and is only counted as handled here.
        const verdict = next.mayRun ? await verdictOf(next.mayRun) : "run";
        // Stopping: back at the front and not counted as handled (as `shutdown` keeps the queue), so the next run gets it again.
        if (verdict === "keep") { this.queue.unshift(next); break; }
        if (verdict === "drop") { next.started(); continue; }
        if (this.closed) { this.rejectCommand("prompt", next.cmdId, "session_closed", next.cmdSeq); next.started(); break; }
        await this.runTurn(next.text, next.started, next.cmdId, next.cmdSeq);
      }
    } finally {
      this.turnRunning = false;
      this.touch();
    }
  }

  /** Every `turn_end` of the turn names its prompt: `cmd_id`, and `cmd_seq` (a number, which no credential scrub ever masks). */
  private async runTurn(text: string, started: () => void, cmdId: string | null, cmdSeq: number | null): Promise<void> {
    if (this.agent.attach) {
      const refused = await this.preflight();
      if (refused) {
        started();
        this.audit("prompt_refused", { reason: refused.reason, detail: refused.detail.slice(0, 300) });
        this.rejectCommand("prompt", cmdId, refused.reason, cmdSeq);
        this.emit("turn_end", { stopReason: "error", error: refused.reason, cmd_id: cmdId, cmd_seq: cmdSeq });
        this.env.store.endTurn(this.id); // (a turn carried on after a restart that could not start again ends here)
        return;
      }
    }
    try {
      await this.ensureAdapter();
    } catch (e) {
      started();
      const reason = e instanceof SessionRefusal ? e.reason : "adapter_unavailable";
      const hint = hintFor(reason, this.agent);
      this.emit("turn_end", { stopReason: "error", error: reason, ...(hint ? { hint } : {}), cmd_id: cmdId, cmd_seq: cmdSeq });
      this.env.store.endTurn(this.id);
      // Not signed in (yet): the session stays, and the next message tries again once someone has signed in there.
      if (reason === "agent_auth_required") return;
      return this.refuse(e);
    }
    const a = this.adapter!;
    this.audit("turn_started", { length: text.length });
    const support = this.agent.attach && this.acpId ? this.env.attach.get(this.agent.id) : undefined;
    const turnFrom = support ? support.transcriptSize(this.acpId!) : null;
    const watch = support ? this.watchTwins(support, this.acpId!) : null;
    try {
      const reply = a.requestUnbounded("session/prompt", { sessionId: this.acpId, prompt: [{ type: "text", text }] });
      const now = new Date().toISOString();
      // Recorded before the prompt counts as handled: from here a restart finds this turn instead of losing it.
      this.env.store.beginTurn({ session_id: this.id, cmd_id: cmdId, cmd_seq: cmdSeq, started_at: now });
      this.env.store.patch(this.id, { used_at: now, unused: false });
      void this.handledOnceRecorded(started, now);
      const res = await reply;
      const usage = isObject(res.usage) ? res.usage : undefined;
      this.endTurn({ stopReason: typeof res.stopReason === "string" ? res.stopReason : "end_turn", ...(usage ? { usage } : {}), cmd_id: cmdId, cmd_seq: cmdSeq });
    } catch (e) {
      if (!this.stopping) this.audit("turn_failed", { error: errMessage(e) });
      const r = mapAdapterError(e);
      if (r.reason === "agent_auth_required") {
        // Signed out since the session opened (an expired login): say so with the fix, and start the agent afresh for
        // the next message, so a sign-in done on the machine meanwhile is picked up.
        this.endTurn({ stopReason: "error", error: r.reason, message: errMessage(e).slice(0, 300), hint: hintFor(r.reason, this.agent), cmd_id: cmdId, cmd_seq: cmdSeq });
        if (this.adapter === a) await this.dropAdapter();
      } else {
        this.endTurn({ stopReason: "error", error: errMessage(e).slice(0, 300), cmd_id: cmdId, cmd_seq: cmdSeq });
      }
    } finally {
      // At once, before the look at who holds the conversation open: the test below it for a terminal that writes
      // next is the size, and it must start from the turn's end, not from a moment later.
      this.markTranscript(turnFrom);
      if (watch) {
        if (this.closed) watch.stop();
        else if (await watch.finish()) this.twinSeen = true;
      }
    }
  }

  /**
   * The turn record is written off the event loop, so the prompt counts as handled (and the heartbeat's cursor passes
   * it) only once the record has landed. Either the next run finds the turn (and ends or carries it on), or it is sent
   * the prompt again; never neither, and never both:
   * - the record landed: handled;
   * - the turn ended (its record gone or replaced) or the session closed: handled, the record no longer matters;
   * - the connector stops before the record landed: the record is dropped and the prompt left unhandled, so the next
   *   run is sent it again instead of also finding this turn;
   * - otherwise (a stalled disk, a failed write) it asks again every second; a failed write is tried again each time.
   */
  private async handledOnceRecorded(started: () => void, startedAt: string): Promise<void> {
    for (;;) {
      if (await this.env.store.flushed(1_000)) return started();
      if (this.closed || this.env.store.turn(this.id)?.started_at !== startedAt) return started();
      if (this.stopping) { this.env.store.endTurn(this.id); return; }
      await sleep(1_000);
    }
  }

  /**
   * For an attach agent: may this prompt go to the agent now? Null when it may, else why not (the prompt is
   * rejected and the session stays, so it goes through once the cause is gone).
   *
   * Someone may have opened the conversation in a terminal since the last turn. Sending the prompt would make a
   * second writer, and even after that terminal has gone the adapter's memory of the conversation predates what
   * the terminal wrote: continuing from it forks the transcript. So an adapter is dropped when another process
   * holds the conversation open, when one was seen holding it open during the last turn (see {@link watchTwins}), and
   * when the transcript is no longer the size this adapter left it (a terminal that came and went between two
   * prompts); the next start reads the transcript afresh, after the full check.
   */
  private async preflight(): Promise<{ reason: string; detail: string } | null> {
    const support = this.env.attach.get(this.agent.id);
    const ref = this.acpId;
    if (!support || !ref) return { reason: "twin_check_failed", detail: "no takeover support" };
    let live = this.adapter && !this.adapter.exited ? this.adapter : null;
    if (live && this.twinSeen) {
      // A terminal opened the conversation while the turn ran and may be gone now: what it wrote is in the transcript
      // (the mark below took it for the agent's own) and not in this agent's memory.
      this.audit("adapter_discarded", { why: "another process held the conversation open during the last turn" });
      await this.dropAdapter();
      live = null;
    }
    // Without an adapter of its own the session is about to be started: that is the full check, transcript included.
    const verdict = await support.check(ref, { ownPgid: live?.pid ?? null, transcript: live === null });
    if (!verdict.ok) {
      if (live) await this.dropAdapter();
      return verdict;
    }
    if (live && this.transcriptMark !== null) {
      const now = support.transcriptSize(ref);
      if (now !== null && now !== this.transcriptMark) {
        // The agent itself writes between turns too: a background task it started finishes, and it takes a turn of its own
        // to answer it. That is in its memory, and nobody else holds the conversation open (the check above): it is kept.
        const grown = await this.ownGrowth(support, ref, this.transcriptMark);
        if (grown.by === "self") {
          this.audit("transcript_grew_by_agent", { was: this.transcriptMark, now: grown.size });
          this.transcriptMark = grown.size;
          for (const id of grown.tasks) this.ownTasks.add(id);
          return null;
        }
        this.audit("transcript_changed", { was: this.transcriptMark, now, why: grown.why });
        await this.dropAdapter();
        return this.preflight();
      }
    }
    return null;
  }

  /**
   * Who wrote what the transcript gained since `mark`, while this connector's own agent was idle (see
   * {@link classifyAppended}). An entry still being written is waited for, briefly; one that is not done by then is not the
   * agent's for certain.
   */
  private async ownGrowth(support: AttachSupport, ref: string, mark: number): Promise<{ by: "self"; size: number; tasks: string[] } | { by: "other"; why: string }> {
    for (let i = 0; ; i++) {
      const r = support.appendedSince(ref, mark, { entrypoint: this.ownWriter, tasks: this.ownTasks });
      if (r === null) return { by: "other", why: "the transcript shrank, or grew by more than is read" };
      if (r.by !== "partial") return r;
      if (i >= PARTIAL_ENTRY_TRIES) return { by: "other", why: "an entry that is still being written" };
      await sleep(PARTIAL_ENTRY_WAIT_MS);
    }
  }

  /** The turn is over: say so and forget it. Not while the connector is going away: the next run ends or continues it. */
  private endTurn(data: Record<string, unknown>): void {
    if (this.stopping) return;
    this.emit("turn_end", data);
    this.env.store.endTurn(this.id);
  }

  /**
   * What size the transcript is as this connector leaves it: after it starts the session and after every turn. After a
   * turn (`turnFrom`: the size it started at), also which program the transcript names for what the agent wrote in it.
   */
  private markTranscript(turnFrom: number | null = null): void {
    if (!this.agent.attach || !this.acpId) return;
    const support = this.env.attach.get(this.agent.id);
    this.transcriptMark = support?.transcriptSize(this.acpId) ?? null;
    if (turnFrom !== null && support && this.transcriptMark !== null) {
      const turn = support.ownTurn(this.acpId, turnFrom, this.transcriptMark);
      this.ownWriter = turn?.entrypoint ?? null;
      for (const id of turn?.tasks ?? []) this.ownTasks.add(id);
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
    if (this.readOnly) {
      // Nothing to bring back: a read-only session runs no agent. Say that it is still there, and still read-only.
      this.emit("session_resumed", this.terminal
        ? { acp_session_id: this.acpId, live_terminal: true, input: "terminal", modes: [], currentMode: null }
        : { acp_session_id: this.acpId, read_only: true, modes: [], currentMode: null, unattended: false });
      return;
    }
    try {
      if (this.adapter && !this.adapter.exited) await this.enforceMode(this.targetMode);
      else await this.launch("resume");
    } catch (e) {
      // Not signed in (yet): the resume is refused with the fix and the session stays, as for a prompt.
      if (e instanceof SessionRefusal && e.reason === "agent_auth_required") return this.rejectCommand("resume", cmdId, e.reason);
      return this.refuse(e);
    }
    this.audit("session_resumed", { mode: this.currentMode, unattended: this.unattended });
    this.emit("session_resumed", { acp_session_id: this.acpId, modes: this.shownModes(), currentMode: this.currentMode, unattended: this.unattended });
    this.touch();
  }

  /**
   * `withdraw`: take back the prompts that have not started, and nothing else. The ones waiting for the terminal to be free (never
   * typed) and the ones queued behind a running turn are each refused by name (`withdrawn`, with its `cmd_id` and `cmd_seq`); a turn
   * that runs (typed into the terminal, or in the adapter) goes on untouched: no Escape, no session/cancel, no permission answered.
   * A chat that lets the session go while its message still waits sends this, so the person's terminal is never interrupted.
   */
  withdraw(): void {
    let terminal = this.terminalQueue.length;
    if (terminal) this.dropTerminalQueue("withdrawn");
    // A message taken off the queue whose keys have not gone yet (its turn is recorded first, then the terminal is read once more):
    // still the phone's, so it is taken back too. The pump sees its turn is gone right before typing and types nothing.
    const pending = this.terminalTurn;
    if (pending && !pending.keys) {
      this.terminalTurn = null;
      if (!this.stopping) this.env.store.endTurn(this.id);
      this.rejectCommand("prompt", pending.cmdId, "withdrawn", pending.cmdSeq);
      // Counted as handled now, before the withdraw itself is: after a restart Claw must not deliver it again with the withdraw
      // already behind the cursor (the pump would type it). `started` is the manager's once-only `handled`.
      pending.started?.();
      pending.done();
      terminal += 1;
    }
    const dropped = this.queue.map((q) => [q.cmdId, q.cmdSeq] as const);
    this.dropQueued();
    for (const [cmdId, cmdSeq] of dropped) this.rejectCommand("prompt", cmdId, "withdrawn", cmdSeq);
    this.audit("withdrawn", { queued_dropped: terminal + dropped.length, terminal: terminal > 0 });
  }

  /**
   * `cancel`: stop the turn, drop what was queued, answer every waiting permission request `cancelled`. Each prompt dropped
   * unrun is refused by name (`command_rejected`, reason `cancelled`, with its `cmd_id` and `cmd_seq`): it never gets a `turn_end`.
   */
  async cancel(): Promise<void> {
    if (this.readOnly && (this.terminal || this.terminalQueue.length)) {
      const queued = this.terminalQueue.length;
      this.dropTerminalQueue("cancelled");
      const running = this.terminalTurn;
      // Esc only for a turn the phone's message started itself, as the person at the terminal would stop it. Not while the message
      // is still being put in (a question on the screen may be the person's, and Esc would deny it: the wait just ends, and any text
      // already in the box stays there), nor while Claude Code holds it queued or took it into a turn already running (the turn is
      // the person's: the phone stops following it, and the message, if still queued, is Claude Code's to run).
      // (`own` is set only once the transcript shows its prompt starting a turn: by then it was submitted, whatever the typing still checks)
      const interrupt = running?.own === true;
      if (interrupt && this.terminal) await this.terminal.interrupt().catch(() => undefined);
      this.audit("cancelled", { turn_running: running !== null, queued_dropped: queued, terminal: true, interrupted: interrupt });
      if (running) this.endTerminalTurn("cancelled");
      else this.emit("turn_end", { stopReason: "cancelled", cmd_id: null, cmd_seq: null });
      return;
    }
    const dropped = this.queue.map((q) => [q.cmdId, q.cmdSeq] as const);
    const queued = dropped.length;
    this.dropQueued();
    for (const [cmdId, cmdSeq] of dropped) this.rejectCommand("prompt", cmdId, "cancelled", cmdSeq);
    const wasRunning = this.turnRunning;
    if (wasRunning && this.adapter && this.acpId) await this.adapter.notify("session/cancel", { sessionId: this.acpId }).catch(() => undefined);
    for (const actionId of this.book.cancelAll()) this.emit("permission_resolved", { actionId, optionId: null, outcome: "cancelled", by: "cancel" });
    this.audit("cancelled", { turn_running: wasRunning, queued_dropped: queued });
    // A running turn ends with its own `turn_end` (stopReason cancelled, naming its prompt). With none running, say so once,
    // naming no prompt: it ended none.
    if (!wasRunning) this.emit("turn_end", { stopReason: "cancelled", cmd_id: null, cmd_seq: null });
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
    this.ownWriter = null;
    this.ownTasks.clear();
    if (a) await a.kill();
  }

  /** `close`, and the common end of every refusal. */
  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idle);
    this.dropTerminalQueue("session_closed");
    if (this.terminalTurn) this.endTerminalTurn("error", reason === "terminal_closed" ? "terminal_closed" : "session_closed");
    this.stopTail();
    this.dropQueued();
    for (const actionId of this.book.cancelAll()) this.emit("permission_resolved", { actionId, optionId: null, outcome: "cancelled", by: reason });
    const a = this.adapter;
    if (a && this.acpId && (a.caps.sessionCapabilities as AcpParams | undefined)?.close) await a.request("session/close", { sessionId: this.acpId }, 5_000).catch(() => undefined);
    await this.dropAdapter();
    this.env.store.patch(this.id, { status: "closed" });
    this.audit("session_closed", { reason });
    this.emit("session_closed", withHint({ reason }, this.agent));
  }

  /** A session that cannot be opened (or kept safe) is closed with the reason, never left half-open. */
  private async refuse(e: unknown): Promise<void> {
    // Already closed (refused while it was opening): the opening's own failure that follows is not a second refusal.
    if (this.closed) return;
    const r = e instanceof SessionRefusal ? e : mapAdapterError(e);
    this.env.log.warn("session refused", { session: this.id, reason: r.reason, message: r.message });
    this.audit("session_refused", { reason: r.reason, message: r.message.slice(0, 300) });
    await this.close(r.reason);
  }

  /** A command refused; a prompt's refusal names it by `cmd_seq` too, as its turn_end would. */
  rejectCommand(type: string, cmdId: string | null, reason: string, cmdSeq: number | null = null, extra: Record<string, unknown> = {}): void {
    this.audit("command_rejected", { type, cmd_id: cmdId, reason });
    this.emit("command_rejected", withHint({ type, cmd_id: cmdId, reason, ...(cmdSeq !== null ? { cmd_seq: cmdSeq } : {}), ...extra }, this.agent));
  }
}

function mapAdapterError(e: unknown): SessionRefusal {
  const message = errMessage(e);
  return new SessionRefusal(isAuthRequiredError(e) ? "agent_auth_required" : "adapter_error", message);
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

/** The same message, as Claude Code records what was typed: whitespace at the ends and inside runs does not count. */
function sameText(a: string, b: string): boolean {
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}
