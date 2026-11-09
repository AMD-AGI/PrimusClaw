// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Core's `LiveStream` on Teams: a `TeamsStream` in reply to the person's message, opened where the reply style has streams
 * on for this kind of chat, there is a message to reply to, and no other stream may still be open in the conversation.
 * Everything Teams does not take comes back as `StreamRefused`; the caller then shows the same thing without a stream.
 */
import type {
  Clock,
  ConversationRef,
  LiveStream,
  Logger,
  OutMessage,
  Result,
  StreamRefused,
} from "@primusclaw/personal-agent";
import { err, ok } from "@primusclaw/personal-agent";

import { isObject, type JsonObject } from "../cards/json.js";
import { streamsIn, type Style } from "../config/style.js";
import { StreamRefusedError } from "../outbound/outbox.js";
import type { BusyConversations } from "./busy.js";
import { informativeText } from "./informative.js";
import { TeamsStream, type StreamPoster } from "./teams-stream.js";

export interface StreamContext {
  readonly style: Style;
  readonly clock: Clock;
  readonly busy: BusyConversations;
  readonly logger?: Logger;
}

export interface StreamRequest {
  readonly ref: ConversationRef;
  readonly replyTo: string;
  readonly status: string;
  readonly post: StreamPoster;
  readonly render: (message: OutMessage) => JsonObject;
}

function refused(reason: string, status = 0, code = ""): StreamRefused {
  return { kind: "stream_refused", reason, status, code };
}

function asRefusal(error: unknown): StreamRefused {
  if (error instanceof StreamRefusedError) return refused(error.message, error.status, error.code);
  throw error;
}

async function attempt(work: () => Promise<void>): Promise<Result<void, StreamRefused>> {
  try {
    await work();
    return ok(undefined);
  } catch (error) {
    return err(asRefusal(error));
  }
}

/** The Teams conversation type ("personal", "groupChat", "channel") the reference names. */
function conversationOf(ref: ConversationRef): { readonly id: string; readonly type: string } {
  const conversation = ref.wire["conversation"];
  if (!isObject(conversation)) return { id: "", type: "" };
  const id = conversation["id"];
  const type = conversation["conversationType"];
  return { id: typeof id === "string" ? id : "", type: typeof type === "string" ? type : "" };
}

class TeamsLiveStream implements LiveStream {
  constructor(
    private readonly stream: TeamsStream,
    private readonly render: (message: OutMessage) => JsonObject,
  ) {}

  inform(text: string): Promise<Result<void, StreamRefused>> {
    return attempt(() => this.stream.inform(informativeText([text])));
  }

  emit(text: string): Promise<Result<void, StreamRefused>> {
    return attempt(() => this.stream.emit(text));
  }

  finish(message: OutMessage): Promise<Result<void, StreamRefused>> {
    return attempt(() => this.stream.final(this.render(message)));
  }
}

/** A stream in reply to `request.replyTo`, opened with `request.status`; refused where streams are not used or not taken. */
export async function openStream(
  context: StreamContext,
  request: StreamRequest,
): Promise<Result<LiveStream, StreamRefused>> {
  const conversation = conversationOf(request.ref);
  if (!streamsIn(context.style, conversation.type)) return err(refused("streams are off for this kind of chat"));
  if (!request.replyTo || !conversation.id) return err(refused("no message to reply to"));
  if (context.busy.isBusy(conversation.id)) return err(refused("a stream may still be open in this conversation"));
  const stream = new TeamsStream({
    post: request.post,
    conversation: conversation.id,
    replyTo: request.replyTo,
    clock: context.clock,
    busy: context.busy,
    ...(context.logger ? { logger: context.logger } : {}),
  });
  const started = await attempt(() => stream.start(informativeText([request.status])));
  return started.ok ? ok(new TeamsLiveStream(stream, request.render)) : started;
}
