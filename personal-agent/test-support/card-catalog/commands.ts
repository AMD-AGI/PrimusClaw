// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The cards of connecting and of the chat's own commands (W4), with the Python catalog's inputs. */
import { AI_NOTICE } from "@primusclaw/personal-agent";

import {
  bindingCard,
  linkCard,
  onboardingCard,
  repoCard,
  sessionCard,
} from "../../packages/teams/src/views/commands/index.js";
import { BASE, entries, SID } from "./catalog.js";

export const COMMAND_CARDS = entries(
  [
    "session",
    () =>
      sessionCard({
        sessionId: SID,
        title: "整理本周 SaFE 节点故障",
        repo: "AMD-AGI/Primus-SaFE",
        branch: "main",
        when: "今天 15:00",
        current: true,
        lang: "zh",
        publicBaseUrl: BASE,
      }),
  ],
  ["repo", () => repoCard({ repo: "AMD-AGI/Primus-SaFE", branch: "main", lang: "zh" })],
  [
    "onboarding",
    () =>
      onboardingCard({
        bot: "Clawy",
        name: "Lin Mei",
        channelUserId: "29:abc",
        promptId: "pr-1",
        dmSent: false,
        note: "",
        waitMinutes: 15,
      }),
  ],
  [
    "binding",
    () =>
      bindingCard({
        bot: "Clawy",
        confirmUrl: "https://claw.example.com/sign-in/confirm?c=xyz",
        lead: "",
        notice: AI_NOTICE.en,
      }),
  ],
  [
    "link",
    () =>
      linkCard({
        bot: "Clawy",
        who: "robin.lang@example.com",
        page: `${BASE}/primus-claw/teams-link`,
        notice: AI_NOTICE.en,
      }),
  ],
);
