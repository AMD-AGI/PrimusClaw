// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import {
  API_PORT, APP_ENV, SAFE_API_URL, DATABASE_URL, resolveCorsOrigin,
  AUTH_INTERNAL_TOKEN, NATS_URL,
  CLAW_MEMORY_ENABLED, CLAW_SKILL_EVOLUTION_ENABLED,
  runLeaseTiming, envSettingProblems,
} from "./config.js";
import { runLeaseTimingProblems } from "@claw/protocol";
import { initDb } from "./infra/db.js";
import { initNats } from "./infra/nats.js";
import { initUserEnvCrypto } from "./crypto/user-env.js";
import { authLogPath, authMiddleware } from "./auth/middleware.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerAnthropicManagedAgentsRoutes } from "./routes/anthropic-managed-agents.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerSkillRoutes } from "./routes/skills.js";
import { registerA2ARoutes } from "./routes/a2a.js";
import { registerPluginRoutes } from "./routes/plugins.js";
import { registerUserEnvVarRoutes } from "./routes/user-env-vars.js";
import { registerSystemEnvVarRoutes, publishSystemEnvToKv } from "./routes/system-env-vars.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerInternalTaskRoutes } from "./routes/internal-tasks.js";
import { registerInternalRunRoutes } from "./routes/internal-runs.js";
import { registerInternalWorkspaceRoutes } from "./routes/internal-workspaces.js";
import { registerTaskDagRoutes } from "./routes/task-dags.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerWorkbenchRoutes } from "./workbenches/routes.js";
import { startScheduler } from "./tasks/scheduler.js";
import { startSweeper } from "./tasks/sweeper.js";
import { startExternalResolver } from "./tasks/external-resolver.js";
import { startEventConsumer } from "./events/consumer.js";
import { startEvolveWorker } from "./marketplace/evolve-worker.js";
import { startUploadSweeper } from "./sessions/upload-sweeper.js";
import { decayMemory } from "./memory/service.js";
import { cleanupOrphanSkillFiles, cleanupOldPatterns } from "./marketplace/skill-service.js";
import { registry as metricsRegistry } from "./infra/metrics.js";
import pino from "pino";

const logger = pino({ name: "api" });

/**
 * Warn at startup when credentials needed later are missing.
 * In dev mode the auth bypass makes SAFE/internal tokens optional; in prod
 * they are required for the first incoming request to succeed.
 */
function validateStartupConfig(): void {
  const missing: string[] = [];
  const isDev = ["dev", "development", "local"].includes(APP_ENV.toLowerCase());
  if (!DATABASE_URL) missing.push("DATABASE_URL");
  if (!NATS_URL) missing.push("NATS_URL");
  if (!isDev) {
    if (!SAFE_API_URL) missing.push("SAFE_API_URL");
    if (!AUTH_INTERNAL_TOKEN) missing.push("AUTH_INTERNAL_TOKEN");
  }
  if (missing.length) {
    logger.warn({ missing, APP_ENV }, "startup.config_missing");
  }
  // Louder than a missing setting, because somebody set this one and the
  // process is running on the default instead. Not fatal: the default is by
  // definition a value this build shipped with, and the ordering checks below
  // run against what is actually in effect.
  const refused = envSettingProblems();
  if (refused.length) {
    logger.error({ refused }, "startup.config_refused");
  }
}

/**
 * Refuse to serve when the timings that decide a run is dead disagree.
 *
 * Fatal rather than a warning, for the same reason an incomplete schema is: the
 * sweeper runs unattended and its mistakes are silent. A grace that parsed to
 * zero, or one left behind while the lock TTL it has to outlast was widened,
 * does not fail here -- it fails as runs closed as `worker_lost` while the
 * redelivery that would have resumed them was still on its way, and the only
 * trace is a user asking why a turn vanished. The relation is checked at the one
 * moment there is somebody to read the reason.
 */
function assertRunLeaseTiming(): void {
  const timing = runLeaseTiming();
  const problems = runLeaseTimingProblems(timing);
  if (problems.length === 0) return;
  logger.error({ problems, timing }, "startup.run_lease_timing_broken");
  throw new Error(
    `run lease timings cannot decide a dead run safely: ${problems.join("; ")}`,
  );
}

async function main() {
  validateStartupConfig();
  assertRunLeaseTiming();
  // Validate USER_ENV_ENCRYPTION_KEY before doing anything else; we want a
  // fast-fail if the K8s Secret is misconfigured (missing or wrong length),
  // not a runtime surprise on the first PUT /v1/users/me/env-vars/* call.
  initUserEnvCrypto();
  await initDb();
  await initNats();

  const app = Fastify({
    logger: {
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers.x-api-key",
          "req.headers.x-sandbox-api-key",
        ],
        censor: "[REDACTED]",
      },
      serializers: {
        req(req: {
          method?: string;
          url?: string;
          socket?: { remoteAddress?: string; remotePort?: number };
        }) {
          return {
            method: req.method,
            url: authLogPath(req.url ?? ""),
            remoteAddress: req.socket?.remoteAddress,
            remotePort: req.socket?.remotePort,
          };
        },
      },
    },
  });

  // CORS: an explicit allowlist via CORS_ORIGINS (comma-separated), and no
  // cross-origin access at all when it is unset.
  //
  // The previous default reflected whatever Origin the request carried and
  // still sent Access-Control-Allow-Credentials, which is the one combination
  // the browser treats as "this site may read that site's authenticated
  // responses". With a session cookie in play that is CSRF-by-configuration,
  // and it was reached by leaving a variable blank -- which .env.example does,
  // next to APP_ENV=production. Every other authentication path in this
  // codebase fails closed when its variable is missing; this one opened up.
  //
  // Failing closed here costs nothing for the deployment the chart produces:
  // the ingress serves the API and the frontend under one host, so the browser
  // never makes a cross-origin request and CORS never enters the picture. It
  // only bites a genuinely cross-origin caller, which now has to name itself.
  const corsOrigin = resolveCorsOrigin(process.env.CORS_ORIGINS);
  if (corsOrigin === false) {
    logger.warn(
      "CORS_ORIGINS unset — cross-origin browser requests are refused. "
      + "Same-origin callers are unaffected; set CORS_ORIGINS to a "
      + "comma-separated allowlist if a browser on another origin needs access."
    );
  }
  await app.register(cors, {
    origin: corsOrigin,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE"],
  });
  await app.register(cookie);
  // Folder upload support: stream multiple files to S3 via /v1/sessions/:id/upload.
  // Limits enforced per-field; session-scoped total-file limit enforced in the route handler.
  await app.register(multipart, {
    limits: {
      fileSize: 1024 * 1024 * 1024, // 1 GiB per file
      files: 1000,                  // per-request file count cap
      fieldSize: 4 * 1024,          // max size of a non-file field (e.g. relative path)
    },
  });

  app.get("/health", async () => ({ status: "ok", service: "api-v2" }));

  // Prometheus scrape endpoint (text/plain Prom exposition).
  app.get("/metrics", async (_req, reply) => {
    reply.type(metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });

  // Global authentication preHandler — registered ONCE for the whole app.
  // Previously each route module called app.addHook("preHandler", authMiddleware)
  // and, because all routes share one (non-encapsulated) Fastify instance, every
  // request ran auth N times (once per module). authMiddleware self-skips the
  // anonymous allowlist (see isAnonymousPath: /health, /metrics, agent-card
  // discovery, /a2a/health, /v1/internal/*). Registered after /health and
  // /metrics so those stay outside the auth path.
  //
  // Must stay ABOVE the register*Routes calls: Fastify only propagates hooks to
  // encapsulated child scopes registered afterwards, and the A2A JSON-RPC route
  // lives in such a scope. Moving this below them would leave `POST /a2a`
  // unauthenticated.
  app.addHook("preHandler", authMiddleware);

  await registerSessionRoutes(app);
  await registerEventRoutes(app);
  await registerAnthropicManagedAgentsRoutes(app);
  await registerAdminRoutes(app);
  await registerMemoryRoutes(app);
  await registerSkillRoutes(app);
  await registerA2ARoutes(app);
  await registerPluginRoutes(app);
  await registerUserEnvVarRoutes(app);
  await registerSystemEnvVarRoutes(app);
  await registerMcpRoutes(app);
  await registerInternalTaskRoutes(app);
  await registerInternalRunRoutes(app);
  await registerInternalWorkspaceRoutes(app);
  await registerTaskDagRoutes(app);
  await registerTaskRoutes(app);
  await registerWorkbenchRoutes(app);

  // Reconcile SYSTEM_ENV KV with DB at boot so brain sees current global env
  // even if no admin write happens during this process lifetime.
  await publishSystemEnvToKv().catch((err) =>
    logger.warn({ err }, "system_env.initial_publish_failed"),
  );

  startScheduler();
  startSweeper();
  await startExternalResolver();

  startEventConsumer().catch((err) => logger.error({ err }, "event-consumer.failed"));

  // Durable skill-evolution worker — drains claw_evolution_jobs queue
  // populated by exec_complete handler. Survives crashes; FOR UPDATE
  // SKIP LOCKED makes it safe across multiple API replicas.
  // Gated: when skill evolution is OFF, no jobs are enqueued so the worker
  // would just poll an empty queue forever. Skip the empty polling loop.
  if (CLAW_SKILL_EVOLUTION_ENABLED) {
    startEvolveWorker();
  } else {
    logger.info("evolve_worker.skipped_flag_off");
  }

  // Background upload TTL sweeper (deletes user uploads > UPLOAD_TTL_DAYS old)
  startUploadSweeper();

  // Daily maintenance crons (every 24h, first run 1 min after startup).
  // Memory decay gated by CLAW_MEMORY_ENABLED, skill cleanups gated by
  // CLAW_SKILL_EVOLUTION_ENABLED — when OFF, old data is fully frozen so
  // toggling the flag back ON restores prior state without value loss.
  const runMaintenance = () => {
    if (CLAW_MEMORY_ENABLED) {
      decayMemory().catch(err => logger.error({ err }, "memory.decay_failed"));
    }
    if (CLAW_SKILL_EVOLUTION_ENABLED) {
      cleanupOrphanSkillFiles().catch(err => logger.error({ err }, "skill_files.cleanup_failed"));
      cleanupOldPatterns().catch(err => logger.error({ err }, "skill_patterns.cleanup_failed"));
    }
  };
  if (CLAW_MEMORY_ENABLED || CLAW_SKILL_EVOLUTION_ENABLED) {
    setTimeout(() => {
      runMaintenance();
      setInterval(runMaintenance, 24 * 60 * 60 * 1000);
    }, 60_000);
  } else {
    logger.info("maintenance_cron.skipped_all_flags_off");
  }

  // Start
  await app.listen({ host: "0.0.0.0", port: API_PORT });
  logger.info({ port: API_PORT }, "api-v2.ready");
}

main().catch((err) => { logger.fatal({ err }, "api.startup_failed"); process.exit(1); });
