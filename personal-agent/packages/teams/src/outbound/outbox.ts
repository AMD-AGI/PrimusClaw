// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Where a conversation's outbound envelopes go: the outbound queue (a relay Function posts them) or the Bot Connector
 * directly. The envelope is the contract of the outbound queue, byte for byte the Python worker's:
 * `{"operation", "reference", "activity", ["activity_id"], ["ack"]}`.
 */
import type { JsonObject } from "../cards/json.js";

export type Operation = "send" | "reply" | "update" | "delete";

/** One outbound envelope. `reference` is the conversation reference (`activity.referenceOf`), `activity` the message. */
export interface TeamsEnvelope extends JsonObject {
  operation: Operation;
  reference: JsonObject;
  activity: JsonObject;
  activity_id?: string;
  ack?: string;
}

/** What an outbox that posts to Teams itself returns: the id Teams gave the message (undefined when it gave none). */
export interface Delivered {
  readonly activityId: string | undefined;
}

/**
 * A message could not be deleted: only a direct send to the Bot Connector can delete one (the relay Function's contract
 * is send, reply and update), so the queue, or a direct delete that Teams refused, ends here.
 */
export class DeleteUnsupportedError extends Error {
  override name = "DeleteUnsupportedError";
}

/** The bot's 1:1 conversation with a user could not be created; the message is the reason (a status), never a body. */
export class ConversationNotOpenedError extends Error {
  override name = "ConversationNotOpenedError";
}

/**
 * A request of a Teams stream was not taken: Teams refused it (`status`, and its error code such as
 * ContentStreamNotAllowed), nothing answered (status 0), or this outbox cannot stream at all (the queue).
 */
export class StreamRefusedError extends Error {
  override name = "StreamRefusedError";
  constructor(
    reason: string,
    readonly status = 0,
    readonly code = "",
  ) {
    super(reason);
  }
}

/** The members of a group chat as the Bot Connector lists them (`id`, `name`, `objectId`, `givenName`, ...). */
export type ConnectorMember = JsonObject;

export interface PublishOptions {
  /**
   * The caller no longer wants it sent (its turn was cancelled): checked after any wait for the conversation's turn and
   * before the request goes out; an aborted publish rejects with the signal's reason and sends nothing.
   */
  readonly signal?: AbortSignal | undefined;
}

export interface Outbox {
  /**
   * Hand one envelope to Teams. Delivered: it is posted. undefined: it is on the outbound queue, and an ack, if the
   * envelope asked for one, follows from the relay. A `delete` is either delivered or throws DeleteUnsupportedError.
   */
  publish(envelope: TeamsEnvelope, options?: PublishOptions): Promise<Delivered | undefined>;
  close(): Promise<void>;
}

/** An outbox that posts to the Bot Connector itself (direct mode): the only one that can stream, open a 1:1 chat, list members. */
export interface DirectOutbox extends Outbox {
  /**
   * One request of a Teams stream, sent once, directly. Throws StreamRefusedError when it was not taken; once
   * `options.signal` aborts (the stream was dropped), it rejects with the signal's reason and leaves nothing waiting.
   */
  publishStream(envelope: TeamsEnvelope, options?: PublishOptions): Promise<Delivered>;
  /** The bot's 1:1 conversation id with `userId`; throws ConversationNotOpenedError. */
  openPersonal(serviceUrl: string, userId: string, tenantId: string, botId: string): Promise<string>;
  /** The members of a group chat; throws when Teams did not answer. */
  listMembers(serviceUrl: string, conversationId: string): Promise<ConnectorMember[]>;
}

export function isDirect(outbox: Outbox): outbox is DirectOutbox {
  return "publishStream" in outbox && typeof (outbox as Partial<DirectOutbox>).publishStream === "function";
}
