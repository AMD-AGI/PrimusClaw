// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What reaches a person unasked, and approvals once answered (W5): the Python catalog's approval_proactive, approval_item,
 * approval_decided, approval_expired, question_item, answered, run_completed, run_failed and digest entries, with the same inputs.
 */
import { approvalRenderers } from "../../packages/teams/src/views/approval/index.js";
import { proactiveRenderers } from "../../packages/teams/src/views/proactive/index.js";
import { BASE, NOW, SID, TZ, entries } from "./catalog.js";

export const APPROVAL_EVENT = {
  type: "approval.requested",
  session_id: SID,
  link: `/primus-claw/${SID}`,
  approval: { tool: "bash", tool_use_id: "tu-1", target: "rm -rf /workspace/PrimusClaw/build && make clean" },
};

export const ITEM_APPROVAL_EVENT = {
  type: "approval.requested",
  session_id: SID,
  link: `/primus-claw/${SID}`,
  source: "assistant_item",
  summary: "在 PrimusClaw 仓库上推送分支 teams/card-style",
  item: { seq: 13, title: "整理本周 SaFE 节点故障" },
  approval: { tool: "git_push", tool_use_id: "tu-2", target: "git push origin teams/card-style" },
};

export const ITEM_QUESTION_EVENT = {
  type: "approval.requested",
  session_id: SID,
  source: "assistant_item",
  summary: "需要你选择告警频道",
  item: { seq: 11, title: "给 fleetpilot 加超时告警" },
  approval: { tool: "ask_user_question", tool_use_id: "tu-3" },
  questions: [
    {
      id: "q1",
      question: "告警发到哪个 Teams 频道？",
      options: [
        { id: "o1", label: "Primus 运维" },
        { id: "o2", label: "FleetPilot 值班" },
      ],
    },
  ],
};

const RUN = { session_id: SID, link: `/primus-claw/${SID}` };

export const PROACTIVE_CARDS = entries(
  [
    "approval_proactive",
    () =>
      proactiveRenderers.proactiveApproval({
        event: APPROVAL_EVENT,
        publicBaseUrl: BASE,
        expiresAt: NOW + 1800,
        zone: TZ,
      }),
  ],
  [
    "approval_item",
    () =>
      proactiveRenderers.itemApproval({
        event: ITEM_APPROVAL_EVENT,
        publicBaseUrl: BASE,
        expiresAt: NOW + 1800,
        zone: TZ,
      }),
  ],
  ["approval_decided", () => approvalRenderers.approvalDecided({ tool: "bash", action: "allow", when: NOW, zone: TZ })],
  ["approval_expired", () => approvalRenderers.approvalExpired({ tool: "bash" })],
  ["question_item", () => proactiveRenderers.itemQuestion({ event: ITEM_QUESTION_EVENT })],
  ["answered", () => approvalRenderers.questionAnswered({ answers: [["q1", "main"]], when: NOW, zone: TZ })],
  [
    "run_completed",
    () =>
      proactiveRenderers.runEvent({
        event: {
          type: "run.completed",
          ...RUN,
          title: "整理本周 SaFE 节点故障",
          summary: "38 台节点里 5 台反复掉线，都在 rack-12；建议先换交换机端口。",
        },
        publicBaseUrl: BASE,
      }),
  ],
  [
    "run_failed",
    () =>
      proactiveRenderers.runEvent({
        event: {
          type: "run.failed",
          ...RUN,
          title: "给 fleetpilot 加超时告警",
          summary: "沙箱启动超时，没有执行任何改动。",
        },
        publicBaseUrl: BASE,
      }),
  ],
  [
    "digest",
    () =>
      proactiveRenderers.digest({
        events: [
          { type: "run.completed", ...RUN, title: "整理本周 SaFE 节点故障" },
          { type: "run.failed", session_id: "s2", link: "/primus-claw/s2", title: "给 fleetpilot 加超时告警" },
        ],
        expiredApprovals: 1,
        publicBaseUrl: BASE,
      }),
  ],
);
