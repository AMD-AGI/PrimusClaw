// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The words of the assistant's receipt (teams_agent/stream.py RECEIVED, BACKGROUND, STILL_WORKING). */
import { defineCatalog } from "./catalog.js";

export const receiptText = defineCatalog({
  en: {
    received: "Got it, working on it…",
    background: "This is running in the background; I will message you here when it is done.",
    alsoLead: "Also: ",
  },
  zh: {
    received: "收到，正在处理…",
    background: "已转为后台处理，完成后在这里通知你。",
    alsoLead: "另外：",
  },
});
