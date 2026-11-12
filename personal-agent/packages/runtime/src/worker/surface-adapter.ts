// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a surface package implements to run the worker on its chat app (`assembleWorker(adapter, env, plugins)`). The
 * worker reads core's settings and secrets, opens the store and the Claw client, builds the features behind the router,
 * serves its HTTP endpoints and runs its timers; the surface brings its own settings, its `Surface` (core's port: posting,
 * editing, streams, files, views rendered its way), how a stored conversation reference is read back, and where its
 * inbound events come from. The stages are called in this order, once each, and any of them may throw to stop the start
 * (one CRITICAL line; a `SecretsUnavailable` exits with status 2, anything else with 1):
 *
 *   prepare(env)          before anything else is read: what the surface refuses first
 *   loadSecrets(deps)     the secrets core's settings need (default: the environment alone)
 *   configure(settings)   after core's settings, before the store opens: the surface's own settings
 *   open(context)         once the store and the Claw client exist: its outbound side and its `Surface`
 *   connect(context)      once the features are built: its inbound side (HTTP routes, or a source the worker runs)
 *
 * A surface package depends on core, the runtime and this package, and never on another surface package.
 */
import type {
  Clock,
  ConversationRef,
  GroupContext,
  InboundEvent,
  Logger,
  MessageId,
  MetricsPort,
  Random,
  SecretName,
  Settings,
  Surface,
  TokenExchange,
} from "@primusclaw/personal-agent";
import type { HttpRoute, SqliteStore } from "@primusclaw/personal-agent-runtime";

import type { SurfaceShape } from "./features-base.js";
import type { Features } from "./features.js";
import type { InboundSource } from "./runner.js";
import type { WorkerEnv } from "./worker-api.js";

/** What every stage may use: the worker's clock, its logger and the `fetch` it sends with. */
export interface SurfaceDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly fetch: typeof fetch;
}

export interface SurfaceAdapter {
  /** The surface's name in the logs: the worker logs as `<name>_agent` ("teams": `teams_agent`). */
  readonly name: string;
  /** Before the secrets and core's settings are read; throws for a setting the surface refuses first. */
  prepare(env: WorkerEnv): PreparedSurface;
}

export interface PreparedSurface {
  /**
   * The secrets `names` (what core's settings need), from where the surface's settings say. Without it the worker reads
   * them from the environment, and SECRETS_SOURCE must be `env`.
   */
  loadSecrets?(names: readonly SecretName[], deps: SurfaceDeps): Promise<ReadonlyMap<SecretName, string>>;
  /** After core's settings, before the store opens: the surface's own settings; throws for one it cannot use. */
  configure(settings: Settings): ConfiguredSurface;
}

export interface ConfiguredSurface {
  /** Where the worker's HTTP endpoints listen: "0.0.0.0", or the loopback while a test entry drives the worker. */
  readonly host: string;
  /** What the features read of the surface besides its port. */
  readonly shape: SurfaceShape;
  /** Once the store and the Claw client exist: the surface's outbound side and its `Surface`. */
  open(context: SurfaceDeps & { readonly random: Random }): OpenedSurface;
}

export interface OpenedSurface {
  readonly surface: Surface;
  /**
   * `text` as the event the surface would have made of the person's own message `messageId` in `conversation` (what a
   * plugin's `WorkerServices.handleAsTyped` hands the router); undefined when it cannot be read as one.
   */
  typedEvent(conversation: ConversationRef, messageId: MessageId, text: string): InboundEvent | undefined;
  /** Once the features are built: the surface's inbound side. */
  connect(context: ConnectContext): ConnectedSurface;
  /**
   * What the surface closes when the worker stops: after the features and the plugins' background tasks, before the store;
   * in order, each even when one before it failed.
   */
  readonly closes: readonly (() => unknown)[];
}

export interface ConnectContext {
  /** The router: every inbound event goes here. */
  readonly route: (event: InboundEvent) => Promise<void>;
  /** The recent messages kept of group chats: a removal, delete or edit the surface hears of changes them. */
  readonly groupContext: GroupContext;
  readonly store: SqliteStore;
  readonly exchange: TokenExchange;
  /** What a test entry reads: the subscriptions, and the Claw sessions this worker made. */
  readonly gate: Features["gate"];
  readonly metrics: MetricsPort;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface ConnectedSurface {
  /** The surface's HTTP routes, served after the worker's own on its server (a webhook, a test entry); none: []. */
  readonly routes: readonly HttpRoute[];
  /** Where its inbound events come from otherwise (a queue's consumer, a socket); the worker runs it until it stops. */
  readonly source: InboundSource | undefined;
}
