// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Every kind of Adaptive Card the personal agent sends in Teams, built by the real builders with fixed, realistic inputs (the card
 * snapshot tests). Each feature line adds its entries in its own module under `test-support/card-catalog/` and lists it in
 * `index.ts`; an entry's id is the name of its snapshot, `test-support/data/card_snapshots/<id>.json` (the Python worker's
 * snapshots, byte for byte, with one fixed substitution: the people and machines in the Python fixtures carry made-up names
 * here, "Lin Mei" and "Robin"/"robin" (same lengths, so no clipping moves). Inputs use the same names.
 */
import type { JsonObject } from "../../packages/teams/src/cards/json.js";

export interface CatalogEntry {
  readonly id: string;
  /** The message activity the card goes out in. */
  readonly build: () => JsonObject;
  /**
   * Emoji the card may carry besides the kit's ICONS and the thumbs: its feature's own icons, taken from the production
   * module that draws them (a remote agent's kind icons), never written out here.
   */
  readonly emoji?: readonly string[];
}

export const NOW = 1793952000.0; // fixed: 2026-11-06 08:00 UTC
export const BASE = "https://claw.example.com";
export const SID = "3f2a9c1e-5b7d-4e21-9a0c-8d6f4b2e1a77";
export const TZ = "Asia/Shanghai";

export function entries(...list: Array<readonly [string, () => JsonObject]>): CatalogEntry[] {
  return list.map(([id, build]) => ({ id, build }));
}

/** `entries`, each allowed `emoji` besides the kit's (a feature whose cards carry icons of their own). */
export function entriesWithEmoji(
  emoji: readonly string[],
  ...list: Array<readonly [string, () => JsonObject]>
): CatalogEntry[] {
  return list.map(([id, build]) => ({ id, build, emoji }));
}
