// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * @primusclaw/personal-agent-teams: the personal agent on Microsoft Teams. It implements core's Surface for Teams and runs
 * runtime's worker process on it (`teamsSurface`, `buildWorker`, `main`); it depends on core, on the runtime's public
 * interface and on runtime's worker (`@primusclaw/personal-agent-runtime/worker`), never on another surface package.
 */
export * from "./caps.js";
export * from "./activity/reference.js";
export * from "./cards/cjk.js";
export * from "./cards/kit.js";
export * from "./cards/view-buttons.js";
export type { CardElement, Json, JsonObject as CardJson } from "./cards/json.js";
export * from "./surface.js";
export * from "./views/index.js";
export type {
  BuildWorker,
  PluginFactory,
  Worker,
  WorkerEnv,
  WorkerOptions,
  WorkerServices,
} from "@primusclaw/personal-agent-runtime/worker";
export { buildWorker, teamsSurface } from "./assembly/worker.js";
export { main } from "./main.js";
