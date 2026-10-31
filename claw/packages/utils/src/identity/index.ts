// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

export { IdentityClient, IDENTITY_DEFAULTS, type IdentityClientSettings } from "./client.js";
export { readIdentityConfig, type IdentityConfig } from "./config.js";
export {
  buildIdentityClient, startIdentityClient,
  type IdentityProcessMetrics, type IdentityStartupLog,
} from "./startup.js";
export { type ResolveCredentialRequest, type ResolvedCredential } from "./credentials.js";
export {
  IdentityCredentialRefusedError, IdentityExchangeRefusedError, IdentityUnavailableError, JwtVerificationError,
  type JwtFailure, type UnavailableReason,
} from "./errors.js";
export { TOKEN_EXCHANGE_GRANT, type ExchangedToken, type ExchangeRequest } from "./exchange.js";
export {
  type ActiveIntrospection, type InactiveIntrospection, type IntrospectionResult, type IntrospectOptions,
} from "./introspection.js";
export type { JwtAlgorithm, JwtVerifyOptions, VerifiedJwt } from "./jwt.js";
export {
  NOOP_LOGGER, NOOP_METRICS,
  type CacheResult, type IdentityDeps, type IdentityLogger, type IdentityMetrics, type IdentityOp,
  type UpstreamOutcome,
} from "./types.js";
