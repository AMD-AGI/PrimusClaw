// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * @primusclaw/personal-agent-runtime/worker: the worker process, whatever chat app it runs on. It builds the features
 * behind the router, the store, the Claw client, the HTTP endpoints, /metrics and the background loops from the
 * environment, and runs them on a surface a surface package brings (`SurfaceAdapter`, handed to `assembleWorker`). It
 * uses core and runtime's main entry (by package name, so its bundle carries no second copy of runtime), never a surface
 * package; nothing else of runtime imports it.
 */
export * from "./worker/worker-api.js";
export * from "./worker/surface-adapter.js";
export { assembleWorker, envSecrets, withInboundStats, withRegistered } from "./worker/assemble.js";
export { runMain } from "./worker/run-main.js";
export { BUILD_INFO_METRIC, buildInfoText, withBuildInfo } from "./worker/build-info.js";
export { StartupError } from "./worker/startup-error.js";
export type { InboundSource } from "./worker/runner.js";
export {
  ASSISTANT_ACTION,
  buildFeatures,
  ON_BEHALF_PATH,
  SWEEP_MS,
  type AssemblyBase,
  type FeatureTimer,
  type Features,
  type GateSubscriptions,
  type ReplyStyle,
  type SurfaceShape,
} from "./worker/features.js";
export { workerServices, type BoundServices, type ServicesParts } from "./worker/worker-services.js";
/** Parts of the assembly a surface package's tests check on their own (the remote ask's card, a review's work card). */
export { remoteAskCard } from "./worker/features-assistant.js";
export { workCardPoster } from "./worker/features-review.js";
export { platformPlugins, type PlatformDeps } from "./worker/plugins.js";
