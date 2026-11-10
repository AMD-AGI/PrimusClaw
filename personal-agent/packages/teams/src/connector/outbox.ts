// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Direct delivery to the Bot Connector, with the outbound queue (the relay Function) as the fallback.
 *
 * - Order: one conversation's sends are serialised in this process, first come first sent, and a retry holds the line.
 * - Nothing is lost: a send Teams does not take (token unavailable, retries or the overall deadline used up, a refusal,
 *   an address the policy refuses) is handed to the queue, and the conversation stays on the queue until it has been
 *   quiet for `queueStickyMs`, so a later message cannot overtake one the relay is still delivering.
 * - At least once: a request that timed out or was answered with a 5xx may have reached Teams; the retry or the queue
 *   hand-off can then post the message twice.
 * - A delete is never handed to the queue (the relay has no delete): one Teams does not take throws DeleteUnsupportedError.
 *
 * Secrets and bodies are never logged: one line per send with the operation, status and latency.
 */
import { pyStr, silentLogger, type Clock, type Logger } from "@primusclaw/personal-agent";
import { plainDecorations } from "../activity/decorations.js";
import { isObject, type JsonObject } from "../cards/json.js";
import {
  ConversationNotOpenedError,
  DeleteUnsupportedError,
  StreamRefusedError,
  type ConnectorMember,
  type Delivered,
  type DirectOutbox,
  type Outbox,
  type PublishOptions,
  type TeamsEnvelope,
} from "../outbound/outbox.js";
import { DeadlineError, TokenError, UnaddressableError, UndeliverableError } from "./errors.js";
import { DEFAULT_CONNECTOR_HOSTS, type ServiceUrlPolicy } from "./hosts.js";
import { Lanes } from "./lanes.js";
import { DEFAULT_LIMITS, type ConnectorLimits } from "./limits.js";
import { buildCreateConversation, buildListMembers, buildRequest, type ConnectorRequest } from "./request.js";
import { memberList } from "./response.js";
import { ConnectorClient, type Answer, type Sleep } from "./retry.js";
import { raceAbort, reasonOf, startTimer } from "./timer.js";
import type { TokenSource } from "./tokens/cached.js";

export interface ConnectorOutboxOptions {
  /** The bot's token source (IMDS or federated); it also fetches what a user attached. */
  readonly tokens: TokenSource;
  /** The outbound queue: where a send Teams did not take goes. Closed by whoever made it. */
  readonly fallback: Outbox;
  readonly clock: Clock;
  readonly fetch?: typeof fetch;
  /** The backoff wait; default `clock.sleep`. */
  readonly sleep?: Sleep;
  readonly logger?: Logger;
  /** Where the bot's token may go; default Microsoft's Bot Connector hosts (the release gate injects its own). */
  readonly policy?: ServiceUrlPolicy;
  /** The activity without its reply-style extras, for a second try after a 400 (default `plainDecorations`). */
  readonly plain?: (activity: JsonObject) => JsonObject | undefined;
  readonly limits?: Partial<ConnectorLimits>;
}

/** What one envelope is, for the log and the lanes. */
interface Described {
  readonly operation: string;
  readonly kind: string;
  readonly key: string;
}

function describe(envelope: JsonObject): Described {
  const activity = isObject(envelope["activity"]) ? envelope["activity"] : {};
  const reference = isObject(envelope["reference"]) ? envelope["reference"] : {};
  const conversation = isObject(reference["conversation"]) ? reference["conversation"] : {};
  return {
    operation: pyStr(envelope["operation"]) || "send",
    kind: pyStr(activity["type"]) || "message",
    key: pyStr(conversation["id"]),
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw reasonOf(signal);
}

export class ConnectorOutbox implements DirectOutbox {
  private readonly fallback: Outbox;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly policy: ServiceUrlPolicy;
  private readonly plain: (activity: JsonObject) => JsonObject | undefined;
  private readonly limits: ConnectorLimits;
  private readonly client: ConnectorClient;
  private readonly lanes = new Lanes();
  /** conversation -> until when (monotonic ms) its sends go to the queue. */
  private readonly onQueueUntil = new Map<string, number>();

  constructor(private readonly options: ConnectorOutboxOptions) {
    this.fallback = options.fallback;
    this.clock = options.clock;
    this.logger = options.logger ?? silentLogger;
    this.policy = options.policy ?? DEFAULT_CONNECTOR_HOSTS;
    this.plain = options.plain ?? plainDecorations;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    const clock = options.clock;
    this.client = new ConnectorClient({
      tokens: options.tokens,
      fetch: options.fetch ?? globalThis.fetch,
      clock,
      sleep: options.sleep ?? ((ms, signal) => clock.sleep(ms, signal)),
      logger: this.logger,
      limits: this.limits,
    });
  }

  /** The bot's token source, which also fetches what a user attached. */
  get tokens(): TokenSource {
    return this.options.tokens;
  }

  /** How many conversations hold or wait for their line just now (0 once every send is over). */
  get lanesInUse(): number {
    return this.lanes.size;
  }

  /**
   * Deliver one envelope to Teams. Delivered: Teams has it. undefined: the queue has it (or, for a typing indicator that
   * could not be sent, it was dropped: nobody waits for one). An aborted `options.signal` sends nothing more and
   * rejects with its reason: no retry, no queue.
   */
  async publish(envelope: TeamsEnvelope, options: PublishOptions = {}): Promise<Delivered | undefined> {
    const described = describe(envelope);
    const started = this.clock.monotonicMs();
    const answer = await this.lanes.hold(
      described.key,
      async (): Promise<Answer | Delivered | undefined> => {
        throwIfAborted(options.signal);
        if (this.queuedFor(described.key) > 0) return this.whileOnQueue(envelope, described, options);
        return this.direct(envelope, described, started, options);
      },
      options.signal,
    );
    if (answer === undefined || !("status" in answer)) return answer;
    this.logger.info("direct send delivered", {
      operation: described.operation,
      kind: described.kind,
      status: answer.status,
      attempts: answer.attempts,
      tookMs: this.clock.monotonicMs() - started,
      activityId: answer.id ?? "-",
    });
    return { activityId: answer.id };
  }

  private async whileOnQueue(
    envelope: TeamsEnvelope,
    described: Described,
    options: PublishOptions,
  ): Promise<Delivered | undefined> {
    const { operation, kind, key } = described;
    this.logger.info("direct send skipped: the conversation stays on the queue", {
      operation,
      kind,
      leftMs: this.queuedFor(key),
    });
    if (operation === "delete") {
      // the queue cannot delete, and a delete must not restart the window
      throw new DeleteUnsupportedError("the conversation is on the queue, which cannot delete a message");
    }
    // the window restarts: it ends after a quiet spell, not a fixed time after the first fallback
    if (kind !== "typing") this.stayOnQueue(key);
    return this.fallback.publish(envelope, options);
  }

  private async direct(
    envelope: TeamsEnvelope,
    described: Described,
    started: number,
    options: PublishOptions,
  ): Promise<Answer | Delivered | undefined> {
    let current = envelope;
    try {
      try {
        return await this.deliver(current, described.kind === "typing", options.signal);
      } catch (error) {
        const plain = this.plainRetry(error, current);
        if (plain === undefined) throw error;
        // Teams refused the activity with its reply-style extras (the AI label's root entity, citations, suggested
        // replies): the same message once more without them, so the user still gets it.
        this.logger.warn("direct send refused, sending it again without the AI label and suggested replies", {
          operation: described.operation,
          kind: described.kind,
          reason: (error as Error).message,
        });
        current = plain;
        return await this.deliver(current, false, options.signal);
      }
    } catch (error) {
      throwIfAborted(options.signal);
      return this.notDelivered(error, current, described, started, options);
    }
  }

  private plainRetry(error: unknown, envelope: TeamsEnvelope): TeamsEnvelope | undefined {
    if (!(error instanceof UndeliverableError) || error.status !== 400) return undefined;
    const activity = envelope.activity;
    const plain = isObject(activity) ? this.plain(activity) : undefined;
    return plain === undefined ? undefined : { ...envelope, activity: plain };
  }

  private async notDelivered(
    error: unknown,
    envelope: TeamsEnvelope,
    described: Described,
    started: number,
    options: PublishOptions,
  ): Promise<Delivered | undefined> {
    if (!(error instanceof UndeliverableError || error instanceof UnaddressableError)) throw error;
    const { operation, kind, key } = described;
    const fields = {
      operation,
      kind,
      reason: error.message,
      attempts: error instanceof UndeliverableError ? error.attempts : 0,
      tookMs: this.clock.monotonicMs() - started,
    };
    if (operation === "delete") {
      // the relay Function has no delete: never handed to the queue
      this.logger.warn("direct delete not delivered", fields);
      throw new DeleteUnsupportedError(`Teams did not take the delete (${error.message})`, { cause: error });
    }
    if (kind === "typing") {
      // not worth a retry or a trip through the queue
      this.logger.warn("direct typing dropped", fields);
      return undefined;
    }
    this.logger.warn("direct send not delivered, handing it to the queue", fields);
    this.stayOnQueue(key);
    return this.fallback.publish(envelope, options);
  }

  /** The whole of one send is bounded: a server that answers slowly, or a token source that hangs, cannot hold the line. */
  private async deliver(envelope: TeamsEnvelope, typing: boolean, signal: AbortSignal | undefined): Promise<Answer> {
    const { limits } = this;
    const progress = { attempts: 0 };
    const budget = typing ? limits.typingTimeoutMs : limits.sendDeadlineMs;
    const timer = startTimer(this.clock, budget, "the overall deadline passed", signal);
    try {
      const request = buildRequest(envelope, this.policy);
      return await raceAbort(
        timer.signal,
        this.client.execute(request, {
          maxAttempts: typing ? 1 : limits.maxAttempts,
          timeoutMs: typing ? limits.typingTimeoutMs : limits.requestTimeoutMs,
          budgetMs: limits.sendDeadlineMs,
          deadline: timer.signal,
          cancel: signal,
          progress,
        }),
      );
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof DeadlineError) {
        throw new UndeliverableError("the overall deadline passed", { attempts: progress.attempts });
      }
      throw error;
    } finally {
      timer.dispose();
    }
  }

  /** Whatever goes to the queue keeps its conversation there for `queueStickyMs` more. */
  private stayOnQueue(key: string): void {
    const now = this.clock.monotonicMs();
    this.onQueueUntil.set(key, now + this.limits.queueStickyMs);
    for (const [other, until] of this.onQueueUntil) {
      if (until <= now) this.onQueueUntil.delete(other);
    }
  }

  /** Milliseconds the conversation stays on the queue (0 or less: it does not). */
  private queuedFor(key: string): number {
    return (this.onQueueUntil.get(key) ?? 0) - this.clock.monotonicMs();
  }

  /**
   * One request of a Teams stream: sent once, directly, in the conversation's order, never handed to the queue (the
   * relay cannot carry a stream, and a retry would break the stream's one-request-a-second limit). Throws
   * StreamRefusedError when Teams did not take it, or when the conversation is on the queue just now.
   */
  async publishStream(envelope: TeamsEnvelope, options: PublishOptions = {}): Promise<Delivered> {
    const { kind, key } = describe(envelope);
    const { signal } = options;
    const started = this.clock.monotonicMs();
    const answer = await this.lanes.hold(
      key,
      async () => {
        throwIfAborted(signal);
        if (this.queuedFor(key) > 0) throw new StreamRefusedError("the conversation is on the queue");
        try {
          const request = buildRequestLazily(envelope, this.policy);
          return await this.once(request, this.limits.requestTimeoutMs, 1, "send", signal);
        } catch (error) {
          throwIfAborted(signal); // (dropped: the caller's reason, not a refusal)
          throw this.streamRefused(error, kind, started);
        }
      },
      signal,
    );
    this.logger.info("direct stream delivered", {
      kind,
      status: answer.status,
      tookMs: this.clock.monotonicMs() - started,
      activityId: answer.id ?? "-",
    });
    return { activityId: answer.id };
  }

  private streamRefused(error: unknown, kind: string, started: number): unknown {
    const tookMs = this.clock.monotonicMs() - started;
    if (error instanceof UndeliverableError) {
      this.logger.warn("direct stream refused", { kind, reason: error.message, tookMs });
      return new StreamRefusedError(error.message, error.status, error.code);
    }
    if (error instanceof DeadlineError || error instanceof UnaddressableError) {
      this.logger.warn("direct stream not sent", { kind, reason: error.name, tookMs });
      return new StreamRefusedError(error.name);
    }
    return error;
  }

  /**
   * `request` (built inside the deadline) with up to `attempts` tries under one overall deadline: the stream's
   * (`send`, the send deadline) or createConversation's (`open`). Throws UndeliverableError or DeadlineError.
   */
  private async once(
    request: () => ConnectorRequest,
    timeoutMs: number,
    attempts: number,
    budget: "send" | "open",
    cancel?: AbortSignal,
  ): Promise<Answer> {
    const budgetMs = budget === "send" ? this.limits.sendDeadlineMs : this.limits.openDeadlineMs;
    const timer = startTimer(this.clock, budgetMs, "the overall deadline passed", cancel);
    try {
      const built = request();
      const progress = { attempts: 0 };
      const options = { maxAttempts: attempts, timeoutMs, budgetMs, deadline: timer.signal, cancel, progress };
      return await raceAbort(timer.signal, this.client.execute(built, options));
    } finally {
      timer.dispose();
    }
  }

  /**
   * The bot's 1:1 conversation with `userId` (a `29:` id from a group activity), created if it does not exist yet.
   * Throws ConversationNotOpenedError, with the status Teams answered (never a body). There is no queue fallback.
   */
  async openPersonal(serviceUrl: string, userId: string, tenantId: string, botId: string): Promise<string> {
    const started = this.clock.monotonicMs();
    const { limits, policy } = this;
    let answer: Answer;
    try {
      const request = buildCreateConversation(serviceUrl, userId, tenantId, botId, policy);
      answer = await this.once(() => request, limits.openRequestTimeoutMs, limits.openAttempts, "open");
    } catch (error) {
      throw this.notOpened(error, started);
    }
    if (!answer.id) {
      this.logger.warn("direct createConversation answered without a conversation id", { status: answer.status });
      throw new ConversationNotOpenedError(`status ${String(answer.status)} without a conversation id`);
    }
    this.logger.info("direct createConversation delivered", {
      status: answer.status,
      attempts: answer.attempts,
      tookMs: this.clock.monotonicMs() - started,
    });
    return answer.id;
  }

  private notOpened(error: unknown, started: number): unknown {
    if (error instanceof UnaddressableError) {
      this.logger.warn("direct createConversation not attempted", { reason: error.message });
      return new ConversationNotOpenedError(error.message, { cause: error });
    }
    if (!(error instanceof UndeliverableError || error instanceof DeadlineError)) return error;
    const reason = error instanceof UndeliverableError ? error.message : "the overall deadline passed";
    this.logger.warn("direct createConversation failed", { reason, tookMs: this.clock.monotonicMs() - started });
    return new ConversationNotOpenedError(reason, { cause: error });
  }

  /**
   * The members of a group chat the bot is in, each as the Bot Connector gives it. One request and one retry on a
   * rejected token. Throws UnaddressableError for an address the policy refuses and UndeliverableError when Teams did
   * not answer. There is no queue fallback.
   */
  async listMembers(serviceUrl: string, conversationId: string): Promise<ConnectorMember[]> {
    const request = buildListMembers(serviceUrl, conversationId, this.policy);
    for (let refreshed = false; ; refreshed = true) {
      let token: string;
      try {
        token = await this.options.tokens.get();
      } catch (error) {
        if (error instanceof TokenError) throw new UndeliverableError(`token: ${error.message}`, { cause: error });
        throw error;
      }
      const exchange = await this.client.send(request, token, this.limits.openRequestTimeoutMs);
      if ("network" in exchange) throw new UndeliverableError(exchange.network);
      if (exchange.status === 401 && !refreshed) {
        this.options.tokens.invalidate(token);
        continue;
      }
      if (exchange.status !== 200) throw new UndeliverableError(`status ${String(exchange.status)}`);
      const members = memberList(exchange.text);
      if (members === undefined) throw new UndeliverableError("the member list is not JSON");
      return members;
    }
  }

  /** Closes the token source; the fallback outbox is closed by whoever made it. */
  async close(): Promise<void> {
    await this.options.tokens.close();
  }
}

function buildRequestLazily(envelope: JsonObject, policy: ServiceUrlPolicy): () => ConnectorRequest {
  return () => buildRequest(envelope, policy);
}
