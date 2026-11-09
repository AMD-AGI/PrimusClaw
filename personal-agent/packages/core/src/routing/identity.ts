// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { IdentityLookup, KeyOwner } from "../plugins/identity-lookup.js";

/**
 * What the router asks of the platform that issued a key (the Python `safe.whoami`, `safe.safe_user`, `safe.user_id_of`):
 * one owner lookup, read three ways. A lookup that fails says nothing.
 */
export class KeyOwners {
  constructor(private readonly identity: IdentityLookup) {}

  /** The owner when the platform named them ("" names are no owner, as `safe_user` reads it). */
  async owner(key: string): Promise<KeyOwner | undefined> {
    const owner = await this.identity.ownerOfKey(key);
    return owner !== undefined && owner.name.trim() !== "" ? owner : undefined;
  }

  /** [name, email] of the key's owner (`safe.whoami`). */
  async whoami(key: string): Promise<readonly [string, string] | undefined> {
    const owner = await this.owner(key);
    return owner === undefined ? undefined : [owner.name.trim(), owner.email.trim()];
  }

  /** The platform's id of the key's owner (`safe.user_id_of`). */
  async userIdOf(key: string): Promise<string | undefined> {
    const owner = await this.identity.ownerOfKey(key);
    const id = owner?.id.trim() ?? "";
    return id === "" ? undefined : id;
  }

  /** " to SaFE user NAME (EMAIL)" for the key, or undefined when the platform cannot say (`Agent._who_line`). */
  async whoLine(key: string | undefined, withEmail = true): Promise<string | undefined> {
    const who = key ? await this.whoami(key) : undefined;
    if (who === undefined) return undefined;
    const [name, email] = who;
    return ` to SaFE user ${name}` + (email && withEmail ? ` (${email})` : "");
  }
}
