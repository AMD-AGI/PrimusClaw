// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Core's `Surface` on Microsoft Teams: one `TeamsConversation` per conversation reference (masked in a group chat or a
 * channel, where every member sees what is posted), the files a person sent, and the two things only a direct outbox can do:
 * opening the bot's 1:1 chat with someone and reading a group chat's roster.
 */
import type {
  Clock,
  Conversation,
  ConversationRef,
  FetchedFile,
  FileRefused,
  InboundFile,
  Logger,
  Random,
  Result,
  RosterMember,
  Surface,
  SurfaceCaps,
} from "@primusclaw/personal-agent";
import { errorName, silentLogger } from "@primusclaw/personal-agent";

import { teamsCaps, type OutboundMode } from "./caps.js";
import { isObject, type JsonObject } from "./cards/json.js";
import type { Style } from "./config/style.js";
import type { AckRegistry } from "./messenger/acks.js";
import { TeamsConversation } from "./messenger/conversation.js";
import type { Masker } from "./messenger/masker.js";
import { isDirect, type ConnectorMember, type Outbox } from "./outbound/outbox.js";
import { BusyConversations } from "./stream/busy.js";
import type { Renderers } from "./views/registry.js";

/** What fetches a person's files (`inbound/fetcher.ts`). */
export interface FileFetcher {
  fetchFile(file: InboundFile): Promise<Result<FetchedFile, FileRefused>>;
}

export interface TeamsSurfaceParts {
  readonly mode: OutboundMode;
  readonly outbox: Outbox;
  readonly acks: AckRegistry;
  readonly clock: Clock;
  readonly random: Random;
  readonly style: Style;
  readonly renderers: Renderers;
  /** How a group chat's messages are masked (core's credential rules). */
  readonly masker: Masker;
  readonly files: FileFetcher;
  readonly ackTimeoutMs?: number;
  readonly logger?: Logger;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A member as the Bot Connector lists it, in core's words ("" for what it does not give). */
export function rosterMember(member: ConnectorMember): RosterMember {
  return {
    channelUserId: text(member["id"]),
    userId: text(member["objectId"]),
    name: text(member["name"]),
    givenName: text(member["givenName"]),
    surname: text(member["surname"]),
    email: text(member["email"]),
    userPrincipalName: text(member["userPrincipalName"]),
  };
}

export class TeamsSurface implements Surface {
  readonly caps: SurfaceCaps;
  private readonly busy: BusyConversations;
  private readonly logger: Logger;

  constructor(private readonly parts: TeamsSurfaceParts) {
    this.caps = teamsCaps(parts.mode);
    this.busy = new BusyConversations(parts.clock);
    this.logger = parts.logger ?? silentLogger;
  }

  conversation(ref: ConversationRef): Conversation {
    const { parts } = this;
    return new TeamsConversation({
      ref,
      caps: this.caps,
      outbox: parts.outbox,
      acks: parts.acks,
      clock: parts.clock,
      random: parts.random,
      render: {
        style: parts.style,
        renderers: parts.renderers,
        masker: ref.kind === "personal" ? undefined : parts.masker,
      },
      stream: { style: parts.style, clock: parts.clock, busy: this.busy, logger: this.logger },
      logger: this.logger,
      ...(parts.ackTimeoutMs === undefined ? {} : { ackTimeoutMs: parts.ackTimeoutMs }),
    });
  }

  fetchFile(file: InboundFile): Promise<Result<FetchedFile, FileRefused>> {
    return this.parts.files.fetchFile(file);
  }

  async openPersonal(
    via: ConversationRef,
    user: { readonly channelUserId: string; readonly userId: string },
  ): Promise<Conversation | undefined> {
    const outbox = this.parts.outbox;
    const serviceUrl = text(via.wire["serviceUrl"]);
    const bot = via.wire["bot"];
    const botId = isObject(bot) ? text(bot["id"]) : "";
    if (!isDirect(outbox) || !(user.channelUserId && serviceUrl && via.tenantId && botId)) return undefined;
    try {
      const id = await outbox.openPersonal(serviceUrl, user.channelUserId, via.tenantId, botId);
      const wire: JsonObject = {
        serviceUrl,
        bot: { id: botId },
        user: { id: user.channelUserId, aadObjectId: user.userId },
        conversation: { id, conversationType: "personal", tenantId: via.tenantId },
      };
      const channelId = via.wire["channelId"];
      if (typeof channelId === "string" && channelId) wire["channelId"] = channelId;
      return this.conversation({ id, kind: "personal", tenantId: via.tenantId, wire });
    } catch (error) {
      this.logger.warn("a 1:1 chat could not be opened", { error: errorName(error) });
      return undefined;
    }
  }

  async members(conversation: ConversationRef): Promise<readonly RosterMember[] | undefined> {
    const outbox = this.parts.outbox;
    const serviceUrl = text(conversation.wire["serviceUrl"]);
    if (!isDirect(outbox) || !serviceUrl || !conversation.id) return undefined;
    try {
      return (await outbox.listMembers(serviceUrl, conversation.id)).map(rosterMember);
    } catch (error) {
      this.logger.warn("a group chat's members could not be read", { error: errorName(error) });
      return undefined;
    }
  }
}
