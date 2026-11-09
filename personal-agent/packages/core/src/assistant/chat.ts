// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A 1:1 chat that talks to the person's one assistant in Claw instead of to a session (teams_agent/assistant.py, the chat half).
 *
 * With the assistant on for a person, their message goes to the assistant and returns at once: nothing waits for an answer and
 * nothing locks the chat. What the assistant says comes back later as an `assistant.say` notification (proactive). The message
 * opens a receipt under it ("Got it, working on it…") that the turn's steps move and the reply closes.
 */
import type { JsonObject } from "../json.js";
import { errorName } from "../errors.js";
import type { Lang } from "../locales/lang.js";
import { assistantChatText } from "../locales/assistant-chat.js";
import { commandText } from "../locales/commands.js";
import { answerLang } from "../language/detect.js";
import type { ClawAssistantPort, ClawSessionsPort } from "../ports/claw/index.js";
import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type { Random } from "../ports/random.js";
import type { StorePort } from "../ports/store/index.js";
import type { Conversation, InboundFile } from "../ports/surface.js";
import { cpHead } from "../text/py-text.js";
import type { DirectChat } from "../direct-chat/direct-chat.js";
import { handOver, type MessageFiles } from "./files.js";
import { TurnFollower, type StepLabel } from "./follow.js";
import { clawFailure, refusal } from "./failures.js";
import type { Receipt } from "./receipt.js";
import type { Receipts } from "./receipts.js";
import { streamOpener } from "./tracked-stream.js";

/** A Claw that answers "no assistant here" is not asked again for this long. */
export const OFF_SECONDS = 60;
/** Each string of an attached session told to the assistant is at most this long (understanding.CONTEXT_TEXT_MAX). */
export const CONTEXT_TEXT_MAX = 200;

export type ChatStore = Pick<StorePort, "now" | "prefs" | "sessions" | "remoteState"> & {
  readonly links: Pick<StorePort["links"], "clawUserIdOf">;
};

/** The reply style's switches the assistant reads (style.py). */
export interface AssistantStyle {
  readonly assistantProgress: boolean;
  readonly assistantStreamSay: boolean;
}

export interface AssistantChatOptions {
  readonly store: ChatStore;
  readonly claw: {
    readonly assistant: Pick<ClawAssistantPort, "session" | "send">;
    readonly sessions: Pick<ClawSessionsPort, "turn" | "interrupt" | "stream" | "uploadFiles">;
  };
  /** Whether the person's subscription has the assistant's events (`Subscriptions.hasAssistantTypes`); undefined: no notifications. */
  readonly hasAssistantTypes: ((userId: string) => boolean) | undefined;
  readonly receipts: Receipts;
  readonly directChat: DirectChat;
  readonly clock: Clock;
  readonly random: Random;
  readonly logger: Logger;
  readonly stepLabel: StepLabel;
  readonly style: () => AssistantStyle;
  /** ASSISTANT_ENABLED. */
  readonly enabled: boolean;
  /** ASSISTANT_USERS, lower case (empty: everybody the switch is on for). */
  readonly users: ReadonlySet<string>;
  /** TEAMS_ASSISTANT_UNDERSTANDING_USERS, lower case (empty: nobody). */
  readonly understanding: ReadonlySet<string>;
  /** CLAW_PLUGIN_ID: named on each message; undefined for none. */
  readonly pluginId: number | undefined;
  /** A chat turn of the old kind is running for this person: it is let finish. */
  readonly legacyTurn: (userId: string) => boolean;
  readonly files: MessageFiles | undefined;
  readonly onFilesDropped: (path: string, count: number) => void;
  /** The locale of the client the message being handled came from ("" none). */
  readonly clientLocale?: () => string;
  /** `/board` (assistant.py `board`). */
  readonly board: { show(userId: string, credential: string, conversation: Conversation): Promise<void> };
  /** The router's reading of commands (commands.py parse_command, command_args). */
  readonly commands: {
    parse(text: string): string | undefined;
    args(text: string, name: string): string | undefined;
  };
}

/** Told (session id, message id; null when Claw queued it) once Claw has taken a message (the Stop card of a phone's message). */
export type OnSent = (sessionId: string, messageId: string | null) => void;

/** What a message to the assistant needs, beside its text. */
interface Handing {
  readonly userId: string;
  readonly credential: string;
  readonly conversation: Conversation;
  readonly lang: Lang;
  readonly onSent?: OnSent | undefined;
}

export class AssistantChat {
  private offUntil = 0;
  private readonly switched = new Set<string>();

  constructor(private readonly o: AssistantChatOptions) {}

  /** The assistant is on for this person: the switch is on, and they are listed (an empty list is everybody). */
  forUser(userId: string): boolean {
    return this.o.enabled && (this.o.users.size === 0 || this.o.users.has(userId.toLowerCase()));
  }

  /**
   * This person's 1:1 chat talks to the assistant: it is on for them, the assistant can reach them, Claw has an assistant, and no
   * turn of the old kind is still running for them.
   */
  on(userId: string): boolean {
    return (
      this.forUser(userId) &&
      this.reachable(userId) &&
      this.o.store.now() >= this.offUntil &&
      !this.o.legacyTurn(userId)
    );
  }

  /** Every 1:1 message of this person that is not an exact command goes to their assistant first. */
  understands(userId: string): boolean {
    return this.o.understanding.has(userId.toLowerCase()) && this.forUser(userId);
  }

  /** The assistant can answer this person: their subscription has its events and their Claw user id is known. */
  reachable(userId: string): boolean {
    return (
      this.o.hasAssistantTypes !== undefined &&
      this.o.hasAssistantTypes(userId) &&
      this.o.store.links.clawUserIdOf(userId) !== null
    );
  }

  forget(userId: string): void {
    this.switched.delete(userId);
  }

  /** What a message of files and no words says to the assistant. */
  filesOnly(lang: Lang): string {
    return assistantChatText.in(lang).filesOnly;
  }

  private langOf(userId: string, text: string): Lang {
    return answerLang(this.o.store.prefs.getPrefs(userId).lang, this.o.clientLocale?.() ?? "", text);
  }

  /**
   * A message of a person the assistant understands, with the chat's context. True when the assistant has it; otherwise the
   * person was told it could not be reached and nothing else was done with it.
   */
  async understand(request: {
    userId: string;
    credential: string;
    modelKey: string;
    prompt: string;
    context: JsonObject;
    lang: Lang;
    conversation: Conversation;
    files: readonly InboundFile[];
    onSent?: OnSent;
  }): Promise<boolean> {
    const notUnderstood = assistantChatText.in(request.lang).notUnderstood;
    if (!this.reachable(request.userId)) {
      this.o.logger.warn(
        "the assistant cannot answer a listed person yet (no subscription with its events, or no platform user id)",
      );
      await request.conversation.send(text(notUnderstood));
      return false;
    }
    const handing = { ...request };
    const sent = await this.handTo(handing, async (sessionId) => {
      const folderId =
        typeof request.context["channel_message_id"] === "string" ? request.context["channel_message_id"] : "";
      const context = request.files.length
        ? {
            ...request.context,
            files: await this.handOverFiles(handing, sessionId, folderId || this.o.random.hexId(), request.files),
          }
        : request.context;
      return this.o.claw.assistant.send(request.credential, sessionId, request.prompt, {
        ...(request.modelKey ? { modelKey: request.modelKey } : {}),
        context,
        ...(this.o.pluginId === undefined ? {} : { plugin: this.o.pluginId }),
      });
    });
    if (sent.ok) return true;
    const linkedKeyRefused = sent.error?.status === 401 || sent.error?.status === 403;
    await this.notTaken(
      request.conversation,
      linkedKeyRefused && request.credential.startsWith("ak-") ? assistantChatText.in("en").rejected : notUnderstood,
    );
    return false;
  }

  /**
   * A 1:1 message that is not a command. True: the assistant has it (or the person was told it could not be sent). False: it is
   * for a session, as before. `attached` (only where remote agents are on) is told as `channel_context.attached`.
   */
  async route(request: {
    userId: string;
    credential: string;
    prompt: string;
    conversation: Conversation;
    files: readonly InboundFile[];
    attached?: JsonObject | null;
    onSent?: OnSent;
  }): Promise<boolean> {
    if (!(await this.takes(request.userId, request.credential))) return false;
    return this.sayTo(request);
  }

  /**
   * Does this message go to the assistant? A person's first one does only when the session they had in Claw is not busy (that
   * work finishes where it started); after that it always does. A Claw that cannot say keeps the old path for now.
   */
  private async takes(userId: string, credential: string): Promise<boolean> {
    if (!this.on(userId)) return false;
    if (this.switched.has(userId)) return true;
    const earlier = this.o.store.sessions.getSession(userId);
    if (earlier) {
      try {
        if ((await this.o.claw.sessions.turn(credential, earlier)).running) return false;
      } catch (error) {
        const refused = refusal(error);
        if (!refused) {
          if (clawFailure(error)) return false;
          throw error;
        }
        if (refused.status !== 403 && refused.status !== 404) return false;
      }
    }
    this.switched.add(userId);
    return true;
  }

  /** Hand the message to the assistant and return: false when this Claw has no assistant (the caller carries on the old way). */
  private async sayTo(request: {
    userId: string;
    credential: string;
    prompt: string;
    conversation: Conversation;
    files: readonly InboundFile[];
    attached?: JsonObject | null;
    onSent?: OnSent;
  }): Promise<boolean> {
    const t = assistantChatText.in("en");
    let sessionId: string;
    try {
      sessionId = (await this.o.claw.assistant.session(request.credential)).sessionId;
    } catch (error) {
      if (!clawFailure(error)) throw error;
      const refused = refusal(error);
      if (refused?.status === 404) {
        this.o.logger.info("Claw has no assistant: chats use plain sessions for a while", { seconds: OFF_SECONDS });
        this.offUntil = this.o.store.now() + OFF_SECONDS;
        return false;
      }
      await request.conversation.send(
        text(refused && (refused.status === 401 || refused.status === 403) ? t.rejected : t.unavailable),
      );
      return true;
    }
    const handing = { ...request, lang: this.langOf(request.userId, request.prompt) };
    const sent = await this.handTo(
      handing,
      async () => {
        const files = request.files.length
          ? { files: await this.handOverFiles(handing, sessionId, this.o.random.hexId(), request.files) }
          : {};
        const attached = request.attached === undefined ? {} : { attached: attachedOf(request.attached) };
        const context = { ...files, ...attached };
        return this.o.claw.assistant.send(request.credential, sessionId, request.prompt, {
          ...(Object.keys(context).length ? { context } : {}),
          ...(this.o.pluginId === undefined ? {} : { plugin: this.o.pluginId }),
        });
      },
      sessionId,
    );
    if (!sent.ok) {
      const refused = sent.error;
      await this.notTaken(
        request.conversation,
        refused && (refused.status === 401 || refused.status === 403) ? t.rejected : t.unavailable,
      );
    }
    return true;
  }

  /**
   * Acknowledge the message (receipt or typing), follow its turn into the receipt, and send it with `send` (given the assistant's
   * session id). `ok` when the assistant has it; otherwise Claw's refusal (undefined when it did not answer).
   */
  private async handTo(
    handing: Handing,
    send: (sessionId: string) => Promise<string | null>,
    knownSession?: string,
  ): Promise<{ ok: true } | { ok: false; error: { status: number } | undefined }> {
    let follower: TurnFollower | undefined;
    let messageId: string | undefined;
    try {
      const sessionId = knownSession ?? (await this.o.claw.assistant.session(handing.credential)).sessionId;
      follower = this.follow(handing, sessionId, await this.acknowledge(handing));
      const sent = await send(sessionId);
      messageId = sent ?? undefined;
      this.tellSent(handing.onSent, sessionId, sent);
      return { ok: true };
    } catch (error) {
      if (!clawFailure(error)) throw error;
      const refused = refusal(error);
      this.o.logger.warn(
        "the assistant did not take a message",
        refused ? { status: refused.status } : { error: errorName(error) },
      );
      return { ok: false, error: refused ? { status: refused.status } : undefined };
    } finally {
      follower?.answers(messageId);
    }
  }

  /** Tell `onSent` that Claw took a message; what it does with that never fails the message. */
  private tellSent(onSent: OnSent | undefined, sessionId: string, messageId: string | null): void {
    if (onSent === undefined) return;
    try {
      onSent(sessionId, messageId);
    } catch (error) {
      this.o.logger.warn("what follows a message the assistant took failed", { error: errorName(error) });
    }
  }

  private handOverFiles(handing: Handing, sessionId: string, messageId: string, files: readonly InboundFile[]) {
    const folder = this.o.files?.uploadFolder(messageId) ?? `.uploads/${messageId}`;
    return handOver(
      { claw: this.o.claw.sessions, files: this.o.files, logger: this.o.logger, onDropped: this.o.onFilesDropped },
      { credential: handing.credential, sessionId, folder, files, conversation: handing.conversation },
    );
  }

  /** Follow the turn that answers this message into its receipt: undefined without a receipt or with progress off. */
  private follow(handing: Handing, sessionId: string, receipt: Receipt | undefined): TurnFollower | undefined {
    const style = this.o.style();
    if (receipt === undefined || !style.assistantProgress) return undefined;
    const follower = new TurnFollower({
      open: (after, signal) => this.o.claw.sessions.stream(handing.credential, sessionId, after, signal),
      receipt,
      lang: handing.lang,
      streamSay: style.assistantStreamSay,
      stepLabel: this.o.stepLabel,
      clock: this.o.clock,
      logger: this.o.logger,
    });
    follower.start();
    return follower;
  }

  /**
   * The person sees at once that their message was taken: the receipt under it, or (none can be opened) the typing indicator.
   * Never fails the message. In a chat that is an agent's window the receipt's words start with Clawy's head.
   */
  private async acknowledge(handing: Handing): Promise<Receipt | undefined> {
    const { conversation } = handing;
    try {
      const replyTo =
        typeof conversation.ref.wire["activityId"] === "string" ? conversation.ref.wire["activityId"] : "";
      const receipt = await this.o.receipts.openIn(
        conversation.ref.id,
        handing.lang,
        streamOpener(conversation, replyTo, this.o.clock),
      );
      if (receipt !== undefined) {
        receipt.head = this.o.directChat.clawyExtras(this.attachedReader(), handing.userId, handing.lang).head;
        return receipt;
      }
      await conversation.typing();
    } catch (error) {
      this.o.logger.warn("the receipt of a message to the assistant could not be shown", { error: errorName(error) });
    }
    return undefined;
  }

  private attachedReader() {
    return {
      remoteState: (userId: string) => {
        const state = this.o.store.remoteState.getRemote(userId);
        return state === null
          ? undefined
          : {
              sessionId: state.sessionId ?? "",
              agentLabel: state.agentLabel,
              host: state.host,
              agentId: state.agentId,
            };
      },
    };
  }

  /** The message did not reach the assistant: said in the receipt's place when one is open (it closes it), else as a message. */
  private async notTaken(conversation: Conversation, said: string): Promise<void> {
    const receipt = this.o.receipts.take(conversation.ref.id);
    if (receipt === undefined || !(await receipt.deliver(text(said)))) await conversation.send(text(said));
  }

  /**
   * What to say to `/new`, `/sessions` and `/repo`, which the assistant makes needless (it keeps one conversation and a task of its
   * own for each thing asked), in the chat's language (the router's `said_in`); undefined for anything else. Nothing is done.
   */
  hiddenCommand(said: string, lang: Lang): string | undefined {
    const t = commandText.in(lang);
    const command = this.o.commands.parse(said);
    if (command === "new" || command === "sessions") return t.assistantNoSessions;
    return this.o.commands.args(said, "repo") === undefined ? undefined : t.assistantNoRepo;
  }

  /** `/board`: the person's work items, and a card for each one that waits for them. */
  board(userId: string, credential: string, conversation: Conversation): Promise<void> {
    return this.o.board.show(userId, credential, conversation);
  }

  /**
   * `/stop`: interrupts what the assistant is doing this moment; a task is stopped by name. `onlyMessage`: interrupt only while
   * Claw's running turn answers that message (a Stop card's turn, read just before the interrupt goes); false, with nothing said
   * or interrupted, when it does not.
   */
  async stop(_userId: string, credential: string, conversation: Conversation, onlyMessage?: string): Promise<boolean> {
    const t = assistantChatText.in("en");
    let running: boolean;
    try {
      const { sessionId } = await this.o.claw.assistant.session(credential);
      const turn = await this.o.claw.sessions.turn(credential, sessionId);
      running = turn.running;
      if (onlyMessage !== undefined && !(running && turn.messageId === onlyMessage)) return false;
      if (running) await this.o.claw.sessions.interrupt(credential, sessionId);
    } catch (error) {
      if (!clawFailure(error)) throw error;
      await conversation.send(text(t.stopFailed));
      return true;
    }
    await conversation.send(text((running ? t.stopped : t.notBusy) + t.stopHint));
    return true;
  }
}

function text(said: string) {
  return { body: { type: "text" as const, text: said } };
}

/** The session a chat is attached to as the assistant is told it: its text and yes/no fields, each text clipped. */
export function attachedOf(attached: JsonObject | null): JsonObject | null {
  if (attached === null) return null;
  const kept: [string, string | boolean][] = [];
  for (const [key, value] of Object.entries(attached)) {
    if (typeof value === "string") kept.push([key, cpHead(value, CONTEXT_TEXT_MAX)]);
    else if (typeof value === "boolean") kept.push([key, value]);
  }
  return Object.fromEntries(kept);
}
