// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Deleting a person's own key when they unlink (the Python worker's `safe.revoke_own_key`: authenticate with the key,
 * find its id, delete it). Best effort: the link is removed whatever this answers.
 */
export interface KeyRevoker {
  /** True when the key was deleted; false on any failure (the caller tells the person to delete it themselves). */
  revoke(key: string): Promise<boolean>;
}

/** Nothing to revoke at: every revoke reports that the key is still there. */
export const noKeyRevoker: KeyRevoker = {
  revoke: () => Promise.resolve(false),
};
