// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Who a Claw key belongs to, asked of the platform that issued it (the Python worker's `safe.whoami`, `safe.safe_user`
 * and `safe.user_id_of`: one `/users/self` call made with the key itself). Used when a person links a key, to record
 * whose it is, and to check that a key presented later is the same person's.
 */
export interface KeyOwner {
  /** The platform's user id ("" when it gave none). */
  readonly id: string;
  /** The display name ("" when it gave none). */
  readonly name: string;
  /** "" when it gave none. */
  readonly email: string;
  /** The account type, lower case ("sso", "default", ...; "" when it gave none). */
  readonly accountType: string;
}

export interface IdentityLookup {
  /** The owner of `key`; undefined on any failure (unreachable, rejected, malformed answer): the caller says so. */
  ownerOfKey(key: string): Promise<KeyOwner | undefined>;
}

/** No platform to ask: nobody is known. */
export const noIdentityLookup: IdentityLookup = {
  ownerOfKey: () => Promise.resolve(undefined),
};
