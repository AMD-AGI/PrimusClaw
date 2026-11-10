// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * @primusclaw/personal-agent-teams: the personal agent on Microsoft Teams. It implements core's Surface for Teams and
 * assembles the worker process; it depends on core and on the runtime's public interface.
 */
export * from "./caps.js";
export * from "./activity/reference.js";
export * from "./cards/cjk.js";
export * from "./cards/kit.js";
export * from "./cards/view-buttons.js";
export type { CardElement, Json, JsonObject as CardJson } from "./cards/json.js";
export * from "./surface.js";
export * from "./views/index.js";
export * from "./worker-api.js";
export { buildWorker } from "./assembly/worker.js";
export { main } from "./main.js";
