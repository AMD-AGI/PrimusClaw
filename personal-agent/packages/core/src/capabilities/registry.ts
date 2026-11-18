// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the bot can do for a person, as one registry; help is rendered from it (`help.ts`).
 *
 * Help teaches what can be got done, grouped by what it is for, each with one sentence a person would really type on a phone; it
 * does not list commands. The slash commands keep working, and the commands menu has the common ones, which help says once at the
 * end. `test/capabilities.test.ts` walks the code's closed sets and fails when one is not covered by an entry here, and sends every
 * example sentence through the real routing to check it reaches the capability it is the example of.
 */

import type { Capability } from "./capability.js";
import { CHAT_ENTRIES } from "./entries-chat.js";
import { NOTIFY_ENTRIES } from "./entries-notify.js";
import { SETTINGS_ENTRIES } from "./entries-settings.js";

export {
  CATEGORIES,
  type Capability,
  type CapabilityMode,
  type Category,
  type CategoryKey,
  type Part,
  type Where,
} from "./capability.js";

export const CAPABILITIES: readonly Capability[] = [...CHAT_ENTRIES, ...SETTINGS_ENTRIES, ...NOTIFY_ENTRIES];

export function byKey(key: string): Capability {
  const found = CAPABILITIES.find((c) => c.key === key);
  if (found === undefined) throw new RangeError(`no capability ${key}`);
  return found;
}
