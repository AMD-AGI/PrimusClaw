// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `/agents` and `/agent new|attach|detach|mode|sessions|close|off|pair`: the commands of remote agents. A refusal of Claw's, remote
 * agents off on Claw and Claw out of reach are each said as a sentence of their own (`refusalOf`).
 */
import { ClawError } from "../claw/errors.js";
import { parseAgentCommand } from "../commands/agent-args.js";
import { leftLine, modeUnifiedLine } from "../direct-chat/direct-chat.js";
import type { Lang } from "../locales/lang.js";
import { AGENT_USAGE } from "../locales/commands.js";
import { remoteAgentText } from "../locales/remote-agents.js";
import { type Conversation, type OutMessage, richMessage, textMessage } from "../ports/surface.js";
import { agentsText, backLine, readOnlyRefused, startsUnattended } from "../remote-view/index.js";
import { neutral } from "../text/neutral.js";
import type { StatusBoard } from "./board.js";
import { disconnectMessage, machineChoiceMessage } from "./cards.js";
import { personOf } from "./chat-key.js";
import type { RemoteContext } from "./context.js";
import type { Provider } from "./ended.js";
import type { FollowControl } from "./follow/control.js";
import { type AgentsAnswer, type Lists, RemoteOff } from "./lists.js";
import { resolveAgent } from "./machines.js";
import { failureText, saidIn } from "./refusals.js";
import type { SessionOps } from "./session-ops.js";
import type { SessionStarts } from "./sessions.js";
import { type ChatState, isTransport, modeFlagOf } from "./state.js";
import { type Target, type Targets, sessionsByRef } from "./targets.js";
import { MODE_ID_MAX, type Watches } from "./watches.js";
import { isWindowMode, modeSetLine } from "./window/index.js";

/** One `/agent` command: the chat, the person's credential, where to answer, and what refreshes the credential. */
export interface CommandCall {
  readonly chatKey: string;
  readonly key: string;
  readonly to: Conversation;
  readonly provider: Provider;
}

/** What the commands work with. */
export interface CommandParts {
  readonly ctx: RemoteContext;
  readonly state: ChatState;
  readonly board: StatusBoard;
  readonly lists: Lists;
  readonly starts: SessionStarts;
  readonly ops: SessionOps;
  readonly targets: Targets;
  readonly watches: Watches;
  readonly follow: FollowControl;
}

/** The sentence for an error a remote-agents call ended in, or null when it is none of the expected ones (it is thrown on). */
export function refusalOf(error: unknown, ctx: RemoteContext, lang: Lang): string | null {
  if (error instanceof RemoteOff) return saidIn(lang, "notEnabled");
  if (error instanceof ClawError) return failureText(error, ctx.errors, ctx.clock.epochMs() / 1000, lang);
  if (isTransport(error)) return saidIn(lang, "unreachable");
  return null;
}

/** A message for what `/agents` shows. */
export function agentsMessage(answer: AgentsAnswer): OutMessage {
  if (answer.kind === "card") return answer.message;
  return answer.kind === "rich" ? richMessage(answer.text) : textMessage(answer.text);
}

export class AgentCommands {
  constructor(private readonly p: CommandParts) {}

  private lang(call: CommandCall): Lang {
    return this.p.state.lang(call.chatKey);
  }

  private say(call: CommandCall, text: string): Promise<void> {
    return call.to.send(textMessage(text));
  }

  /** `/agents`; the reasons it cannot be shown are sentences like everywhere else here. */
  async agents(call: CommandCall, lead = "", machines = true): Promise<void> {
    if (!this.p.ctx.settings.enabled) return this.say(call, saidIn(this.lang(call), "notEnabled"));
    let answer: AgentsAnswer;
    try {
      answer = await this.p.lists.agentsView(call.chatKey, call.key, this.lang(call), lead, machines);
    } catch (error) {
      const said = refusalOf(error, this.p.ctx, this.lang(call));
      if (said === null) throw error;
      return this.say(call, said);
    }
    await call.to.send(agentsMessage(answer));
  }

  /** `/agent ARGS`. */
  async agent(call: CommandCall, args: string): Promise<void> {
    if (!this.p.ctx.settings.enabled) return this.say(call, saidIn(this.lang(call), "notEnabled"));
    const parsed = parseAgentCommand(args);
    if (parsed === null) {
      // `/agent` alone is a question, not a mistake: the card says everything the usage did, with buttons
      if (!args.trim()) return this.agents(call);
      return this.say(call, AGENT_USAGE);
    }
    try {
      await this.run(call, parsed.verb, parsed.rest);
    } catch (error) {
      const said = refusalOf(error, this.p.ctx, this.lang(call));
      if (said === null) throw error;
      await this.say(call, said);
    }
  }

  private run(call: CommandCall, verb: string, rest: string): Promise<void> {
    switch (verb) {
      case "new":
        return this.newSession(call, rest);
      case "sessions":
        return this.sessions(call);
      case "attach":
        return this.attach(call, rest);
      case "detach":
        return this.detach(call);
      case "mode":
        return this.mode(call, rest);
      case "close":
        return this.close(call, rest);
      case "off":
        return this.off(call, rest);
      default:
        return this.pair(call);
    }
  }

  private async pair(call: CommandCall): Promise<void> {
    const lang = this.lang(call);
    const text = await this.p.lists.pairView(call.key, lang);
    await call.to.send(richMessage(text ?? agentsText([], await this.p.lists.setup(call.key), lang)));
  }

  private async newSession(call: CommandCall, rest: string): Promise<void> {
    const words = rest.trim().split(/\s+/u);
    const ref = words[0] ?? "";
    const path = rest.trim().slice(ref.length).trim();
    if (!ref || !path) {
      // no folder (or nothing at all): the card has the folder choice
      return this.agents(call, remoteAgentText.in("en").newUsage);
    }
    const lang = this.lang(call);
    if (this.p.state.chats.turns.has(call.chatKey)) return this.say(call, saidIn(lang, "stopFirst"));
    const now = this.p.ctx.clock.epochMs() / 1000;
    const chosen = resolveAgent((await this.p.lists.machines(call.key)).connectors, ref, now, lang);
    if (chosen.kind === "refusal") return this.say(call, chosen.text);
    if (chosen.kind === "machine") {
      // a machine with several agents: which one is a tap, the folder is already typed
      const token = this.p.state.chats.rememberPath(call.chatKey, path, this.p.ctx.random.hexId().slice(0, 16), now);
      return call.to.send(machineChoiceMessage(chosen.connector, chosen.agents, token, path, lang));
    }
    await this.start(call, { kind: "start", connector: chosen.connector, agent: chosen.agent, entry: null, path });
  }

  /** Start a session (taking over its conversation, when there is one), say so, and watch for the agent's first word. */
  private async start(call: CommandCall, target: Extract<Target, { kind: "start" }>): Promise<void> {
    const { ticket, refusal } = this.p.starts.takeUnattendedStart(call.chatKey, target.agent);
    if (refusal) return this.say(call, refusal);
    const was = this.p.state.attached(call.chatKey);
    const sessionId = await this.p.starts.begin(call.chatKey, call.key, {
      connector: target.connector,
      agent: target.agent,
      path: target.path,
      resumeRef: target.entry?.ref,
      conversation: target.entry?.title ?? "",
      ticket,
    });
    await this.p.board.showEntered(call.chatKey, call.to, was, "starting", "", startsUnattended(target.agent));
    this.p.watches.spawn(call.chatKey, (signal) =>
      this.p.watches.start(
        { chatKey: call.chatKey, sessionId, key: call.key, provider: call.provider, to: call.to, want: null, ticket },
        signal,
      ),
    );
  }

  private async sessions(call: CommandCall): Promise<void> {
    await call.to.send(await this.p.lists.sessionsView(call.chatKey, call.key, this.lang(call)));
  }

  private async attach(call: CommandCall, rest: string): Promise<void> {
    const lang = this.lang(call);
    if (!rest) return this.say(call, saidIn(lang, "attachHow"));
    if (this.p.state.chats.turns.has(call.chatKey)) return this.say(call, saidIn(lang, "stopFirst"));
    const { connectors } = await this.p.lists.machines(call.key);
    const { sessions } = await this.p.lists.sessions(call.key);
    const listing = this.p.ctx.remoteState.getRemote(call.chatKey)?.listing ?? [];
    const ref = rest.split(/\s+/u)[0] ?? "";
    const target = this.p.targets.target(
      call.chatKey,
      listing,
      connectors,
      sessions,
      ref,
      this.p.ctx.clock.epochMs() / 1000,
      lang,
    );
    if (target.kind === "refusal") return this.say(call, target.text);
    if (target.kind === "start") return this.start(call, target); // nothing to go back to: a session is started
    const was = this.p.state.attached(call.chatKey);
    const hooks = this.p.ops.attachHooks(call.chatKey, call.key, call.provider, call.to);
    const attached = await this.p.starts.attach(call.chatKey, call.key, target.session, hooks);
    if (!attached.ok) return this.say(call, attached.text);
    await this.p.board.showEntered(call.chatKey, call.to, was, attached.phase, attached.lead);
    await attached.followUp();
  }

  private async detach(call: CommandCall): Promise<void> {
    const lang = this.lang(call);
    const state = this.p.state.attached(call.chatKey);
    if (state === null) return this.say(call, saidIn(lang, "notAttachedDetach"));
    const left = await this.p.ops.letGoOfTurn(call.chatKey, call.key, state);
    this.p.watches.cancel(call.chatKey);
    this.p.follow.detach(call.chatKey);
    await this.p.board.editStatus(call.chatKey, call.to, this.p.board.statusOf(call.chatKey, state, "detached"));
    await this.p.board.dropKept(call.chatKey, call.to);
    const tail = left ? `\n\n${left}` : "";
    if (this.p.state.direct(call.chatKey)) {
      // (one line, and the way back to the agent under it)
      const replies = this.p.board.backReplies(call.chatKey);
      return call.to.send({ ...textMessage(leftLine(lang) + tail), suggestions: replies });
    }
    await this.say(call, backLine(lang) + tail);
  }

  private async mode(call: CommandCall, rest: string): Promise<void> {
    const lang = this.lang(call);
    const state = this.p.state.attached(call.chatKey);
    const word = (rest.split(/\s+/u)[0] ?? "").toLowerCase();
    if (isWindowMode(word)) {
      // `/agent mode card|chat`: where the chat box goes while attached (the person's own setting)
      if (this.p.state.direct(call.chatKey)) return this.say(call, modeUnifiedLine(lang));
      this.p.ctx.prefs.setRemoteWindowPref(personOf(call.chatKey), word);
      await this.say(call, modeSetLine(word, lang, state !== null, this.p.ctx.settings.botName));
      if (state !== null && state.window !== word) {
        // (this chat too: its status card becomes the window, or stops being it)
        this.p.ctx.remoteState.setRemoteWindow(call.chatKey, word);
        const now = this.p.state.attached(call.chatKey) ?? state;
        await this.p.board.postStatus(
          call.chatKey,
          call.to,
          this.p.board.statusOf(call.chatKey, now, this.p.state.phase(call.chatKey)),
        );
      }
      return;
    }
    if (state === null) return this.say(call, saidIn(lang, "notAttached"));
    if (!rest) return this.say(call, modesLine(state.mode, state.modes));
    const refusal = await this.changeMode(call, rest.split(/\s+/u)[0] ?? "");
    if (refusal) await this.say(call, refusal);
  }

  /** Ask the agent to switch to `mode` (the watch says when it has): why not, or null. */
  async changeMode(call: CommandCall, mode: string): Promise<string | null> {
    const lang = this.lang(call);
    const state = this.p.state.attached(call.chatKey);
    if (state === null) return saidIn(lang, "notAttached");
    if (await this.p.state.knownWatch(call.chatKey, call.key, state)) {
      return readOnlyRefused(lang, this.p.state.offersTakeover(call.chatKey)); // (the terminal's session: nothing here changes it)
    }
    const refused = this.p.ops.modeRefusal(call.chatKey, state, mode, lang);
    if (refused) return refused;
    // A mode that runs without asking is the agent's widest authority: limited per person. Only a mode the session said asks is free.
    const counted = modeFlagOf(state.modeFlags, mode) !== false;
    const ticket = {};
    const sid = state.sessionId ?? "";
    if (counted) {
      const limit = this.p.ctx.guard.take(call.chatKey, "remote_agent", ticket, { session_id: sid || null });
      if (limit) return limit.text();
    }
    await this.p.follow.stop(call.chatKey); // (the watch below reads the answer to this from the stored position)
    try {
      await this.p.ctx.claw.command(call.key, sid, { type: "set_mode", mode_id: mode });
    } catch (error) {
      if (counted) this.p.ctx.guard.giveBack(call.chatKey, "remote_agent", ticket); // (not switched: no allowance used)
      this.p.follow.ensure(call.chatKey); // (refused: no watch will follow, so the reader goes on)
      throw error;
    }
    this.p.watches.cancel(call.chatKey);
    this.p.watches.spawn(call.chatKey, (signal) =>
      this.p.watches.mode(call.chatKey, sid, mode, { key: call.key, provider: call.provider, to: call.to }, signal),
    );
    return null;
  }

  private async close(call: CommandCall, rest: string): Promise<void> {
    const lang = this.lang(call);
    const state = this.p.state.attached(call.chatKey);
    if (!rest && state === null) return this.say(call, saidIn(lang, "notAttached"));
    const target = rest ? await this.pickSession(call, rest) : (state?.sessionId ?? null);
    if (target === null) return;
    const { done, text } = await this.p.ops.close(call.chatKey, call.key, target);
    if (done && state?.sessionId === target) {
      await this.p.board.editStatus(call.chatKey, call.to, this.p.board.statusOf(call.chatKey, state, "ended"));
    }
    await this.say(call, text);
  }

  /** The session a person named by its number in the last listing or by its id; null after saying why not. */
  private async pickSession(call: CommandCall, rest: string): Promise<string | null> {
    const { sessions } = await this.p.lists.sessions(call.key);
    const listing = this.p.ctx.remoteState.getRemote(call.chatKey)?.listing ?? [];
    const found = sessionsByRef(listing, sessions, rest.split(/\s+/u)[0] ?? "");
    const only = found[0];
    if (found.length !== 1 || only === undefined) {
      await this.say(call, saidIn(this.lang(call), "whichSession"));
      return null;
    }
    return only.sessionId;
  }

  private async off(call: CommandCall, rest: string): Promise<void> {
    const { connectors } = await this.p.lists.machines(call.key);
    const state = this.p.state.attached(call.chatKey);
    let chosen = connectors.length === 1 ? connectors : [];
    if (rest) chosen = connectors.filter((c) => c.name.toLowerCase() === rest.toLowerCase());
    else if (state) chosen = connectors.filter((c) => c.connectorId === state.connectorId);
    const only = chosen[0];
    if (chosen.length !== 1 || only === undefined) {
      const names = connectors.map((c) => `\`${neutral(c.name, 60)}\``).join(", ");
      const words = remoteAgentText.in("en");
      return this.say(call, names ? words.whichMachine({ names }) : words.whichMachineNone);
    }
    const setup = await this.p.lists.setup(call.key);
    await call.to.send(disconnectMessage(only.name, only.connectorId, setup, this.lang(call), only.paired));
  }
}

/** What `/agent mode` alone says (English, as the worker said it). */
function modesLine(mode: string, modes: readonly string[]): string {
  const words = remoteAgentText.in("en");
  const have = modes.map((m) => `\`${neutral(m, MODE_ID_MAX)}\``).join(", ");
  return (
    (mode ? words.modeIs({ mode: neutral(mode, MODE_ID_MAX) }) : "") +
    (have ? words.modesOffered({ have }) : words.modesUnknown)
  );
}
