// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The cards of the person's personal skills: saved (new and updated), deleted, a draft to save, and the edit form. */
import type { SkillCardEvent } from "@primusclaw/personal-agent";

import { skillRenderers } from "../../packages/teams/src/views/skills/index.js";
import { entries } from "./catalog.js";

const STANDUP: SkillCardEvent = {
  kind: "saved",
  name: "standup-notes",
  version: 1,
  created: true,
  description: "写站会纪要时使用（standup、站会）",
  manual: false,
  files: ["templates/notes.md"],
  preview: "## 何时用\n写站会纪要时。\n## 步骤\n1. 昨天完成\n2. 今天计划\n3. 阻塞",
  changeId: "c0ffee00-0000-4000-8000-000000000001",
};

const card = (
  skill: SkillCardEvent,
  lang: "zh" | "en",
  extra: { cardId?: string; allowLabel?: string; note?: string; ended?: boolean } = {},
) => skillRenderers.skillCard({ skill, cardId: "card-8", allowLabel: "", note: "", ended: false, lang, ...extra });

export const SKILL_CARDS = entries(
  ["skill_saved", () => card(STANDUP, "zh")],
  [
    "skill_updated_manual_en",
    () =>
      card(
        {
          ...STANDUP,
          name: "deploy-prod",
          version: 3,
          created: false,
          manual: true,
          description: "Deploy to production with a canary first",
          files: [],
          preview: "## Steps\n1. Canary\n2. Watch\n3. Roll out",
        },
        "en",
      ),
  ],
  ["skill_deleted", () => card({ ...STANDUP, kind: "deleted", preview: "" }, "zh")],
  ["skill_draft", () => card({ ...STANDUP, kind: "draft", changeId: "" }, "zh", { allowLabel: "保存" })],
  ["skill_undone", () => card(STANDUP, "zh", { ended: true, note: "已撤销：standup-notes 已删除。" })],
  [
    "skill_edit",
    () =>
      skillRenderers.skillEdit({
        cardId: "card-8",
        name: "standup-notes",
        description: "写站会纪要时使用（standup、站会）",
        content: "## 何时用\n写站会纪要时。\n## 步骤\n1. 昨天完成\n2. 今天计划\n3. 阻塞",
        note: "",
        lang: "zh",
      }),
  ],
);
