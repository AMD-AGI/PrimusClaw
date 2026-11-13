// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The person's assistant as the worker runs it (Python `Agent.__init__`: `Subscriptions`, `Assistant`, and the buttons of its
 * cards): the subscription keeper (only with PROACTIVE_ENABLED, which gives NOTIFY_WEBHOOK_URL), the chat that talks to the
 * assistant, the board, the work item and watch buttons, and the commands the assistant puts to the person.
 */
import type { ClickHandler, Integrations, Lang } from "@primusclaw/personal-agent";
import {
  clientLocaleOf,
  agentActionAllowed,
  AssistantActions,
  AssistantChoiceClicks,
  AssistantChatService,
  Board,
  commandArgs,
  DirectChat,
  exactCommand,
  isKnownCommand,
  menuCommand,
  parseCommand,
  pyStrip,
  Receipts,
  remoteDomain,
  remoteView,
  SubscriptionKeeper,
  turn,
  WatchClicks,
  WorkCardClicks,
  SkillCardClicks,
  WorkClicks,
} from "@primusclaw/personal-agent";

import type { AssemblyBase, ReplyStyle, RouterHooks } from "./features-base.js";
import { messageFiles } from "./features-text.js";

/** The router's test of a command typed whole (`understanding.exact_command`). */
export const isExactCommand = (text: string): boolean => exactCommand(text, { menuCommand, isKnownCommand });

export interface AssistantParts {
  /** undefined: notifications are off (no NOTIFY_WEBHOOK_URL). */
  readonly subs: SubscriptionKeeper | undefined;
  readonly chat: AssistantChatService;
  readonly board: Board;
  readonly receipts: Receipts;
  readonly directChat: DirectChat;
  readonly actions: AssistantActions;
  readonly clicks: readonly ClickHandler[];
}

function keeper(base: AssemblyBase, notifyUrl: string): SubscriptionKeeper | undefined {
  if (!notifyUrl) return undefined; // ('' = notifications off)
  const { assistant } = base.settings;
  return new SubscriptionKeeper({
    store: base.store,
    claw: base.claw.notifications,
    random: base.random,
    logger: base.logger,
    baseUrl: notifyUrl,
    assistant: assistant.enabled,
    understood: (aadId) => assistant.understandingUsers.has(aadId.toLowerCase()),
    assistantFor: (aadId) => assistant.users.size === 0 || assistant.users.has(aadId.toLowerCase()),
    userIdOf: async (key) => pyStrip((await base.plugins.identityLookup.ownerOfKey(key))?.id ?? "") || undefined,
    // The surface Claw routes this person's assistant messages by (a reply goes back to the surface the message came from).
    surface: base.shape.surfaceId,
  });
}

/** The approval card of a request an agent on the person's machine waits on (W6b's view). */
export function remoteAskCard(request: Parameters<ConstructorParameters<typeof Board>[0]["remoteAsk"]>[0]) {
  const lang: Lang = request.lang === "zh" ? "zh" : "en";
  if (remoteView.isTerminalAsk(request.ask)) {
    const terminal = remoteView.terminalAskView(
      { ...request, options: remoteDomain.parseOptions(request.options) },
      lang,
    );
    return {
      body: {
        type: "view" as const,
        view: { name: "terminalAsk" as const, model: terminal },
        fallbackText: terminal.title,
      },
    };
  }
  const model = remoteView.remoteAskView({ ...request, options: remoteDomain.parseOptions(request.options) }, lang);
  return { body: { type: "view" as const, view: { name: "remoteAsk" as const, model }, fallbackText: model.title } };
}

function assistantChat(
  base: AssemblyBase,
  integrations: Integrations,
  style: ReplyStyle,
  parts: { subs: SubscriptionKeeper | undefined; receipts: Receipts; directChat: DirectChat; board: Board },
  hooks: RouterHooks,
): AssistantChatService {
  const { settings, store, claw, metrics } = base;
  return new AssistantChatService({
    store,
    claw: { assistant: claw.assistant, sessions: claw.sessions },
    hasAssistantTypes: parts.subs === undefined ? undefined : (aadId) => parts.subs?.hasAssistantTypes(aadId) ?? false,
    receipts: parts.receipts,
    directChat: parts.directChat,
    clock: base.clock,
    random: base.random,
    logger: base.logger,
    stepLabel: (tool, lang) => turn.lookupLabel(tool, lang, integrations),
    style: () => ({ assistantProgress: style.assistantProgress, assistantStreamSay: style.assistantStreamSay }),
    enabled: settings.assistant.enabled,
    users: settings.assistant.users,
    understanding: settings.assistant.understandingUsers,
    pluginId: settings.claw.pluginId ?? undefined,
    assistantName: settings.botName,
    legacyTurn: (aadId) => hooks.legacyTurn(aadId),
    files: messageFiles(base.surface),
    onFilesDropped: (path, count) => {
      if (count > 0) metrics.filesDropped(path, count);
    },
    board: { show: (userId, key, conversation) => parts.board.show(userId, key, conversation) },
    clientLocale: () => clientLocaleOf(base.requestScope),
    commands: {
      parse: (text) => parseCommand(text) ?? undefined,
      args: (text, name) => commandArgs(text, name) ?? undefined,
    },
  });
}

/** The Run/Cancel buttons of a command the assistant put to the person, and the held write's Allow/Deny. */
function actionClicks(actions: AssistantActions): ClickHandler {
  return {
    verbs: ["assistant_action", "assistant_confirm"],
    withCredential: async (click, key) => {
      if (click.action.verb === "assistant_action") await actions.actionClick(click, key);
      else await actions.confirmClick(click);
    },
  };
}

export interface AssistantInputs {
  readonly style: ReplyStyle;
  readonly integrations: Integrations;
  /** A review the assistant handed back (`review_for_other`): to the review service, "dropped" without it. */
  readonly reviewHandoff: (userId: string, event: Readonly<Record<string, unknown>>) => "delivered" | "dropped";
  /** NOTIFY_WEBHOOK_URL ("" off). */
  readonly notifyUrl: string;
  readonly hooks: RouterHooks;
}

export function assistantParts(base: AssemblyBase, inputs: AssistantInputs): AssistantParts {
  const { style, integrations, notifyUrl, hooks } = inputs;
  const { store, claw, logger, exchange } = base;
  const subs = keeper(base, notifyUrl);
  const receipts = new Receipts(base.clock, logger, () => style.assistantReceipt);
  const directChat = new DirectChat(
    base.settings.directChat.enabled,
    base.settings.directChat.users,
    base.settings.botName,
  );
  const late: { chat?: AssistantChatService } = {};
  const board = new Board({
    store,
    claw: claw.workItems,
    logger,
    on: (u) => late.chat?.on(u) ?? false,
    remoteAsk: remoteAskCard,
    clientLocale: () => clientLocaleOf(base.requestScope),
  });
  const assistant = assistantChat(base, integrations, style, { subs, receipts, directChat, board }, hooks);
  late.chat = assistant;
  const actions = new AssistantActions({
    store,
    claw: claw.assistant,
    exchange,
    runCommand: (text, click, key) => hooks.runCommand(text, click.sender, click.conversation, key),
    exactCommand: isExactCommand,
    agentActionAllowed,
    understands: (userId) => assistant.understands(userId),
    reachable: (userId) => assistant.reachable(userId),
    logger,
    // (a review handed back: taken by the review service, dropped without it as Python's with GITHUB_REVIEW off)
    reviewHandoff: inputs.reviewHandoff,
  });
  const work = new WorkClicks({
    store,
    claw: claw.workItems,
    board,
    onStopped: (itemId) => {
      hooks.itemStopped(itemId);
    },
  });
  const watch = new WatchClicks({ store, claw: claw.workItems, exchange, logger });
  const linked = (userId: string): boolean => store.links.getKey(userId) !== null;
  const choices = new AssistantChoiceClicks({ store, deliver: (message) => hooks.typed(message), logger });
  // (a personal skill's card: Undo, Edit and Save changes; its draft's Save and Discard are the held write's, in `actions`)
  const skillCards = new SkillCardClicks({ store, skills: claw.skills, logger });
  const clicks = [
    new WorkCardClicks(work, watch, exchange, linked, logger),
    actionClicks(actions),
    choices,
    skillCards,
  ];
  return { subs, chat: assistant, board, receipts, directChat, actions, clicks };
}
