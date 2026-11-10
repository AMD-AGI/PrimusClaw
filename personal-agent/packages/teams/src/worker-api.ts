// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker process, as an assembly can build it: the public `main` builds it with the neutral plugins, a deployment's
 * own `main` (with its identity platform, model gateway rules, extra routes) builds it with its plugins. Everything else
 * (store, Claw client, Teams outbound, inbound queue, HTTP endpoints) is assembled from the environment the same way for
 * both.
 */
import type { Clock, ConversationRef, Logger, MessageId, Plugins } from "@primusclaw/personal-agent";

/** The environment the worker reads its settings from (`process.env`, or a copy a test or a gate made). */
export type WorkerEnv = Readonly<Record<string, string | undefined>>;

export interface WorkerOptions {
  /** Defaults: the system clock, a line logger on stderr, the global `fetch`. */
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly fetch?: typeof fetch;
}

/** A built worker: nothing runs until `run`. */
export interface Worker {
  /**
   * Start every part (HTTP endpoints, the inbound consumer or the gate's test entry, the timers) and resolve when the
   * worker has stopped: after `stop`, or when a part fails (the promise rejects then).
   */
  run(): Promise<void>;
  /** Stop taking new work, finish what is in hand, close connections. */
  stop(): Promise<void>;
}

/**
 * What a deployment's plugins may use of the worker they are built for (what the Python worker's on-behalf route used of
 * its `Agent`). A person is named by the store's user id: their directory id (Teams: the Entra object id). `post` and the
 * store reads work as soon as the plugins are built; `handleAsTyped` and `spawn` work once the worker is assembled (before
 * then they throw: a plugin calls them from a request, never while it is built).
 */
export interface WorkerServices {
  /** The people whose link recorded Claw user `clawUserId`. */
  channelUsersOf(clawUserId: string): readonly string[];
  /** The Claw user a person's link recorded. */
  clawUserOf(userId: string): string | undefined;
  /** Whether a person's link holds a key. */
  hasKey(userId: string): boolean;
  /** Where the bot last talked with a person (their stored conversation reference). */
  conversationOf(userId: string): ConversationRef | undefined;
  /** The people this worker knows by name. */
  knownPeople(): readonly { readonly name: string; readonly objectId: string }[];
  /** Post `text` into `conversation`; the id the channel gave it, or undefined when it did not say it arrived. */
  post(conversation: ConversationRef, text: string): Promise<MessageId | undefined>;
  /** Handle `text` as the person's own message `messageId` in `conversation`, with provenance "on_behalf". */
  handleAsTyped(conversation: ConversationRef, userId: string, messageId: MessageId, text: string): Promise<void>;
  /** Run `task` in the background; the worker waits for it when it stops, and logs a failure by its kind. */
  spawn(task: () => Promise<void>): void;
  /** One `on_behalf_message` security event (operation "on_behalf"); the fields are shape-checked like every event's. */
  audit(fields: Readonly<Record<string, string | number | null>>): void;
  readonly logger: Logger;
}

/** A deployment's plugins, built with the worker's services; what it leaves out is the neutral default. */
export type PluginFactory = (services: WorkerServices) => Partial<Plugins>;

/**
 * Build the worker from `env` with `plugins` (or a factory that builds them with the worker's services). Rejects at start,
 * before anything is served, when the settings are not usable (a missing required setting, an unreadable key file): a
 * worker that starts must be able to answer.
 */
export type BuildWorker = (
  env: WorkerEnv,
  plugins: Plugins | PluginFactory,
  options?: WorkerOptions,
) => Promise<Worker>;
