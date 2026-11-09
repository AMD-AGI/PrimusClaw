// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Short watches: what `/agent new` waits for (the agent's first word, at most WATCH_SECONDS) and what `/agent mode` waits for (the
 * mode the agent reports, or the connector's refusal). A watch reads the session from where the chat left it and moves the read
 * position past what it read; once it is over the follower reads on.
 */
import { ClawError } from "../claw/errors.js";
import { errorName } from "../errors.js";
import type { Lang } from "../locales/lang.js";
import { remoteAgentText } from "../locales/remote-agents.js";
import { remoteLeads } from "../locales/remote-leads.js";
import { remoteText } from "../locales/remote.js";
import type { RemoteState } from "../ports/store/remote.js";
import { type Conversation, textMessage } from "../ports/surface.js";
import { type RemoteStep, decode, noAskLine, readOnlyRefused } from "../remote-view/index.js";
import { neutral } from "../text/neutral.js";
import type { StatusBoard } from "./board.js";
import type { RemoteContext } from "./context.js";
import { type EndedWords, type Provider, credentialOf } from "./ended.js";
import type { FollowControl } from "./follow/control.js";
import { saysModes } from "./follow/follower.js";
import { saidIn } from "./refusals.js";
import { type ChatState, isTransport } from "./state.js";
import { Task } from "./tasks.js";

/** How long `/agent new` waits to say the agent is ready. */
export const WATCH_SECONDS = 30;
export const MODE_WATCH_SECONDS = 10;
export const MODE_ID_MAX = 64;

/** What a mode switch waits for: the mode the agent now reports, or the connector's refusal of the switch. */
export function modeAnswer(step: RemoteStep): boolean {
  return step.mode !== null || step.rejected?.type === "set_mode";
}

/** What the watch of a new session needs: who, where, and what the card asked for. */
export interface StartWatch {
  readonly chatKey: string;
  readonly sessionId: string;
  readonly key: string;
  readonly provider: Provider;
  readonly to: Conversation;
  /** The kind of session the card asked for when it is not how the agent starts ("ask" | "unattended"). */
  readonly want: string | null;
  /** The count a start in a mode that does not ask took, given back when it turns out not to be one. */
  readonly ticket: object | null;
}

export class Watches {
  constructor(
    private readonly ctx: RemoteContext,
    private readonly state: ChatState,
    private readonly board: StatusBoard,
    private readonly follow: FollowControl,
    private readonly ended: EndedWords,
  ) {}

  /** Run a watch for the chat; once it is over (not cancelled) the follower reads on. */
  spawn(chatKey: string, work: (signal: AbortSignal) => Promise<void>): void {
    const task = new Task(work, this.ctx.logger, "a short watch");
    this.state.chats.watchers.set(chatKey, task);
    void task.done.then(() => {
      if (!task.cancelled) this.follow.ensure(chatKey); // (a watch is over: follow again)
    });
  }

  cancel(chatKey: string): void {
    const task = this.state.chats.watchers.get(chatKey);
    this.state.chats.watchers.delete(chatKey);
    task?.cancel();
  }

  /**
   * Read the session's events until one is `wanted` (or the session ends), for at most `seconds`; the read position moves past
   * what was read. That step, a closing step, or null when time ran out.
   */
  async watch(
    chatKey: string,
    sessionId: string,
    credential: () => Promise<string>,
    wanted: (step: RemoteStep) => boolean,
    seconds: number,
    signal: AbortSignal,
  ): Promise<RemoteStep | null> {
    const state = this.state.attached(chatKey);
    let cursor = state?.sessionId === sessionId ? state.cursor : "";
    const limit = AbortSignal.any([signal, AbortSignal.timeout(seconds * 1000)]);
    try {
      for await (const event of this.ctx.claw.stream(await credential(), sessionId, cursor || undefined, limit)) {
        const step = decode(event, this.ctx.errors);
        if (event.id) cursor = event.id;
        if (step.replay) continue;
        if (saysModes(step)) this.ctx.remoteState.setRemoteModes(chatKey, sessionId, step);
        if (step.closed !== null || wanted(step)) return step;
      }
    } catch (error) {
      if (!watchEnds(error, limit, signal)) throw error;
    } finally {
      if (cursor) this.ctx.remoteState.setRemoteCursor(chatKey, sessionId, cursor);
    }
    return null;
  }

  /** The watch of a new session: say it is ready (in place, on its status card), or why it could not start. */
  async start(w: StartWatch, signal: AbortSignal): Promise<void> {
    try {
      const credential = (): Promise<string> => credentialOf(w.key, w.provider);
      const step = await this.watch(w.chatKey, w.sessionId, credential, (s) => s.started, WATCH_SECONDS, signal);
      const state = this.state.attached(w.chatKey);
      if (state?.sessionId !== w.sessionId) return;
      if (step?.terminal !== null && step?.terminal !== undefined)
        this.state.chats.markTerminal(w.chatKey, w.sessionId, step.terminal);
      // (so /agents does not offer this chat's own conversation as one to join)
      if (step?.acp) this.ctx.sessionNames.setRemoteSessionAcp(w.sessionId, step.acp);
      if (step === null) await this.notReported(w);
      else if (step.closed !== null) await this.couldNotStart(w, state, step.closed);
      else if (step.readOnly === true) await this.watching(w);
      else await this.ready(w, step, signal);
    } catch (error) {
      if (signal.aborted) return;
      this.ctx.logger.warn("watching the session start failed", { error: errorName(error) });
    }
  }

  private async couldNotStart(w: StartWatch, state: RemoteState, reason: string): Promise<void> {
    this.ctx.guard.giveBack(w.chatKey, "remote_agent", w.ticket);
    const lang = this.state.lang(w.chatKey);
    const said = await this.ended.said(
      w.chatKey,
      remoteLeads.couldNotStart,
      w.key,
      w.provider,
      state.connectorId,
      reason,
    );
    this.follow.detach(w.chatKey);
    await w.to.send(textMessage(`${said} ${saidIn(lang, "backToPrimusclaw")}`));
  }

  /** Open in a terminal: watched, read-only; its output is told as it comes. */
  private async watching(w: StartWatch): Promise<void> {
    this.state.chats.markReadOnly(w.chatKey, w.sessionId, true);
    this.ctx.guard.giveBack(w.chatKey, "remote_agent", w.ticket);
    const state = this.state.attached(w.chatKey);
    if (state?.sessionId !== w.sessionId) return;
    if (await this.board.settleStatus(w.chatKey, w.to, state, "watching")) return;
    const lang = this.state.lang(w.chatKey);
    const head = remoteAgentText.in(lang).watchingHead({ label: state.agentLabel, host: state.host });
    await w.to.send(textMessage(`${head} ${readOnlyRefused(lang, this.state.offersTakeover(w.chatKey))}`));
  }

  private async ready(w: StartWatch, step: RemoteStep, signal: AbortSignal): Promise<void> {
    const lang = this.state.lang(w.chatKey);
    // A terminal that runs what it is sent without asking: said once, as the chat attaches to it.
    const warning = step.terminal === true ? noAskLine(step.terminalMode, lang) : null;
    if (warning) await w.to.send(textMessage(warning));
    const switched = w.want ? await this.approvalNote(w, w.want, signal) : "";
    const state = this.state.attached(w.chatKey);
    if (state?.sessionId !== w.sessionId) return;
    if (state.unattended === false) this.ctx.guard.giveBack(w.chatKey, "remote_agent", w.ticket); // (it asks: not what was counted)
    // Ready is what the status card says (in place): a new message only when there is no card, or for the switch's outcome.
    if (await this.board.settleStatus(w.chatKey, w.to, state, "idle", switched.trim())) {
      if (switched) await w.to.send(textMessage(switched.trim()));
      return;
    }
    await w.to.send(textMessage(readyLine(state, lang, switched)));
  }

  private async notReported(w: StartWatch): Promise<void> {
    const lang = this.state.lang(w.chatKey);
    const state = this.state.attached(w.chatKey);
    const lead = remoteAgentText.in(lang).notReportedLead;
    if (state === null || !(await this.board.settleStatus(w.chatKey, w.to, state, "idle", lead))) {
      await w.to.send(textMessage(saidIn(lang, "notReported")));
    }
  }

  /**
   * The card asked for a kind of session the agent does not start as: the agent has just said which modes it offers and which of
   * them ask, so switch it to one that does what was asked, and say so. What a connector refuses or does not say is told, never
   * guessed: a mode id is never made up. (The same per-person limit as `/agent mode` to a mode that does not ask.)
   */
  private async approvalNote(w: StartWatch, want: string, signal: AbortSignal): Promise<string> {
    const state = this.state.attached(w.chatKey);
    if (state?.sessionId !== w.sessionId) return "";
    const wanted = want === "unattended";
    if (state.unattended === wanted) return "";
    const words = remoteAgentText.in(this.state.lang(w.chatKey));
    const target = state.modes.find((m) => state.modeFlags[m] === wanted);
    if (target === undefined) return words.noModeSays({ which: wanted ? words.doNotAsk : words.ask });
    const ticket = {};
    if (wanted) {
      const refused = this.ctx.guard.take(w.chatKey, "remote_agent", ticket, { session_id: w.sessionId || null });
      if (refused) return words.limitAsks({ refused: refused.text() });
    }
    const said = await this.switchTo(w, target, signal);
    if (said !== null && wanted) this.ctx.guard.giveBack(w.chatKey, "remote_agent", ticket); // (not switched: no allowance used)
    if (said !== null) return said;
    const now = this.state.attached(w.chatKey);
    if (now?.sessionId !== w.sessionId || now.unattended !== wanted) return words.switchUnconfirmed;
    return words.switchedTo({ mode: neutral(now.mode, MODE_ID_MAX) });
  }

  /** Ask the session to switch to `target` and watch for its answer: why it did not (a line), or null when it may have. */
  private async switchTo(w: StartWatch, target: string, signal: AbortSignal): Promise<string | null> {
    try {
      await this.ctx.claw.command(w.key, w.sessionId, { type: "set_mode", mode_id: target });
    } catch (error) {
      if (!(error instanceof ClawError) && !isTransport(error)) throw error;
      return remoteAgentText.in(this.state.lang(w.chatKey)).switchFailed;
    }
    const credential = (): Promise<string> => credentialOf(w.key, w.provider);
    const step = await this.watch(w.chatKey, w.sessionId, credential, modeAnswer, MODE_WATCH_SECONDS, signal);
    if (!step?.rejected) return null;
    const connectorId = this.state.attached(w.chatKey)?.connectorId ?? "";
    const why = await this.ended.said(
      w.chatKey,
      remoteLeads.modeNotSwitched,
      w.key,
      w.provider,
      connectorId,
      step.rejected.reason,
    );
    return ` ${why}`;
  }

  /** The watch of a mode switch: say what it came to. */
  async mode(
    chatKey: string,
    sessionId: string,
    mode: string,
    w: { key: string; provider: Provider; to: Conversation },
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const credential = (): Promise<string> => credentialOf(w.key, w.provider);
      const step = await this.watch(chatKey, sessionId, credential, modeAnswer, MODE_WATCH_SECONDS, signal);
      const lang = this.state.lang(chatKey);
      const words = remoteAgentText.in(lang);
      const shown = neutral(mode, MODE_ID_MAX);
      let line: string;
      if (step?.rejected) {
        const state = this.state.attached(chatKey);
        line = await this.ended.said(
          chatKey,
          remoteLeads.notSwitchedTo(shown),
          w.key,
          w.provider,
          state?.connectorId ?? "",
          step.rejected.reason,
        );
      } else if (step !== null && step.closed === null)
        line = words.modeNow({ mode: neutral(step.mode ?? "", MODE_ID_MAX) });
      else line = words.modeUnconfirmed({ mode: shown });
      await w.to.send(textMessage(line));
    } catch (error) {
      if (signal.aborted) return;
      this.ctx.logger.warn("watching the mode change failed", { error: errorName(error) });
    }
  }
}

/** The watch ends quietly: its time ran out, the stream failed or Claw refused (a cancel of the watch itself is not quiet). */
function watchEnds(error: unknown, limit: AbortSignal, signal: AbortSignal): boolean {
  if (signal.aborted) return false;
  return limit.aborted || error instanceof ClawError || isTransport(error);
}

/** The line that says a new session is ready, where there is no status card to say it. */
function readyLine(state: RemoteState, lang: Lang, switched: string): string {
  const words = remoteAgentText.in(lang);
  const note = remoteText.in(lang).unattendedNote;
  return words.ready({
    label: state.agentLabel,
    host: state.host,
    mode: state.mode ? words.readyMode({ mode: neutral(state.mode, MODE_ID_MAX) }) : "",
    unattended: state.unattended === true ? words.readyUnattended({ note }) : "",
    switched: lang === "zh" ? switched.trim() : switched,
  });
}
