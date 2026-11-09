// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * @primusclaw/personal-agent: the channel-neutral core of the personal agent.
 *
 * Layers (enforced by .dependency-cruiser.cjs and test/core-is-channel-neutral.test.ts): this package imports nothing
 * but itself, zod and the Claw wire contract (through ./protocol.ts). Everything else reaches it through a port
 * (`ports/`) or a plugin (`plugins/`), implemented by the runtime package, a channel package or a deployment.
 */
export * from "./errors.js";
export * from "./json.js";
export * from "./guardrails/index.js";
export * from "./limits/index.js";
export * from "./typed-answer/index.js";
export * from "./locales/index.js";
export * from "./plugins/index.js";
export * from "./ports/index.js";
export * from "./protocol.js";
export * from "./result.js";
export * from "./validate.js";
export * from "./claw/credential.js";
export * from "./claw/errors.js";
export * from "./claw/model.js";
export * from "./claw/remote.js";
export * from "./config/settings.js";
export * from "./observability/security-events.js";
export * from "./public-error/public-errors.js";
