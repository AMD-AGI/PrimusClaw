// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Remote agents from the chat: the coding agents on a person's own machines, driven from the chat. `/agents` lists them,
 * `/agent new|attach|detach|mode|sessions|close|off|pair` manages sessions, and once a chat is attached its plain messages go to
 * the remote session instead of to the assistant. Claw's remote-agents API relays everything; this is the chat's side of it.
 *
 * Everything runs as the person who wrote: their credential, and nobody else's, is what every call carries, and Claw answers 404
 * for a session or connector that is not theirs. Cards are not trusted: a click is checked against what this process stored when
 * it showed the card, never against the card. The agent's own words are untrusted text. This is the router's `RemoteChat` and the
 * click handler of the remote-agent cards; the parts are assembled here and nowhere else.
 */
import type { JsonObject } from "../json.js";
import type { ClickHandler, ClickRoute } from "../ports/routing.js";
import type { Conversation, InboundMessage, UserRef } from "../ports/surface.js";
import { RemoteLiveView, remoteText } from "../remote-view/index.js";
import type { Attachment, RemoteAgentCommand, RemoteChat, RemotePrompt } from "../routing/features.js";
import { StatusBoard } from "./board.js";
import { groupChatKey, personOf } from "./chat-key.js";
import { ChatRegistry } from "./chats.js";
import { StartClicks } from "./clicks-start.js";
import { MachineClicks } from "./clicks-machine.js";
import { type Click, SessionClicks, isClickOp } from "./clicks.js";
import { AgentCommands, type CommandCall, type CommandParts, refusalOf } from "./commands.js";
import type { RemoteContext } from "./context.js";
import { EndedWords, type Provider } from "./ended.js";
import { FollowControl } from "./follow/control.js";
import { Lists } from "./lists.js";
import { Permissions } from "./permissions.js";
import { Prompts } from "./prompt.js";
import { saidIn } from "./refusals.js";
import { SessionOps } from "./session-ops.js";
import { SessionStarts } from "./sessions.js";
import { ChatState } from "./state.js";
import { Targets } from "./targets.js";
import { ChatTurn, RemoteStatusPolicy } from "./turns/chat-turn.js";
import { type TurnRequest, TurnRunner } from "./turns/runner.js";
import type { Signer } from "./turns/signer.js";
import { WindowTurn } from "./turns/window-turn.js";
import { Watches } from "./watches.js";
import { windowCloser } from "./window/closer.js";
import { quotesWindow } from "./window/index.js";

/** How long the assistant's context waits for a session's watch marker to be read back. */
export const CHAT_CONTEXT_WATCH_SECONDS = 2.0;

export class RemoteAgents implements RemoteChat {
  private readonly chats = new ChatRegistry();
  private readonly state: ChatState;
  private readonly board: StatusBoard;
  private readonly follow: FollowControl;
  private readonly commands: AgentCommands;
  private readonly clicks: SessionClicks;
  private readonly starts: StartClicks;
  private readonly machine: MachineClicks;
  private readonly permissions: Permissions;
  private readonly prompts: Prompts;
  private readonly runner: TurnRunner;

  constructor(private readonly ctx: RemoteContext) {
    this.state = new ChatState(ctx, this.chats);
    this.board = new StatusBoard(ctx, this.state);
    this.permissions = new Permissions(ctx, this.state, this.board);
    const lists = new Lists(ctx);
    const ended = new EndedWords(ctx, this.state, lists);
    const show = (
      key: string,
      sid: string,
      request: Readonly<Record<string, unknown>>,
      to: Conversation,
    ): Promise<void> => this.permissions.show(key, sid, request, to);
    this.follow = new FollowControl(ctx, this.state, this.board, {
      showPermission: show,
      describeEnd: (chatKey, connectorId, reason) =>
        ended.sessionEnded(chatKey, "", () => this.readKey(chatKey), connectorId, reason, true),
    });
    this.runner = new TurnRunner(ctx, this.state, this.board, this.follow, ended, show, (request, signer) =>
      this.display(request, signer),
    );
    const watches = new Watches(ctx, this.state, this.board, this.follow, ended);
    const sessionStarts = new SessionStarts(ctx, this.state, lists, this.follow);
    const ops = new SessionOps(ctx, this.state, this.board, lists, this.follow, this.runner, show);
    const parts: CommandParts = {
      ctx,
      state: this.state,
      board: this.board,
      lists,
      starts: sessionStarts,
      ops,
      targets: new Targets(this.chats),
      watches,
      follow: this.follow,
    };
    this.commands = new AgentCommands(parts);
    this.prompts = new Prompts(ctx, this.state, this.board, this.follow, sessionStarts, this.runner, watches);
    this.clicks = new SessionClicks(parts, this.commands, this.prompts);
    this.starts = new StartClicks(parts, this.clicks);
    this.machine = new MachineClicks(parts, this.clicks);
  }

  /** What reads Claw for a chat with nobody to ask (its binder's credential for a group binding). */
  private async readKey(chatKey: string): Promise<string> {
    return (await this.ctx.credentialFor(personOf(chatKey))) ?? "";
  }

  /** How a turn is shown: in the session card when it is the window, else in the chat. */
  private display(request: TurnRequest, signer: Signer | null): WindowTurn | ChatTurn {
    const lang = this.state.lang(request.chatKey);
    if (request.state.window === "card" && !this.state.direct(request.chatKey)) {
      return new WindowTurn(
        request.chatKey,
        request.to,
        this.state,
        this.board,
        (text) => this.ctx.errors.splitErrorTail(text).kept,
      );
    }
    const label = remoteText.in(lang).agentOnHost({ agent: request.state.agentLabel, host: request.state.host });
    const policy = new RemoteStatusPolicy(
      new RemoteLiveView(label, lang),
      (text) => this.ctx.errors.splitErrorTail(text).kept,
      signer,
    );
    return new ChatTurn(request.to, policy, {
      clock: this.ctx.clock,
      log: this.ctx.logger,
      lang,
      replyTo: request.replyTo,
    });
  }

  // --- what the router asks ------------------------------------------------------------------------------------------------

  get enabled(): boolean {
    return this.ctx.settings.enabled;
  }

  /** An attached chat hears its session between turns. */
  get follows(): boolean {
    return this.follow.follows;
  }

  attached(chatKey: string): boolean {
    return this.enabled && this.state.attached(chatKey) !== null;
  }

  running(chatKey: string): boolean {
    return this.chats.turns.has(chatKey);
  }

  direct(chatKey: string): boolean {
    return this.state.direct(chatKey);
  }

  /** Where the chat box of an attached chat goes: 'card' (to the assistant) or 'chat' (to the session). */
  windowMode(chatKey: string): "card" | "chat" {
    const state = this.enabled ? this.state.attached(chatKey) : null;
    if (state?.window === "card" && this.state.directOn(chatKey)) {
      this.follow.chatIsWindow(chatKey); // (attached before direct chat was on for them: the chat is the window from now on)
      return "chat";
    }
    return state?.window === "card" ? "card" : "chat";
  }

  quotesWindow(chatKey: string, message: InboundMessage): boolean {
    const state = this.enabled ? this.state.attached(chatKey) : null;
    if (state === null) return false;
    return quotesWindow(
      message.quotes.map((q) => q.messageId),
      [state.statusCard, ...state.windowCards],
    );
  }

  attachment(chatKey: string): Attachment | undefined {
    const state = this.enabled ? this.state.attached(chatKey) : null;
    return state ? { label: state.agentLabel, host: state.host, cwd: state.cwd } : undefined;
  }

  groupChatKey(userId: string, scope: string): string {
    return groupChatKey(userId, scope);
  }

  /**
   * The session this chat is attached to, as its assistant is told it beside a message. The watch marker is read back the first
   * time this process is asked, but never holds the message up longer than CHAT_CONTEXT_WATCH_SECONDS.
   */
  async chatContext(chatKey: string, credential: string): Promise<JsonObject | null> {
    const state = this.enabled ? this.state.attached(chatKey) : null;
    if (state === null) return null;
    const known = this.state.knownWatch(chatKey, credential, state);
    const late = this.ctx.clock.sleep(CHAT_CONTEXT_WATCH_SECONDS * 1000).then(() => this.state.watches(chatKey, state));
    const watching = await Promise.race([known, late]);
    const space = state.agentLabel.indexOf(" ");
    const [icon, name] =
      space < 0 ? [state.agentLabel, ""] : [state.agentLabel.slice(0, space), state.agentLabel.slice(space + 1)];
    const agent = name && !/[\p{L}\p{N}]/u.test(icon) ? name : state.agentLabel; // ("🤖 Claude Code": the icon goes)
    return {
      session_id: state.sessionId ?? "",
      connector: state.host,
      agent,
      agent_id: state.agentId,
      cwd: state.cwd,
      phase: watching ? "watching" : "attached",
      busy: !watching && this.state.phase(chatKey) === "working",
      chat_box: state.window,
      ...(state.conversation ? { conversation: state.conversation } : {}),
    };
  }

  private call(chat: UserRef, credential: string, conversation: Conversation, provider: Provider): CommandCall {
    return { chatKey: chat.id, key: credential, to: conversation, provider };
  }

  async prompt(request: RemotePrompt): Promise<void> {
    await this.prompts.prompt({
      chatKey: request.chat.id,
      key: request.credential,
      to: request.conversation,
      provider: request.provider,
      text: request.prompt,
      messageId: request.message.id,
      source: "",
      quotesWindow: this.quotesWindow(request.chat.id, request.message),
    });
  }

  stop(chat: UserRef, credential: string, conversation: Conversation): Promise<boolean> {
    return this.prompts.stop(chat.id, credential, conversation);
  }

  agents(sender: UserRef, credential: string, conversation: Conversation): Promise<void> {
    return this.commands.agents(this.call(sender, credential, conversation, undefined));
  }

  agent(command: RemoteAgentCommand): Promise<void> {
    return this.commands.agent(
      this.call(command.chat, command.credential, command.conversation, command.provider),
      command.args,
    );
  }

  /** Stop watching for a chat whose person unlinked: no reader may outlive the key it reads with. */
  forget(chatKey: string): void {
    this.chats.unlinked.add(chatKey); // (before anything else: the turn cancelled below ends by starting a reader)
    this.runner.cancel(chatKey);
    const watcher = this.chats.watchers.get(chatKey);
    this.chats.watchers.delete(chatKey);
    watcher?.cancel();
    this.follow.drop(chatKey);
    this.chats.forget(chatKey);
    this.state.forgetView(chatKey);
  }

  /** `forget` for the person's 1:1 chat and every group chat they bound to a session. */
  forgetPerson(userId: string): void {
    for (const chatKey of this.follow.chatsOf(userId)) this.forget(chatKey);
  }

  /** Follow every chat that is attached: a worker that starts delivers what its agents said while it was away, once. */
  resume(): void {
    this.follow.resume();
  }

  shutdown(): void {
    this.follow.shutdown();
  }

  // --- the cards' buttons ----------------------------------------------------------------------------------------------------

  /** The click handler of the remote-agent cards: the agents and sessions cards, the status card, approvals, disconnect. */
  get clickHandler(): ClickHandler {
    return {
      verbs: ["remote", "remote_decision", "remote_off"],
      withCredential: (click, credential) => this.onClick(click, credential),
    };
  }

  private async onClick(route: ClickRoute, credential: string): Promise<void> {
    const kind = route.action.data["primusclaw"];
    const click: Click = {
      chatKey: route.sender.id,
      key: credential,
      provider: undefined,
      to: route.conversation,
      tapped: route.action.cardMessageId,
      data: route.action.data,
      id: route.action.id,
      settle: (card, options) => route.settle(card, options),
    };
    if (kind === "remote_decision") return this.decide(click);
    if (kind === "remote_off") return this.machine.off(click);
    await this.tap(click);
  }

  /** A click on an option of a permission card (on the session card, the window stays the card). */
  private async decide(click: Click): Promise<void> {
    const settle = click.data["in_window"]
      ? windowCloser(this.ctx, this.state, this.board, click, click.settle)
      : click.settle;
    await this.permissions.decide({ person: click.chatKey, key: click.key, data: click.data, settle });
  }

  /** A tap on a button of the agents card or of the status card. */
  private async tap(click: Click): Promise<void> {
    const lang = this.state.lang(click.chatKey);
    const op = typeof click.data["op"] === "string" ? click.data["op"] : "";
    if (!this.enabled || !isClickOp(op)) {
      await click.settle(saidIn(lang, this.enabled ? "tapInvalid" : "tapInactive"));
      return;
    }
    try {
      await this.runOp(click, op);
    } catch (error) {
      const said = refusalOf(error, this.ctx, lang);
      if (said === null) throw error;
      if (said === saidIn(lang, "notEnabled")) await click.settle(said);
      else await this.clicks.back(click, said);
    }
  }

  private runOp(click: Click, op: Parameters<typeof isClickOp>[0]): Promise<void> {
    const handlers: Readonly<Record<string, (c: Click) => Promise<void>>> = {
      new: (c) => this.starts.newSession(c),
      attach: (c) => this.starts.attach(c),
      takeover: (c) => this.starts.takeover(c),
      detach: (c) => this.clicks.detach(c),
      close: (c) => this.clicks.close(c),
      mode: (c) => this.clicks.mode(c),
      set_mode: (c) => this.clicks.setMode(c),
      row: (c) => this.clicks.row(c),
      list: (c) => this.clicks.list(c),
      switch: (c) => this.clicks.switch(c),
      stop: (c) => this.clicks.stop(c),
      send: (c) => this.clicks.send(c),
      full: (c) => this.clicks.full(c),
      pair: (c) => this.clicks.pair(c),
      hide: (c) => this.machine.hide(c),
      hidden: (c) => this.machine.hidden(c),
      unhide: (c) => this.machine.unhide(c),
    };
    const handler = handlers[op];
    return handler ? handler(click) : Promise.resolve();
  }
}
