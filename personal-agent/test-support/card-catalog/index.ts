// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The card catalog: every feature's entries. A line that ports a feature's cards adds its module here and takes its ids off
 * `PENDING` (snapshots whose builders are not ported yet, with the line that ports them).
 */
import { APPROVAL_CARDS } from "./approval.js";
import { ASSISTANT_CARDS } from "./assistant.js";
import type { CatalogEntry } from "./catalog.js";
import { COMMAND_CARDS } from "./commands.js";
import { FEEDBACK_CARDS } from "./feedback.js";
import { PROACTIVE_CARDS } from "./proactive.js";
import { REMOTE } from "./remote.js";
import { REVIEW_CARDS } from "./review.js";
import { TURN } from "./turn.js";

export const CATALOG: readonly CatalogEntry[] = [
  ...APPROVAL_CARDS,
  ...ASSISTANT_CARDS,
  ...COMMAND_CARDS,
  ...PROACTIVE_CARDS,
  ...REMOTE,
  ...TURN,
  ...REVIEW_CARDS,
  ...FEEDBACK_CARDS,
];

const BY_LINE: Readonly<Record<string, readonly string[]>> = {}; // (every line has registered its cards)

/** Snapshot ids whose builders are not ported yet. Each line removes its own as it registers them. */
export const PENDING: ReadonlySet<string> = new Set<string>(Object.values(BY_LINE).flat());
