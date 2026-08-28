// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

export interface UserInfo {
  userId: string;
  userName: string;
  roles: string[];
  platformKey: string;
  virtualKey: string;
}

export function getUserRole(user: UserInfo): string {
  for (const r of user.roles) {
    if (r === "system-admin") return "system-admin";
  }
  return user.roles.includes("system-admin-readonly") ? "system-admin-readonly" : "default";
}

export function isAdmin(user: UserInfo): boolean {
  const role = getUserRole(user);
  return role === "system-admin" || role === "system-admin-readonly";
}

/** Full `system-admin` only, excluding `system-admin-readonly`. */
export function isSystemAdmin(user: UserInfo): boolean {
  return getUserRole(user) === "system-admin";
}

/**
 * Whether `callerId` is the creator of a session owned by `ownerId`.
 *
 * This is the strict form, with no admin bypass, and it guards the operations
 * that are creator-only by product spec: rename, send-message and delete. Use
 * {@link canAccessSessionAsOperator} for the read / file / control routes, where
 * an admin is allowed through.
 *
 * A null/empty `ownerId` is not proof of ownership. Legacy rows without an
 * owner fail closed for ordinary callers; full system-admins can still recover
 * them through the operator predicates below.
 */
export function canAccessSession(
  ownerId: string | null | undefined,
  callerId: string | null | undefined,
): boolean {
  if (!ownerId) return false;
  return !!callerId && ownerId === callerId;
}

/**
 * Whether `caller` may READ a session owned by `ownerId`, counting the admin
 * roles as platform operators.
 *
 * Cross-tenant access is still blocked for ordinary users — that is the tenant
 * boundary these routes exist to enforce — but an admin needs to inspect a
 * tenant's session to answer a support ticket, so both admin roles pass. Covers
 * session metadata, context usage, children, file listing and file download.
 */
export function canAccessSessionAsOperator(
  ownerId: string | null | undefined,
  caller: UserInfo | null | undefined,
): boolean {
  if (canAccessSession(ownerId, caller?.userId)) return true;
  return !!caller && isAdmin(caller);
}

/**
 * Whether `caller` may WRITE into a session owned by `ownerId`.
 *
 * Same as {@link canAccessSessionAsOperator} except that `system-admin-readonly`
 * is refused: a role named read-only must not be able to mutate a tenant's
 * workspace. Guards `upload` (arbitrary caller content) and `zip-tasks` (writes
 * a zip plus a task marker under the tenant's prefix, and consumes their quota).
 * The creator is unaffected and still writes to their own session.
 */
export function canWriteSessionAsOperator(
  ownerId: string | null | undefined,
  caller: UserInfo | null | undefined,
): boolean {
  if (canAccessSession(ownerId, caller?.userId)) return true;
  return !!caller && isSystemAdmin(caller);
}
