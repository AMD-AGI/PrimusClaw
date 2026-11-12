// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * @primusclaw/personal-agent-worker: the worker process, whatever chat app it runs on. It builds the features behind the
 * router, the store, the Claw client, the HTTP endpoints, /metrics and the background loops from the environment, and
 * runs them on a surface a surface package brings (`SurfaceAdapter`, handed to `assembleWorker`). It depends on core and
 * on the runtime's public interface, never on a surface package.
 */
export * from "./worker-api.js";
export * from "./surface-adapter.js";
export { assembleWorker, envSecrets, withInboundStats, withRegistered } from "./assemble.js";
export { runMain } from "./run-main.js";
export { BUILD_INFO_METRIC, buildInfoText, withBuildInfo } from "./build-info.js";
export { StartupError } from "./startup-error.js";
export type { InboundSource } from "./runner.js";
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
} from "./features.js";
export { workerServices, type BoundServices, type ServicesParts } from "./worker-services.js";
/** Parts of the assembly a surface package's tests check on their own (the remote ask's card, a review's work card). */
export { remoteAskCard } from "./features-assistant.js";
export { workCardPoster } from "./features-review.js";
export { platformPlugins, type PlatformDeps } from "./plugins.js";
