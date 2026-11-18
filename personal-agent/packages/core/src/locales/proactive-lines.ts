// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The lines the delivery of unasked messages says itself (teams_agent/proactive.py). */
import { defineCatalog } from "./catalog.js";

const releaseLines = {
  olderSaid: (p: { n: number }) =>
    `${String(p.n)} earlier messages from your assistant are not shown here. Send /board to see where your tasks stand.`,
  olderRemote: (p: { n: number }) =>
    `${String(p.n)} earlier messages from your remote agent are not shown here: \`/agent sessions\` takes you back to the session.`,
};

export const proactiveLines = defineCatalog({
  en: {
    lostTurnLead: (p: { bot: string; prompt: string }) =>
      `A restart of ${p.bot} interrupted the last turn. Here is the answer to what you asked, “${p.prompt}”:`,
    ...releaseLines,
  },
  zh: {
    lostTurnLead: (p) => `${p.bot} 重启打断了上一轮，这是你问的「${p.prompt}」的回答：`,
    ...releaseLines,
  },
});
