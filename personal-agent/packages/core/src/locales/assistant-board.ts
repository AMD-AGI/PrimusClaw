// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What `/board` and the work cards' buttons say (teams_agent/assistant.py). The Python worker said these in English, or in both languages at once; kept so. */
import { defineCatalog } from "./catalog.js";

const fixed = {
  notAvailable: "The task board is not available yet.",
  failed: "I could not read your tasks just now. Please try again in a moment.",
  empty: "You have no tasks yet. Tell me what you need done and I will start one.",
  moreWaiting: (p: { n: number }) =>
    `${String(p.n)} more tasks wait for you; answer or accept the ones above and send /board again.`,
  unreachable: "I could not reach PrimusClaw.",
  cardGone: "That button is no longer valid. Send /board to see where your tasks stand.",
  cardUsed: "That card was already used. Send /board to see where your tasks stand.",
  tryAgain: " The card below lets you try again in a moment.",
  pressAgain: " Press a button again in a moment.",
  retryAgain: " Press Retry again in a moment.",
};

export const boardText = defineCatalog({ en: fixed, zh: fixed });
