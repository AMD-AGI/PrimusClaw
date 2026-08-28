// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Prometheus metrics for Claw API server. Session creation outcomes,
// task dispatch counts, and event-consumer throughput. Sandbox metrics live
// in the Brain process (see packages/brain/src/infra/metrics.ts).

import { Registry, collectDefaultMetrics, Counter } from "prom-client";

export const registry = new Registry();
registry.setDefaultLabels({ service: "claw-api" });
collectDefaultMetrics({ register: registry });

const sessionCreatedTotal = new Counter({
  name: "claw_api_session_created_total",
  help: "Session creations by outcome.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});
const sessionDeletedTotal = new Counter({
  name: "claw_api_session_deleted_total",
  help: "Session soft-deletes by outcome.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});
const messageDispatchedTotal = new Counter({
  name: "claw_api_message_dispatched_total",
  help: "Messages dispatched to Brain via NATS task stream.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});
const eventPersistedTotal = new Counter({
  name: "claw_api_event_persisted_total",
  help: "Events persisted by the durable event consumer.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

export const metrics = {
  onSessionCreated(outcome: "ok" | "error"): void {
    sessionCreatedTotal.inc({ outcome });
  },
  onSessionDeleted(outcome: "ok" | "error"): void {
    sessionDeletedTotal.inc({ outcome });
  },
  onMessageDispatched(outcome: "ok" | "error"): void {
    messageDispatchedTotal.inc({ outcome });
  },
  onEventPersisted(outcome: "ok" | "error"): void {
    eventPersistedTotal.inc({ outcome });
  },
};
