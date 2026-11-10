// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The words of the assistant's receipt (teams_agent/stream.py RECEIVED, BACKGROUND, STILL_WORKING). `received` is a line of the
 * floating status, which a phone cuts after a few characters: it stays within WAIT_LINE_MAX_ZH / WAIT_LINE_MAX_EN (remote/lines.ts).
 */
import { defineCatalog } from "./catalog.js";

export const receiptText = defineCatalog({
  en: {
    received: "Working on it…",
    background: "This is running in the background; I will message you here when it is done.",
    alsoLead: "Also: ",
  },
  zh: {
    received: "收到，处理中",
    background: "已转为后台处理，完成后在这里通知你。",
    alsoLead: "另外：",
  },
});
