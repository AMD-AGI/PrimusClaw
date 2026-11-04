// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the global authentication hook records about how a request was
 * authenticated, for the routes that accept some kinds of credential only, for
 * the audit trail, and for a stream that has to end when its credential does.
 * Its own module so that the hook and the code it calls can both read it
 * without importing each other.
 */
import type { FastifyRequest } from "fastify";

export function recordRequestCredential(req: FastifyRequest, method: string, expiresAt?: number): void {
  (req as any).authMethod = method;
  (req as any).authExpiresAt = expiresAt ?? null;
}

/**
 * How the caller was authenticated (`cookie`, `api_key`, `connector_token`, ...),
 * or null when no credential path did (dev bypass, BYOK mode, an anonymous route).
 */
export function getAuthMethod(req: FastifyRequest): string | null {
  return (req as any).authMethod ?? null;
}

/** When the credential this request was authenticated with stops being valid (epoch ms), if it says. */
export function getAuthExpiry(req: FastifyRequest): number | null {
  return (req as any).authExpiresAt ?? null;
}
