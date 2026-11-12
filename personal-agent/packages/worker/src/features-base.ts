// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the features behind the router are built from (the process's ports and settings), and the hooks into the router a
 * feature needs once the router exists: the router is built from the features, and some features call back into it.
 */
import type {
  ClawPort,
  ConversationKind,
  ConversationRef,
  InboundMessage,
  JsonObject,
  Clock,
  Logger,
  MetricsPort,
  Plugins,
  Random,
  RequestScope,
  SecurityLog,
  Settings,
  Surface,
  TokenExchange,
} from "@primusclaw/personal-agent";
import type { ChatLog, SqliteStore } from "@primusclaw/personal-agent-runtime";

/**
 * How replies look on the surface: the switches of its reply style that the features read (the surface reads the rest,
 * such as Teams' AI label, itself). Each is the surface's own setting; a surface that has no such thing turns it off.
 */
export interface ReplyStyle {
  /** The agent's visible text is streamed into the answer while a turn runs. */
  readonly streamText: boolean;
  /** The assistant's receipt, its live steps and its streamed words. */
  readonly assistantReceipt: boolean;
  readonly assistantProgress: boolean;
  readonly assistantStreamSay: boolean;
  /** An answer carries the worker's own thumbs on phones (the router's `ownThumbsMobile`). */
  readonly ownThumbsMobile: boolean;
  readonly suggestedReplies: boolean;
  readonly citations: boolean;
  /** Whether a turn shows the surface's live status in this kind of chat. */
  streamsIn(kind: ConversationKind): boolean;
}

/** What the features read of the surface besides its port: its reply style, how a stored reference is read back, its words. */
export interface SurfaceShape {
  readonly style: ReplyStyle;
  /**
   * Where a person who has not added the bot yet can add it (a link the surface's people can open; "" for none): what a
   * colleague asked to review is pointed at.
   */
  readonly installHintUrl: string;
  /** A stored conversation reference back as core's `ConversationRef`; undefined when it names none. Never throws. */
  restoreRef(stored: JsonObject): ConversationRef | undefined;
  /** A stored reference as the surface posts to it: one that names no conversation still gets one (its send then fails). */
  refOf(stored: JsonObject): ConversationRef;
  /**
   * The surface's fields a followed review keeps to open the reviewer's chat again after a restart, from the chat the
   * review was asked in (Teams: service_url, tenant, bot_id).
   */
  followWire(asked: ConversationRef): Readonly<Record<string, string>>;
  /** The surface's name as people know it ("Teams"): what a report's words and an unreadable file's line call it. */
  readonly channelName: string;
  /** The build the worker runs (the surface package's version): what a report names. */
  readonly version: string;
}

export interface AssemblyBase {
  /** Core's settings (`readSettings`). */
  readonly settings: Settings;
  /** What the features read of the surface besides its port (`SurfaceShape`). */
  readonly shape: SurfaceShape;
  readonly store: SqliteStore;
  readonly claw: ClawPort;
  /** The channel (the worker's surface, such as Teams'; a test's fake surface). */
  readonly surface: Surface;
  readonly clock: Clock;
  readonly random: Random;
  readonly logger: Logger;
  /** What the platform and GitHub clients send with (the global `fetch`; a test's fake). */
  readonly fetch: typeof fetch;
  readonly metrics: MetricsPort;
  readonly securityLog: SecurityLog;
  /** The one request scope (runtime `alsRequestScope`): the router enters it per inbound event, everything else reads it. */
  readonly requestScope: RequestScope;
  /** The last log lines of each chat, for a report's scene (Python `feedback.LogBuffer`). */
  readonly chatLog: ChatLog;
  readonly plugins: Plugins;
  readonly exchange: TokenExchange;
  /** The switches the Python worker's `main.py` read from the environment itself (`features-switches.ts`). */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** What the features ask of the router, bound once it is built (a call before then is a defect of the assembly). */
export interface RouterHooks {
  /** A chat turn of the old kind is running in the person's 1:1 chat (`Router.hasPersonalTurn`). */
  legacyTurn(userId: string): boolean;
  /** A work item was stopped from its card: whatever follows it here ends as stopped (`Agent._item_stopped`). */
  itemStopped(itemId: string): void;
  /** The person pressed Deny on an approval of the chat's running turn (`turn.tool_denied`). */
  toolDenied(userId: string, scope: string): void;
  /** `text` carried out exactly as typed, with `key`, in `conversation` (`Agent._command`). */
  runCommand(text: string, sender: SenderOf, conversation: ConversationOf, key: string): Promise<boolean>;
  /** What reads Claw for a person with nobody to ask (`Agent._background_credential`); undefined: none. */
  background(userId: string): Promise<string | undefined>;
  /** `message` handled as one the person typed (`Router.handle`): what a choice card's Send sends. */
  typed(message: InboundMessage): Promise<void>;
}

type SenderOf = Parameters<import("@primusclaw/personal-agent").Router["chat"]>[0];
type ConversationOf = Parameters<import("@primusclaw/personal-agent").Router["chat"]>[1];
