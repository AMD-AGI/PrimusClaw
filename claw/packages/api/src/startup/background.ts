// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * CLAW_API_BACKGROUND: whether this process runs the API's background work, or only answers HTTP.
 *
 * `on` (the default) is the API as it always ran: every replica starts the loops below. `off` starts none of them, so a
 * process can serve requests against a database other replicas own -- a candidate build taking evaluation traffic, say --
 * without sweeping, reaping, delivering or scheduling anything there. What a request does still happens in full; what the
 * other replicas do on a timer is left to them.
 *
 * Every loop the API starts is named here, and started through `startBackgroundLoops`, so the switch is one test away
 * from proof: a loop that bypasses this module is one the switch does not stop. Importing this module starts nothing.
 */

export const API_BACKGROUND_SETTING = "CLAW_API_BACKGROUND";

/** What `CLAW_API_BACKGROUND` asked for, or why it could not be read. */
export type ApiBackgroundSetting = { on: boolean; problem?: undefined } | { on?: undefined; problem: string };

/**
 * `on` or `off`; unset or blank is `on`. Anything else is a problem the process refuses to start on, rather than a
 * default: a typo meant to stop the loops must not run them against a database somebody else owns, and one meant to
 * keep them must not quietly stop a production replica's.
 */
export function readApiBackground(raw: string | undefined): ApiBackgroundSetting {
  const value = (raw ?? "").trim();
  const v = value.toLowerCase();
  if (v === "" || v === "on") return { on: true };
  if (v === "off") return { on: false };
  return { problem: `${API_BACKGROUND_SETTING}=${value} is neither on nor off` };
}

/** The loops `index.ts` starts, in the order it starts them. */
export const API_BACKGROUND_LOOPS = [
  // Boot: the SYSTEM_ENV variables written from the database to NATS KV.
  "system_env_publish",
  // `tasks/scheduler.ts`: dispatch of queued tasks.
  "task_scheduler",
  // `tasks/sweeper.ts`: the reapers, cleanup and settlement sweeps, and the dead doorbell-lease takeover.
  "task_sweeper",
  // `tasks/external-resolver.ts`: the `external-resolved.>` subscription and its poll.
  "external_resolver",
  // `events/consumer.ts`: the durable JetStream consumer of run events, and the `cleanup.>` listener.
  "event_consumer",
  // `marketplace/evolve-worker.ts` (CLAW_SKILL_AUTO_EVOLUTION_ENABLED).
  "evolve_worker",
  // `sessions/upload-sweeper.ts`.
  "upload_sweeper",
  // `marketplace/plugin-expiry.ts`.
  "plugin_expiry_sweeper",
  // `triggers/scheduler.ts` (CLAW_TRIGGERS_ENABLED).
  "trigger_scheduler",
  // `notifications/outbox.ts`: the outbox poll (CLAW_NOTIFICATIONS_ENABLED).
  "notification_worker",
  // `routes/a2a-push.ts`: A2A push-notification delivery.
  "a2a_push_worker",
  // `assistant/github-events.ts`: the pull requests work items watch.
  "github_event_watch",
  // `assistant/job-watch.ts`: the jobs the assistant watches for users.
  "job_watch",
  // `index.ts`: the daily session archive and retention, and the skill cleanups.
  "maintenance_cron",
  // After listen: `infra/db.ts` `buildDeferredIndexes`.
  "deferred_index_build",
] as const;

/** The loops `routes/remote-agents.ts` starts when CLAW_REMOTE_AGENTS_ENABLED, in its order. */
export const REMOTE_AGENT_BACKGROUND_LOOPS = [
  // `remote-agents/wake-relay.ts`: the LISTEN connection that relays wakes between replicas.
  "remote_agents.wake_relay",
  // Closed sessions and presence history past CLAW_REMOTE_AGENTS_RETENTION_DAYS.
  "remote_agents.retention_sweep",
  // `remote-agents/presence.ts`.
  "remote_agents.presence_sweep",
  // `remote-agents/terminal-waits.ts`.
  "remote_agents.terminal_wait_sweep",
  // Commands that were never collected (`store.expireUndelivered`).
  "remote_agents.undelivered_sweep",
  // `remote-agents/pairing-routes.ts`: unbound pairing grants.
  "remote_agents.pairing_prune",
] as const;

/**
 * Not a loop, but the same work as `notification_worker`: a request that enqueues a notification asks this process to
 * deliver whatever is due (`notifications/outbox.ts` `kickDelivery`). Off, it asks nothing and the replicas that run
 * the worker deliver it.
 */
export const REQUEST_DELIVERY = "notification_delivery_on_request";

export type ApiBackgroundLoopName = (typeof API_BACKGROUND_LOOPS)[number];
export type RemoteAgentBackgroundLoopName = (typeof REMOTE_AGENT_BACKGROUND_LOOPS)[number];
export type BackgroundLoopName = ApiBackgroundLoopName | RemoteAgentBackgroundLoopName;

/** Everything `off` skips, as the startup line names it. */
export const SKIPPED_WHEN_OFF: readonly string[] = [...API_BACKGROUND_LOOPS, ...REMOTE_AGENT_BACKGROUND_LOOPS, REQUEST_DELIVERY];

export interface BackgroundLoop<Name extends string = BackgroundLoopName> {
  name: Name;
  /** False when the loop's own setting keeps it off; it is then not started whatever the switch says. */
  when?: boolean;
  /** Logged, when the switch is on and `when` is false, as the loop always logged its own absence. */
  offLog?: string;
  start: () => void | Promise<void>;
}

interface InfoLog {
  info(obj: object, msg: string): void;
}

const started: string[] = [];

/** The loops this process has started, in order. */
export function startedBackgroundLoops(): readonly string[] {
  return started;
}

/**
 * Start `loops` in order, each awaited, unless the switch is off; then none of them is called. A `start` that throws
 * stops the ones after it, as the sequence in `index.ts` always did.
 */
export async function startBackgroundLoops<Name extends string>(
  on: boolean,
  loops: readonly BackgroundLoop<Name>[],
  log?: InfoLog,
): Promise<Name[]> {
  if (!on) return [];
  const now: Name[] = [];
  for (const loop of loops) {
    if (loop.when === false) {
      if (loop.offLog) log?.info({}, loop.offLog);
      continue;
    }
    await loop.start();
    now.push(loop.name);
    started.push(loop.name);
  }
  return now;
}

/** The one startup line of a process with the switch off. */
export function logBackgroundOff(log: InfoLog): void {
  log.info({ background: "off", skipped: SKIPPED_WHEN_OFF }, `api.background_off: background=off, skipped ${SKIPPED_WHEN_OFF.join(", ")}`);
}

/** What `index.ts` starts, one function per loop, so the list cannot leave a loop out. */
export type ApiBackgroundPorts = Record<ApiBackgroundLoopName, () => void | Promise<void>>;

/** The settings that keep a loop off whatever the switch says. */
export interface ApiBackgroundFlags {
  skillEvolution: boolean;
  triggers: boolean;
  notifications: boolean;
  a2aPush: boolean;
  maintenance: boolean;
}

/** The loops of `index.ts`: those started before it listens, and the one after. */
export function apiBackgroundLoops(
  ports: ApiBackgroundPorts,
  flags: ApiBackgroundFlags,
): { beforeListen: BackgroundLoop<ApiBackgroundLoopName>[]; afterListen: BackgroundLoop<ApiBackgroundLoopName>[] } {
  const when: Partial<Record<ApiBackgroundLoopName, boolean>> = {
    evolve_worker: flags.skillEvolution,
    trigger_scheduler: flags.triggers,
    notification_worker: flags.notifications,
    a2a_push_worker: flags.a2aPush,
    maintenance_cron: flags.maintenance,
  };
  const offLog: Partial<Record<ApiBackgroundLoopName, string>> = {
    evolve_worker: "evolve_worker.skipped_flag_off",
    maintenance_cron: "maintenance_cron.skipped_all_flags_off",
  };
  const loop = (name: ApiBackgroundLoopName): BackgroundLoop<ApiBackgroundLoopName> => ({
    name, when: when[name], offLog: offLog[name], start: ports[name],
  });
  return {
    beforeListen: API_BACKGROUND_LOOPS.filter((n) => n !== "deferred_index_build").map(loop),
    afterListen: [loop("deferred_index_build")],
  };
}
