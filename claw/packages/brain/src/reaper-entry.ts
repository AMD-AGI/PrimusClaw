// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// reaper-entry.ts
//
// CronJob entry point invoked by the K8s manifest:
//   command: ["node", "/app/packages/brain/dist/reaper-entry.js"]
//
// This file is loaded ONLY by the workspace-reaper Job pod. The brain
// Deployment does NOT import it; the only shared code surface is the
// pure-fs reaper module (workspace/reaper.ts) and the NATS client
// dependency from package.json. brain Deployment and brain Reaper
// CronJob therefore have completely independent failure domains:
// reaper crash never blocks the brain task consumer, and a brain crash
// during a reap cycle does not stop the cron from running again next
// tick.
//
// Exit codes (consumed by the K8s alert ReaperJobFailed):
//   0 — clean cycle
//   1 — fatal: connect failed, KV bucket missing, uncaught exception
//   2 — partial: cycle ran but accumulated > 100 errors; humans should
//       investigate next-tick logs, but data is not at risk because
//       INV-R5 (bias keep on error) protects against false positives.
//
// Self-check mode (`node reaper-entry.js --self-check`) is used by the
// Dockerfile build to verify the entry parses without standing up a
// NATS connection. It exits 0 immediately after import.

import { connect } from "nats";
import pino from "pino";
import { httpOwnershipOracle, runOneReapCycle } from "./workspace/reaper.js";

const logger = pino({ name: "reaper-entry" });

async function main(): Promise<void> {
  if (process.argv.includes("--self-check")) {
    logger.info("reaper.self_check_ok");
    process.exit(0);
  }

  const workspacePersistBase = (process.env.WORKSPACE_PERSIST_BASE ?? "").trim();
  if (!workspacePersistBase) {
    logger.info("reaper.disabled: WORKSPACE_PERSIST_BASE is empty");
    return;
  }

  const natsUrl = process.env.NATS_URL;
  if (!natsUrl) {
    logger.error("reaper.fatal: NATS_URL env var is required");
    process.exit(1);
  }

  const nc = await connect({
    servers: natsUrl,
    user: process.env.NATS_USER,
    pass: process.env.NATS_PASSWORD,
    name: "claw-workspace-reaper",
    timeout: 10_000,
  });

  try {
    const js = nc.jetstream();
    // Bucket names must match the main brain — see
    // checkpoint-architecture-redesign.md §6 (BRAIN_REGISTRY holds
    // `lock.<sid>`, BRAIN_CHECKPOINTS holds `task-ckpt.<sid>.<messageId>`). If
    // either bucket is missing the reaper exits 1 fast; that points
    // at a deploy-ordering bug (reaper CronJob deployed before the
    // brain Deployment has created these KV buckets) and not a
    // recoverable runtime condition.
    //
    // Read from the environment with the same names and defaults Brain uses,
    // rather than hard-coded, and rather than importing Brain's config so this
    // entry keeps its independent failure domain. Hard-coding was safe only
    // while nobody overrode them, and the failure it invites is the worst one
    // available here: pointed at buckets that exist but belong to a different
    // deployment, every workspace looks unlocked and uncheckpointed, and the
    // reaper concludes that all of them are garbage.
    const registryBucket = process.env.BRAIN_REGISTRY_BUCKET || "BRAIN_REGISTRY";
    const checkpointsBucket = process.env.BRAIN_CHECKPOINTS_BUCKET || "BRAIN_CHECKPOINTS";
    logger.info({ registryBucket, checkpointsBucket }, "reaper.kv_buckets");
    const ownerApiUrl = (process.env.WORKSPACE_OWNER_API_URL || "").replace(/\/+$/, "");
    logger.info({ ownerApi: ownerApiUrl || null }, "reaper.owner_source");
    const kv = await js.views.kv(registryBucket);
    const kvCkpt = await js.views.kv(checkpointsBucket);

    const stats = await runOneReapCycle({
      kv,
      kvCkpt,
      base: workspacePersistBase,
      retentionDays: Number(process.env.WORKSPACE_GC_RETENTION_DAYS || 7),
      kvGraceMin: Number(process.env.REAPER_KV_GRACE_MIN || 30),
      trashGraceHours: Number(process.env.REAPER_TRASH_GRACE_HOURS || 24),
      maxDeletePerRun: Number(process.env.REAPER_MAX_DELETE_PER_RUN || 500),
      dryRun: (process.env.REAPER_DRY_RUN || "false") === "true",
      // Configured, not assumed: a reaper that cannot reach the API keeps
      // deciding from mtime, and one pointed at the wrong API would be told
      // that nothing owns anything. Absent leaves the pre-existing behaviour.
      owner: ownerApiUrl
        ? httpOwnershipOracle(ownerApiUrl, process.env.AUTH_INTERNAL_TOKEN || "")
        : undefined,
    });
    logger.info(stats, "reaper.cycle_done");

    // Exit code semantics for K8s alerts.
    if (stats.errors > 100) {
      process.exit(2);
    }
    process.exit(0);
  } finally {
    await nc.close().catch(() => {});
  }
}

main().catch((err) => {
  logger.error({ err }, "reaper.fatal");
  process.exit(1);
});
