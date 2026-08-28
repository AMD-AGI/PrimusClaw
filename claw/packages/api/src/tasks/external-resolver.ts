// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * ExternalResolver (task-design.md §5.1 / §13).
 *
 * `mode=script` tasks whose step returned `{ wait_external: true }` land in
 * `claw_tasks.status='waiting_external'` with `metadata.external_id` set.
 * Resolution can arrive two ways:
 *
 *   - Push: NATS subject `external-resolved.<external_id>` (others can
 *     `nats publish` whenever the upstream completes).
 *   - Pull: a 30 s polling loop that checks each external_id via a
 *     pluggable handler (registered via `registerResolver`).
 *
 * On resolve we flip the task back to `queued` so the dispatcher picks it
 * up again. Brain receives a fresh `ExecuteRequest`; per design the
 * script is re-run from step 0 (R-1).
 */
import { db } from "../infra/db.js";
import pino from "pino";
import { nc, sc } from "../infra/nats.js";
import { transitionStatus } from "./db.js";

const logger = pino({ name: "external-resolver" });

const POLL_MS = Number(process.env.EXTERNAL_RESOLVER_POLL_MS || 30_000);

let stopped = false;
let timer: NodeJS.Timeout | null = null;

/**
 * Pluggable per-external-id resolver. Returns `true` when the external
 * job is finished and Brain can rerun. Defaults to "never resolved" so
 * unimplemented external_ids only resolve via the push channel.
 */
export type ExternalResolver = (externalId: string) => Promise<boolean>;
const resolvers = new Map<string, ExternalResolver>();

export function registerResolver(externalIdPrefix: string, fn: ExternalResolver): void {
  resolvers.set(externalIdPrefix, fn);
}

// Lightweight non-blocking sleep primitive for script steps that need to
// yield back to the task state machine and retry on the next resolver tick.
registerResolver("timer:", async () => true);

async function resolveByPrefix(externalId: string): Promise<boolean> {
  for (const [prefix, fn] of resolvers) {
    if (externalId.startsWith(prefix)) {
      try {
        return await fn(externalId);
      } catch (e) {
        logger.warn({ externalId, err: (e as Error).message }, "resolver.exception");
        return false;
      }
    }
  }
  return false;
}

async function tasksWaitingOn(externalId: string): Promise<string[]> {
  const r = await db.query(
    `SELECT task_id FROM claw_tasks
     WHERE status = 'waiting_external'
       AND metadata->'derived'->>'external_id' = $1`,
    [externalId],
  );
  return r.rows.map((row: { task_id: string }) => row.task_id);
}

export async function resumeFromExternal(externalId: string): Promise<number> {
  const ids = await tasksWaitingOn(externalId);
  let resumed = 0;
  for (const id of ids) {
    const r = await transitionStatus(id, ["waiting_external"], "queued");
    if (r) resumed++;
  }
  if (resumed) logger.info({ externalId, count: resumed }, "external.resumed");
  return resumed;
}

export async function externalResolverTick(): Promise<void> {
  try {
    const r = await db.query(
      `SELECT DISTINCT metadata->'derived'->>'external_id' AS ext_id
       FROM claw_tasks
       WHERE status = 'waiting_external'
         AND metadata->'derived'->>'external_id' IS NOT NULL`,
    );
    for (const row of r.rows as Array<{ ext_id: string }>) {
      const done = await resolveByPrefix(row.ext_id);
      if (done) await resumeFromExternal(row.ext_id);
    }
  } catch (e) {
    logger.error({ err: (e as Error).message }, "external.tick_failed");
  }
}

async function subscribePushChannel(): Promise<void> {
  const sub = nc.subscribe("external-resolved.>");
  (async () => {
    for await (const msg of sub) {
      const subject = msg.subject;
      const externalId = subject.slice("external-resolved.".length);
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(sc.decode(msg.data) || "{}"); } catch { /* tolerate empty payload */ }
      logger.info({ externalId, payload }, "external.push_received");
      await resumeFromExternal(externalId);
    }
  })().catch((e) => {
    logger.error({ err: (e as Error).message }, "external.push_subscriber_died");
  });
}

export async function startExternalResolver(): Promise<void> {
  if (timer) return;
  stopped = false;
  await subscribePushChannel();
  const loop = async () => {
    if (stopped) return;
    await externalResolverTick();
    if (!stopped) timer = setTimeout(loop, POLL_MS);
  };
  void loop();
  logger.info({ pollMs: POLL_MS }, "external.started");
}

export function stopExternalResolver(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
