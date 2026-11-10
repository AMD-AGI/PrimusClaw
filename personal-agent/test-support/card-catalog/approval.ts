// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Approval and question cards (W5): the Python catalog's approval_turn, approval_group and question entries. */
import type { ApprovalCardModel, QuestionCardModel } from "@primusclaw/personal-agent";
import { cardQuestions } from "@primusclaw/personal-agent";

import { approvalRenderers } from "../../packages/teams/src/views/approval/index.js";
import { SID, entries } from "./catalog.js";

const PERM_EVENT = {
  summary: "删除 /workspace/PrimusClaw/build 下的旧产物",
  tool_description: "Run a shell command",
  intent: "清理构建产物，腾出磁盘空间",
};

const QUESTIONS = [
  {
    id: "q1",
    question: "要把哪个分支作为基线？",
    options: [
      { id: "main", label: "main" },
      { id: "rel", label: "release/1.4" },
    ],
    allow_multiple: false,
  },
];

function approval(model: Partial<ApprovalCardModel>) {
  return approvalRenderers.approval({
    tool: "bash",
    input: null,
    sessionId: SID,
    toolUseId: "tu-1",
    group: false,
    ownerName: "",
    event: PERM_EVENT,
    lang: "zh",
    ...model,
  });
}

function question(model: Partial<QuestionCardModel>) {
  return approvalRenderers.question({
    questions: cardQuestions(QUESTIONS),
    sessionId: SID,
    toolUseId: "tu-9",
    group: false,
    ownerName: "",
    note: "",
    ...model,
  });
}

export const APPROVAL_CARDS = entries(
  ["approval_turn", () => approval({ input: { command: "rm -rf /workspace/PrimusClaw/build && make clean" } })],
  ["approval_group", () => approval({ input: { command: "make deploy" }, group: true, ownerName: "Robin Lang" })],
  ["question", () => question({})],
);
