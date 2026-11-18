// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { RosterMember } from "../ports/surface.js";

/**
 * A person as the understanding reads them: a row the store keeps of a chat's members (the Python worker's dict, with
 * `name`, `objectId`, `email`, and as the directory gives them `givenName`, `surname`, `userPrincipalName`).
 */
export type PersonRecord = Readonly<Record<string, unknown>>;

/** `str(value or "")`. */
export function textOf(value: unknown): string {
  if (value === undefined || value === null || value === "" || value === false || value === 0) return "";
  if (typeof value === "string") return value;
  return typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
}

/** The person as a roster member, for the name readings shared with the review delegation. */
export function rosterOf(person: PersonRecord): RosterMember {
  return {
    channelUserId: "",
    userId: textOf(person["objectId"]),
    name: textOf(person["name"]),
    givenName: textOf(person["givenName"]),
    surname: textOf(person["surname"]),
    email: textOf(person["email"]),
    userPrincipalName: textOf(person["userPrincipalName"]),
  };
}
