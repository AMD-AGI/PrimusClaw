// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import {
  API_PORT, APP_ENV, SAFE_API_URL, DATABASE_URL, resolveCorsOrigin,
  AUTH_INTERNAL_TOKEN, NATS_URL,
  CLAW_ASSISTANT_ENABLED, CLAW_ASSISTANT_TOKEN_KEY, CLAW_NOTIFICATIONS_ENABLED, CLAW_TRIGGERS_ENABLED, CLAW_TRIGGER_TOOLS_ENABLED, CLAW_TRIGGER_TOOLS_TOKEN_KEY, CLAW_SKILL_EVOLUTION_ENABLED, SESSION_AUTO_ARCHIVE_DAYS,
  SESSION_PURGE_DAYS, SESSION_RETENTION_BATCH, SESSION_RETENTION_DAYS, SESSION_RETENTION_DRY_RUN,
  SESSION_RETENTION_HOLD_BUDGET_SEC, SESSION_RETENTION_LOCK_RETRY_MIN,
  runLeaseTiming, envSettingProblems, assertAdmissionSettings,
  SHUTDOWN_DEADLINE_MS, SHUTDOWN_DELAY_MS,
} from "./config.js";
import { runLeaseTimingProblems } from "@claw/protocol";
import { db, initDb } from "./infra/db.js";
import { GracefulShutdown } from "./infra/graceful-shutdown.js";
import { bindApiAppGrant } from "./grants/app-grant.js";
import { initNats, nc as natsConnection } from "./infra/nats.js";
import { initUserEnvCrypto } from "./crypto/user-env.js";
import { authLogPath, authMiddleware } from "./auth/middleware.js";
import { startIdentityClient } from "./auth/identity.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerSessionDeliveryRoutes } from "./routes/session-deliveries.js";
import { registerAnswerFeedbackRoutes } from "./routes/answer-feedback.js";
import { registerImageRoutes } from "./routes/images.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerAnthropicManagedAgentsRoutes } from "./routes/anthropic-managed-agents.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerSkillRoutes } from "./routes/skills.js";
import { registerA2ARoutes } from "./routes/a2a.js";
import { registerPluginRoutes } from "./routes/plugins.js";
import { registerUserEnvVarRoutes } from "./routes/user-env-vars.js";
import { registerAssistantRoutes } from "./routes/assistant.js";
import { registerAssistantMcpRoutes } from "./assistant/mcp.js";
import { registerAssistantGithubEventRoutes } from "./routes/assistant-github-events.js";
import { registerAssistantProactiveRoutes } from "./routes/assistant-proactive.js";
import { startGithubEventWatch } from "./assistant/github-events.js";
import { startJobWatch } from "./assistant/job-watch.js";
import { assertAssistantTokenKey } from "./assistant/token.js";
import { registerTriggerMcpRoutes } from "./triggers/mcp.js";
import { assertTriggerToolsConfig } from "./triggers/token.js";
import { registerNotificationSubscriptionRoutes } from "./routes/notification-subscriptions.js";
import { registerRemoteAgentRoutes } from "./routes/remote-agents.js";
import { startNotificationWorker, stopNotificationDelivery } from "./notifications/outbox.js";
import { registerAssistantDeliveryHook } from "./assistant/outbound.js";
import { registerHoldDeliveryHook } from "./assistant/holds.js";
import { a2aPushEnabled } from "./routes/a2a-flags.js";
import { startA2aPushWorker } from "./routes/a2a-push.js";
import { registerSystemEnvVarRoutes, publishSystemEnvToKv } from "./routes/system-env-vars.js";
import { registerSandboxAdminRoutes } from "./routes/sandbox-admin.js";
import { registerTerminalRoutes } from "./routes/terminal.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerGithubReviewRoutes } from "./github-review/mcp.js";
import { registerGithubMcpRoutes } from "./github-mcp/mcp.js";
import { publicReadConfigErrors } from "./github-mcp/public-read.js";
import { githubMcpConfigErrors, readGithubMcpSettings } from "./github-mcp/settings.js";
import { githubReviewConfigErrors, readGithubReviewSettings } from "./github-review/settings.js";
import { identityClient } from "./auth/identity.js";
import { identityTokenSettings } from "./auth/identity-token.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerModelsRoutes } from "./routes/models.js";
import { registerInternalTaskRoutes } from "./routes/internal-tasks.js";
import { registerInternalRunRoutes } from "./routes/internal-runs.js";
import { registerInternalAppRoutes } from "./routes/internal-apps.js";
import { registerInternalWorkspaceRoutes } from "./routes/internal-workspaces.js";
import { registerInternalMemoryRoutes } from "./routes/internal-memory.js";
import { registerTaskDagRoutes } from "./routes/task-dags.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerRunRoutes } from "./runs/routes.js";
import { registerWorkbenchRoutes } from "./workbenches/routes.js";
import { registerTriggerRoutes } from "./routes/triggers.js";
import { startTriggerScheduler } from "./triggers/scheduler.js";
import { startScheduler } from "./tasks/scheduler.js";
import { startSweeper } from "./tasks/sweeper.js";
import { startExternalResolver } from "./tasks/external-resolver.js";
import { startEventConsumer } from "./events/consumer.js";
import { startEvolveWorker } from "./marketplace/evolve-worker.js";
import { startUploadSweeper } from "./sessions/upload-sweeper.js";
import { archiveIdleSessions } from "./sessions/archive.js";
import { DEFAULT_RETENTION_RUN, runSessionRetentionOnce } from "./sessions/retention.js";
import { cleanupOrphanSkillFiles, cleanupOldPatterns } from "./marketplace/skill-service.js";
import { registry as metricsRegistry } from "./infra/metrics.js";
import { assertRolloutConfigAtStartup } from "./startup/rollout-config.js";
import pino from "pino";

const logger = pino({ name: "api" });

/**
 * Largest request body the API accepts.
 *
 * Four megabytes: comfortably above the one-megabyte total Brain caps a run's
 * captures at, so the truncation there is what a caller sees rather than a
 * refused callback, and low enough that it is still a limit.
 */
const BODY_LIMIT_BYTES = 4 * 1024 * 1024;

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
 * Refuse to serve when the dev auth bypass is combined with a real cluster key.
 *
 * Either alone is a deliberate configuration. Together they are not: the bypass
 * treats every anonymous caller as a system-admin, and `SAFE_PLATFORM_KEY` is a
 * credential that acts on the cluster as a shared identity. A deployment with
 * both hands anyone who can reach the port the ability to create workloads under
 * an identity nobody owns.
 *
 * Fatal rather than warned about, because the combination produces no error at
 * runtime -- it produces work that runs, attributed to nobody, which is exactly
 * the failure that went unnoticed on the DAG path for as long as it did.
 */
function assertNoSharedIdentityBypass(): void {
  const bypass = (process.env.CLAW_INSECURE_DEV_AUTH ?? "").trim() === "1";
  const sharedKey = (process.env.SAFE_PLATFORM_KEY ?? "").trim() !== "";
  if (!bypass || !sharedKey) return;
  logger.error(
    {},
    "startup.insecure_dev_auth_with_shared_platform_key",
  );
  throw new Error(
    "CLAW_INSECURE_DEV_AUTH=1 and SAFE_PLATFORM_KEY are both set. The bypass makes " +
      "every caller a system-admin and the key lets them act as the cluster's shared " +
      "identity; together they let anyone who can reach this port create workloads " +
      "owned by nobody. Unset one.",
  );
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

/**
 * Refuse to serve GitHub review without what its gates are made of: the secret that
 * signs the tool token and the identity client that fetches the acting user's credential.
 */
function assertGithubReviewConfig(): void {
  const settings = readGithubReviewSettings();
  if (!settings.enabled) return;
  if (settings.problems.length) logger.error({ refused: settings.problems }, "startup.config_refused");
  const errors = githubReviewConfigErrors(settings, identityClient() !== null, identityTokenSettings().ownKeyClientIds);
  if (errors.length === 0) return;
  logger.error({ errors }, "startup.github_review_refused");
  throw new Error(`CLAW_GITHUB_REVIEW_ENABLED is true but GitHub review cannot be offered: ${errors.join("; ")}`);
}

/** Refuse to serve the GitHub tools without the secret that signs their token. */
function assertGithubMcpConfig(): void {
  const settings = readGithubMcpSettings();
  // The read-only App is used only by the GitHub tools' reads (`pr_state`): checked when they are on.
  const errors = [
    ...githubMcpConfigErrors(settings, identityClient() !== null, readGithubReviewSettings().enabled),
    ...(settings.enabled ? publicReadConfigErrors() : []),
  ];
  if (errors.length === 0) return;
  logger.error({ errors }, "startup.github_mcp_refused");
  throw new Error(`CLAW_GITHUB_MCP_ENABLED is true but the GitHub tools cannot be offered: ${errors.join("; ")}`);
}

async function main() {
  validateStartupConfig();
  assertNoSharedIdentityBypass();
  assertRunLeaseTiming();
  assertAssistantTokenKey(CLAW_ASSISTANT_ENABLED, CLAW_ASSISTANT_TOKEN_KEY);
  assertTriggerToolsConfig(CLAW_TRIGGER_TOOLS_ENABLED, CLAW_TRIGGERS_ENABLED, CLAW_TRIGGER_TOOLS_TOKEN_KEY);
  // Before the admission assertion, not after: the rollout gauges are applied
  // on the way through, and a pod that dies on the second assertion would
  // otherwise start exporting neither.
  assertRolloutConfigAtStartup();
  assertAdmissionSettings(logger);
  // Off unless IDENTITY_CLIENT_ENABLED is set; it authenticates a connector's access token, and an identity provider's access token only with CLAW_IDENTITY_TOKEN_AUTH_ENABLED.
  startIdentityClient(logger);
  // Off unless CLAW_GITHUB_REVIEW_ENABLED. A deployment that asked for it and cannot offer its gates does not start.
  assertGithubReviewConfig();
  assertGithubMcpConfig();
  // Validate USER_ENV_ENCRYPTION_KEY before doing anything else; we want a
  // fast-fail if the K8s Secret is misconfigured (missing or wrong length),
  // not a runtime surprise on the first PUT /v1/users/me/env-vars/* call.
  initUserEnvCrypto();
  bindApiAppGrant();
  await initDb();
  await initNats();

  const app = Fastify({
    // Stated rather than left to Fastify's 1 MiB default.
    //
    // The body that decides this is `agent_done`: it carries a run's captures, and
    // a run that captured a large result did not lose the capture -- it lost the
    // callback. A 413 there records a run that finished its work as never having
    // reported, and takes everything else it captured with it.
    //
    // Brain now truncates each capture and caps their total, so this is the
    // backstop rather than the limit that bites: a body over it means something
    // other than captures grew, and 413 is then the right answer.
    bodyLimit: BODY_LIMIT_BYTES,
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

  // Before any route: the shutdown has to see every response, including the
  // event streams that hijack theirs. See infra/graceful-shutdown.ts.
  const shutdown = new GracefulShutdown({
    logger,
    deadlineMs: SHUTDOWN_DEADLINE_MS,
    delayMs: SHUTDOWN_DELAY_MS,
    closeServer: () => app.close(),
    steps: [
      // Before the pools end: what this process claimed to deliver is sent or handed back, and it claims nothing more.
      { name: "notifications", run: () => stopNotificationDelivery() },
      { name: "nats", run: async () => { await natsConnection?.drain(); } },
      { name: "db", run: () => Promise.all([db.pool.end(), db.lockPool.end()]) },
    ],
    exit: (code) => process.exit(code),
  });
  app.addHook("onRequest", async (_req, reply) => {
    shutdown.watchResponse(reply.raw);
  });
  shutdown.install();

  // Liveness: the process is up. Stays 200 while draining, so a pod finishing
  // its requests is not restarted for doing so.
  app.get("/health", async () => ({ status: "ok", service: "api-v2" }));
  // Readiness: the process wants new requests. 503 from SIGTERM on.
  app.get("/ready", async (_req, reply) => {
    if (shutdown.draining) return reply.status(503).send({ status: "draining", service: "api-v2" });
    return { status: "ok", service: "api-v2" };
  });

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
  await registerSessionDeliveryRoutes(app);
  await registerAnswerFeedbackRoutes(app);
  await registerImageRoutes(app);
  await registerEventRoutes(app);
  await registerAnthropicManagedAgentsRoutes(app);
  await registerAdminRoutes(app);
  await registerMemoryRoutes(app);
  await registerSkillRoutes(app);
  await registerA2ARoutes(app);
  await registerPluginRoutes(app);
  await registerUserEnvVarRoutes(app);
  await registerNotificationSubscriptionRoutes(app);
  // Off unless CLAW_REMOTE_AGENTS_ENABLED: the module registers nothing otherwise.
  await registerRemoteAgentRoutes(app, { closing: shutdown.closing, crossReplicaWake: true });
  // Off unless CLAW_ASSISTANT_ENABLED: the module registers nothing otherwise.
  await registerAssistantRoutes(app);
  // The pull requests a work item watches; nothing unless CLAW_ASSISTANT_ENABLED and CLAW_ASSISTANT_GITHUB_EVENTS.
  await registerAssistantGithubEventRoutes(app);
  // The brief and the cards the router puts to the user; nothing unless CLAW_ASSISTANT_ENABLED.
  await registerAssistantProactiveRoutes(app);
  // The assistant's own MCP service, under /v1/internal/; registers nothing unless CLAW_ASSISTANT_ENABLED.
  await registerAssistantMcpRoutes(app);
  await registerTriggerMcpRoutes(app);
  // Off unless CLAW_GITHUB_REVIEW_ENABLED: nothing is registered otherwise.
  await registerGithubReviewRoutes(app);
  // Off unless CLAW_GITHUB_MCP_ENABLED: nothing is registered otherwise.
  await registerGithubMcpRoutes(app);
  await registerSystemEnvVarRoutes(app);
  await registerSandboxAdminRoutes(app);
  await registerTerminalRoutes(app);
  await registerMcpRoutes(app);
  await registerInternalTaskRoutes(app);
  await registerInternalRunRoutes(app);
  await registerInternalAppRoutes(app);
  await registerInternalWorkspaceRoutes(app);
  await registerInternalMemoryRoutes(app);
  await registerTaskDagRoutes(app);
  await registerTaskRoutes(app);
  await registerRunRoutes(app);
  await registerWorkbenchRoutes(app);
  await registerModelsRoutes(app);
  await registerMeRoutes(app);
  // Scheduled triggers: nothing is registered unless the deployment turns them on.
  if (CLAW_TRIGGERS_ENABLED) await registerTriggerRoutes(app);

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

  if (CLAW_TRIGGERS_ENABLED) startTriggerScheduler();
  // Outbound notification delivery (HMAC-signed webhooks from the outbox).
  // Gated: with the flag off no table exists and nothing polls.
  if (CLAW_NOTIFICATIONS_ENABLED) startNotificationWorker();
  // The assistant's messages go out through the same outbox, so both switches have to be on.
  if (CLAW_NOTIFICATIONS_ENABLED && CLAW_ASSISTANT_ENABLED) registerAssistantDeliveryHook();
  // A work item's request that a channel took is the item's needs-you message (`assistant/holds.ts`).
  if (CLAW_NOTIFICATIONS_ENABLED && CLAW_ASSISTANT_ENABLED) registerHoldDeliveryHook();
  if (a2aPushEnabled()) startA2aPushWorker();
  // Reads the pull requests work items watch and hands what is new to their workers; does nothing unless both switches are on.
  startGithubEventWatch();
  // Reads the jobs the assistant watches for users and tells them what changed; does nothing unless CLAW_ASSISTANT_JOB_EVENTS is on.
  startJobWatch();

  // Daily maintenance crons (every 24h, first run 1 min after startup).
  // Skill cleanups gated by CLAW_SKILL_EVOLUTION_ENABLED — when OFF, old data
  // is fully frozen so toggling the flag back ON restores prior state without
  // value loss. Memory has none: nothing about it changes on a timer.
  const runMaintenance = () => {
    // Archive first, then retention: a session archived today is days away from
    // the retention window either way, and the order keeps one pass's log readable.
    archiveIdleSessions(SESSION_AUTO_ARCHIVE_DAYS)
      .catch(err => logger.error({ err }, "session_archive.failed"))
      .then(() => runSessionRetentionOnce({
        retentionDays: SESSION_RETENTION_DAYS,
        purgeDays: SESSION_PURGE_DAYS,
        batch: SESSION_RETENTION_BATCH,
        dryRun: SESSION_RETENTION_DRY_RUN,
      }, {
        ...DEFAULT_RETENTION_RUN,
        holdBudgetMs: SESSION_RETENTION_HOLD_BUDGET_SEC * 1000,
        lockRetryDelayMs: SESSION_RETENTION_LOCK_RETRY_MIN * 60 * 1000,
      }))
      .catch(err => logger.error({ err }, "session_retention.failed"));
    if (CLAW_SKILL_EVOLUTION_ENABLED) {
      cleanupOrphanSkillFiles().catch(err => logger.error({ err }, "skill_files.cleanup_failed"));
      cleanupOldPatterns().catch(err => logger.error({ err }, "skill_patterns.cleanup_failed"));
    }
  };
  if (CLAW_SKILL_EVOLUTION_ENABLED || SESSION_AUTO_ARCHIVE_DAYS > 0
    || SESSION_RETENTION_DAYS > 0 || SESSION_PURGE_DAYS > 0) {
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
