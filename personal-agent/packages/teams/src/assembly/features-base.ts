// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the features behind the router are built from (the process's ports and settings), and the hooks into the router a
 * feature needs once the router exists: the router is built from the features, and some features call back into it.
 */
import type {
  ClawPort,
  InboundMessage,
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

import type { TeamsSettings } from "../config/env.js";

export interface AssemblyBase {
  /** Core's settings (`readSettings`). */
  readonly settings: Settings;
  readonly teams: TeamsSettings;
  readonly store: SqliteStore;
  readonly claw: ClawPort;
  /** The channel (the worker's `TeamsSurface`; a test's fake surface). */
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

/** The Teams style's reading of a conversation kind (`style.streams_in`'s conversation types). */
export function conversationTypeOf(kind: string): string {
  if (kind === "personal") return "personal";
  return kind === "group" ? "groupChat" : "channel";
}
