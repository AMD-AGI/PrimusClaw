// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The service error vocabulary the route layer maps onto HTTP status codes.
 *
 * These lived in the marketplace module because that is where they were first
 * needed, which left unrelated callers -- task-DAG admission, for one --
 * importing an error class from a 2700-line domain module they had no other
 * business with. The dependency was always on the vocabulary, not on the
 * marketplace, so the vocabulary lives on its own.
 *
 * Ported from the original Python implementation's error module.
 */

export class ServiceError extends Error {}
export class NotFoundError extends ServiceError {}
export class AccessDeniedError extends ServiceError {}
export class NotConfiguredError extends ServiceError {}
export class ConflictError extends ServiceError {}
export class BadRequestError extends ServiceError {}
// Upstream (e.g. GitHub archive) failure: maps to HTTP 502 in the API layer,
// matching the Python implementation's ``RuntimeError`` on tool_import failures.
export class BadGatewayError extends ServiceError {}

// Marketplace upsert/duplicate outcomes. Same hierarchy so a caller that only
// cares that something went wrong can still catch ServiceError.
export class UpsertPermissionError extends ServiceError {}
// The plugin name is already registered by another user. A subclass of
// UpsertPermissionError so a caller that only asks "was the upsert refused?"
// still sees a refusal, but the route reports it as a name collision rather
// than a bare "forbidden": the caller is not missing a permission, it has
// picked a name that someone else owns, and the fix is a different name.
export class PluginNameTakenError extends UpsertPermissionError {
  constructor(readonly pluginName: string) {
    super(`plugin name '${pluginName}' belongs to another user; pick another name`);
  }
}
export class UpsertConflictError extends ServiceError {}
export class UpsertToolTypeChangeError extends ServiceError {}
export class ToolDuplicateError extends ServiceError {}
export class ToolVersionDuplicateError extends ServiceError {}
export class PluginDuplicateError extends ServiceError {}
export class ResourceDuplicateError extends ServiceError {}
