// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { noFeedbackSink, type FeedbackSink } from "./feedback-sink.js";
import { noIdentityLookup, type IdentityLookup } from "./identity-lookup.js";
import { noIntegrations, type Integrations } from "./integrations.js";
import { noKeyRevoker, type KeyRevoker } from "./key-revoker.js";
import { noModelRefusalPolicy, type ModelRefusalPolicy } from "./model-refusal-policy.js";
import { noRouteExtensions, type RouteExtension } from "./route-extension.js";
import { noTokenExchange, type TokenExchange } from "./token-exchange.js";

/**
 * What a deployment plugs in. The public build runs with the neutral defaults (`neutralPlugins`); a deployment's own
 * assembly passes its implementations (an identity platform, a model gateway's refusal rules, extra routes). Core
 * depends on these interfaces only.
 */
export interface Plugins {
  readonly identityLookup: IdentityLookup;
  readonly keyRevoker: KeyRevoker;
  readonly feedbackSink: FeedbackSink;
  readonly modelRefusalPolicy: ModelRefusalPolicy;
  readonly tokenExchange: TokenExchange;
  readonly routeExtensions: readonly RouteExtension[];
  /** The deployment's MCP servers and /whoami lines (`integrations.ts`); none in the public build. */
  readonly integrations: Integrations;
}

/** Every plugin at its neutral default, with `overrides` in their place. */
export function neutralPlugins(overrides: Partial<Plugins> = {}): Plugins {
  return {
    identityLookup: noIdentityLookup,
    keyRevoker: noKeyRevoker,
    feedbackSink: noFeedbackSink,
    modelRefusalPolicy: noModelRefusalPolicy,
    tokenExchange: noTokenExchange,
    routeExtensions: noRouteExtensions,
    integrations: noIntegrations,
    ...overrides,
  };
}

export * from "./feedback-sink.js";
export * from "./identity-lookup.js";
export * from "./key-revoker.js";
export * from "./model-refusal-policy.js";
export * from "./route-extension.js";
export * from "./token-exchange.js";
export * from "./integrations.js";
