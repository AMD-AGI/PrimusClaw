// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Identifiers a withheld detail is logged with (a session id, an item id); never text a person or an agent wrote. */
export type WithheldIds = Readonly<Record<string, string | number | boolean | null | undefined>>;

/**
 * What a person is told when something failed, and what is kept back for the log. Text the worker did not write (a
 * model gateway's error, a remote agent's reason, Claw's reason for a merge it did not do) can name internal hosts,
 * paths and stack traces; the person gets a short sentence with a reference id instead, and the text goes to the log
 * under that id.
 */
export interface PublicErrors {
  /**
   * Logs `detail` (credential shapes masked, clipped, one line) under a new reference id and returns that id, for the
   * person's sentence. `where` names the path (a fixed word of the caller's).
   */
  withhold(where: string, detail?: unknown, ids?: WithheldIds): string;
  /**
   * `reason` as it may be shown; when it has the shape of internal detail, "an internal error (ref <id>)" with the
   * reason withheld to the log. "" (or blank) stays "".
   */
  publicReason(reason: unknown, where: string, ids?: WithheldIds): string;
}
