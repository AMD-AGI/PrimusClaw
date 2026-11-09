// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { naturalCommand } from "../capabilities/natural.js";
import { sessionControl } from "../capabilities/sessions-words.js";
import { exactCommand } from "../commands/exact.js";
import { menuCommand, parseCommand } from "../commands/parse.js";
import { hasCjk } from "../language/detect.js";
import { routingText } from "../locales/routing.js";
import type { JsonObject } from "../json.js";
import type { InboundFile, InboundMessage } from "../ports/surface.js";
import type { Chat } from "./chat.js";
import type { CommandTable } from "./command-table.js";
import type { RouterContext } from "./context.js";
import type { TurnStarter } from "./turn-start.js";

const ELSEWHERE = "Files are not passed on from this chat while it talks to an agent; only your words were sent.";

/**
 * A 1:1 message that is not one of the chat's commands, as it goes on (the Python `Agent._text_of`, `_on_text`,
 * `_sent_on`, `_talks_to_agent`, `_session_control`, `_understand`, `_understood`, `_offer_github`, `_attachments`):
 * to the remote agent the chat is attached to, to the person's assistant, or to Claw as a turn.
 */
export class PersonalText {
  constructor(
    private readonly ctx: RouterContext,
    private readonly commands: CommandTable,
    private readonly starter: TurnStarter,
  ) {}

  /**
   * What the person wrote, with a word of the commands menu read as its command and a sentence help teaches read as the
   * command it means; a sentence for what this chat cannot do right now stays words.
   */
  textOf(message: InboundMessage, group = false): string {
    const { github, assistant, remote, config } = this.ctx.deps;
    const userId = group ? undefined : message.sender.id;
    const on = (test: (id: string) => boolean): boolean => userId !== undefined && test(userId);
    const attached = on((id) => remote.attached(id));
    const off = new Set<string>();
    const rules: [string, boolean][] = [
      ["github", github !== undefined],
      ["board", on((id) => assistant.on(id))],
      ["brief", config.briefEnabled],
      ["brief now", on((id) => assistant.on(id))],
      ["agents", remote.enabled],
      ["agent", remote.enabled],
      ["agent detach", attached],
      ["stop it", attached], // ("停掉它" stops the attached agent; with the assistant it is the assistant's to read)
      ["new", !(attached && on((id) => assistant.on(id)))], // (in an attached chat: a new agent session, the assistant's)
    ];
    for (const [word, enabled] of rules) if (!enabled) off.add(word);
    return naturalCommand(menuCommand(message.text, group), group, off);
  }

  async onText(message: InboundMessage, chat: Chat, key: string): Promise<void> {
    const text = this.textOf(message);
    if (parseCommand(text) === "unlink" && !message.text.startsWith("/")) {
      // the menu's word, sent by a tap, does not delete a key: the typed `/unlink` is the confirmation
      await chat.say(routingText.in(chat.lang()).unlinkAsk);
      return;
    }
    if (await this.commands.run(text, chat, key, message)) return;
    if (!this.talksToAgent(message))
      await this.offerGithub(message, chat, key, text, (m, fresh) => this.sentOn(m, chat, fresh));
    await this.sentOn(message, chat, key);
  }

  /**
   * Whether this 1:1 message goes to the remote session the chat is attached to: only words the person typed, and not
   * those that start by naming the bot. A chat whose session card is the window keeps its chat box for the bot: only a
   * reply that quotes the card goes to the session.
   */
  talksToAgent(message: InboundMessage): boolean {
    const { remote } = this.ctx.deps;
    const userId = message.sender.id;
    if (!remote.attached(userId) || message.provenance !== "typed" || message.namesBotFirst) return false;
    if (remote.windowMode(userId) === "card") return remote.quotesWindow(userId, message);
    return true;
  }

  /** The files that go to Claw with a message; the person is told about the ones that do not, and they are counted. */
  async attachments(message: InboundMessage, chat: Chat, elsewhere = false): Promise<readonly InboundFile[]> {
    const { messageText, metrics } = this.ctx.deps;
    const unreadable = messageText.unreadable(message);
    if (unreadable !== undefined) {
      metrics.filesDropped("unreadable", unreadable.count);
      await chat.say(unreadable.line);
    }
    if (message.files.length > 0 && elsewhere) {
      metrics.filesDropped("remote_agent", message.files.length);
      await chat.say(ELSEWHERE);
      return [];
    }
    return message.files;
  }

  /** What the chat is attached to, for the assistant (only where remote agents are on). */
  private async attached(userId: string, key: string): Promise<{ attached?: JsonObject | null }> {
    const { remote } = this.ctx.deps;
    return remote.enabled ? { attached: await remote.chatContext(userId, key) } : {};
  }

  /** A 1:1 message that is no command, as it goes on to the attached agent, the assistant or Claw. */
  async sentOn(message: InboundMessage, chat: Chat, key: string): Promise<void> {
    const { messageText, assistant } = this.ctx.deps;
    const userId = chat.sender.id;
    const text = this.textOf(message);
    const toAgent = this.talksToAgent(message);
    // (a reply quoting the session card says which session, not what to read: only the words go to it)
    const quote =
      toAgent && this.ctx.deps.remote.quotesWindow(userId, message) ? "" : messageText.quoteBlock(message, false);
    const sent = messageText.withLinks(text, message);
    const prompt = messageText.withQuote(sent, quote);
    const files = await this.attachments(message, chat, toAgent);
    const control = this.sessionControl(userId, prompt, toAgent, quote, files, text);
    if (control && assistant.understands(userId)) {
      await this.understand(message, chat, key); // (the switch is put to the person as a button)
    } else if (prompt && toAgent && !control) {
      await this.remotePrompt(message, chat, key, prompt);
    } else if (prompt || files.length > 0) {
      await this.toAssistantOrTurn(message, chat, key, { text, quote, sent, prompt, files });
    }
  }

  /**
   * A message to an attached chat that is about the sessions themselves (switch, open a new one), with the assistant on to
   * read it: the words alone (a quote or a file goes to the agent with them).
   */
  private sessionControl(
    userId: string,
    prompt: string,
    toAgent: boolean,
    quote: string,
    files: readonly InboundFile[],
    text: string,
  ): boolean {
    if (!prompt || !toAgent || quote || files.length > 0) return false;
    return this.ctx.deps.assistant.on(userId) && sessionControl(text);
  }

  /** A message the assistant takes when it is on, else a turn of Claw's. */
  private async toAssistantOrTurn(
    message: InboundMessage,
    chat: Chat,
    key: string,
    said: { text: string; quote: string; sent: string; prompt: string; files: readonly InboundFile[] },
  ): Promise<void> {
    const { assistant } = this.ctx.deps;
    const userId = chat.sender.id;
    if (assistant.on(userId) && (await this.ctx.admission.assistantOverLimit(chat, message.id, key))) return;
    const routed = await assistant.route({
      userId,
      credential: key,
      prompt: said.prompt || assistant.filesOnly(chat.lang()),
      conversation: chat.conversation,
      files: said.files,
      ...(await this.attached(userId, key)),
    });
    if (routed) return;
    this.ctx.admission.dropLastHandoff(userId); // (not the assistant's after all: a turn here, counted as one)
    await this.starter.start({
      chat,
      credential: key,
      text: said.text,
      messageId: message.id,
      clientPlatform: message.clientPlatform,
      quote: said.quote,
      sent: said.sent,
      files: said.files,
    });
  }

  /** A prompt for the attached agent, within the task limit (the slot is held until the remote turn counts as running). */
  private async remotePrompt(message: InboundMessage, chat: Chat, key: string, prompt: string): Promise<void> {
    const { remote } = this.ctx.deps;
    const request = {
      message,
      chat: chat.sender,
      credential: key,
      prompt,
      conversation: chat.conversation,
      provider: this.ctx.credentials.provider(chat.sender.id, key),
    };
    if (remote.running(chat.sender.id)) {
      await remote.prompt(request); // (refused by the agent's own rule: one remote turn at a time)
      return;
    }
    const refused = await this.ctx.admission.lock.run(chat.sender.id, async () => {
      if (await this.ctx.admission.overLimit(chat, message.id, "remote_agent", "", key)) return true;
      return false;
    });
    if (refused) return;
    await this.ctx.admission.reserve(chat.sender.id, () => remote.prompt(request));
  }

  /**
   * Beside a question about the person's own GitHub while Claw has no token of theirs: the connect card first; once they
   * connect, the question is asked again as a message of its own (an id of its own), with a credential read again then.
   */
  async offerGithub(
    message: InboundMessage,
    chat: Chat,
    key: string,
    text: string,
    goOn: (message: InboundMessage, credential: string) => Promise<void>,
  ): Promise<void> {
    const { github } = this.ctx.deps;
    if (github === undefined || message.files.length > 0) return; // (what a file link allows may not last until then)
    const again = async (): Promise<void> => {
      const fresh = (await this.ctx.credentials.credential(chat, false)) ?? key;
      const id = message.id || this.ctx.deps.random.hexId();
      await goOn({ ...message, id: `${id}-github` }, fresh);
    };
    await github.offerConnect({
      sender: chat.sender,
      credential: key,
      text,
      lang: chat.lang(),
      conversation: chat.conversation,
      again,
    });
  }

  async understand(message: InboundMessage, chat: Chat, key: string): Promise<void> {
    await this.offerGithub(message, chat, key, message.text, (m, fresh) => this.understood(m, chat, fresh));
    await this.understood(message, chat, key);
  }

  /**
   * A message of a person the assistant understands: to their assistant, as they wrote it (with what it quotes and the
   * addresses behind its links), with the chat's context, and as the person (their exchanged identity token, their key
   * beside it for the model; with no token, on their key). Files go with it; files alone are a message too.
   */
  async understood(message: InboundMessage, chat: Chat, key: string): Promise<void> {
    const { messageText, assistant, exchange, store, logger } = this.ctx.deps;
    const userId = chat.sender.id;
    const prompt = messageText.withQuote(
      messageText.withLinks(message.text, message),
      messageText.quoteBlock(message, false),
    );
    const files = await this.attachments(message, chat);
    if (!prompt && files.length === 0) return;
    let credential = key;
    let modelKey = "";
    if (exchange.enabled) {
      const token = await exchange.tokenFor(userId);
      if (token.ok) {
        credential = token.value;
        modelKey = store.links.getKey(userId) ?? "";
      } else
        logger.info("no identity token for a message to the assistant; it goes on the linked key", {
          kind: token.error.kind,
        });
    }
    const channelMessageId = message.id || `clawy-${this.ctx.deps.random.hexId()}`;
    const context = this.ctx.deps.channelContext({
      channelMessageId,
      userId,
      message,
      parts: this.ctx.parts(),
      handoffs: this.ctx.deps.handoffs,
      via: message.provenance,
      ...(await this.attached(userId, key)),
    });
    const held = assistant.reachable(userId);
    if (held && (await this.ctx.admission.assistantOverLimit(chat, message.id, key))) return;
    // (recorded before it is sent: an action the assistant asks for may arrive before the send returns)
    store.assistantMessages.noteAssistantMessage(
      channelMessageId,
      userId,
      [...context.actions, ...this.ctx.deps.handoffs],
      context.people,
    );
    const sent = await assistant.understand({
      userId,
      credential,
      modelKey,
      prompt: prompt || assistant.filesOnly(chat.lang()),
      context: context.context,
      lang: chat.lang(),
      conversation: chat.conversation,
      files,
    });
    if (!sent && held) this.ctx.admission.dropLastHandoff(userId);
  }

  /** Whether a message goes the fast way (an exact command) rather than to the assistant that reads every message. */
  exact(message: InboundMessage): boolean {
    return exactCommand(message.text);
  }
}

/**
 * A review request does not take the files sent with it, and the person is told so (a review reads the pull request):
 * what the review service calls after it took such a message.
 */
export async function filesNotReviewed(
  ctx: RouterContext,
  chat: Chat,
  message: InboundMessage,
  text: string,
): Promise<void> {
  if (message.files.length === 0 && ctx.deps.messageText.unreadable(message) === undefined) return;
  const count = message.files.length + (ctx.deps.messageText.unreadable(message)?.count ?? 0);
  ctx.deps.metrics.filesDropped("review", count);
  await chat.say(
    hasCjk(text)
      ? "随这条消息发来的文件没有交给 review：review 只读拉取请求本身。"
      : "The files sent with this message were not passed on: a review reads the pull request itself.",
  );
}
