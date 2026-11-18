// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The assistant's cards (W5): the Python catalog's board, board_asked, work_result, work_question, work_done, work_stopped,
 * assistant_action, and assistant_confirm entries, with the same inputs.
 */
import type { AskerView, ReviewAskedOfOther, WorkItem } from "@primusclaw/personal-agent";

import { assistantRenderers } from "../../packages/teams/src/views/assistant/index.js";
import { NOW, entries } from "./catalog.js";

/** A work item as the Python catalog's `wi` makes one: #12, waiting for the person with v2 to accept. */
export function wi(fields: Partial<WorkItem> = {}): WorkItem {
  return {
    itemId: "it-1",
    seq: 12,
    title: "审 AMD-AGI/Primus-SaFE#481",
    boardState: "needs_you",
    resultVersion: 2,
    canAccept: true,
    lastReportKind: null,
    pendingQuestion: null,
    summary: "",
    outcome: null,
    kind: "task",
    params: {},
    pull: null,
    updatedAt: "",
    ...fields,
  };
}

function iso(secondsAgo: number): string {
  return new Date((NOW - secondsAgo) * 1000).toISOString();
}

const done = { boardState: "done", canAccept: false } as const;
const running = { boardState: "in_progress", canAccept: false } as const;

export function boardItems(): WorkItem[] {
  return [
    wi({
      ...running,
      itemId: "a",
      updatedAt: iso(420),
      seq: 14,
      title: "审 example-org/example-repo#292",
      summary: "正在看 github_review.py 的跟踪逻辑，已读 9 个文件",
      kind: "review",
    }),
    wi({
      ...running,
      itemId: "b",
      updatedAt: iso(10800),
      seq: 13,
      title: "整理本周 SaFE 节点故障",
      summary: "已汇总 38 台节点",
    }),
    wi({ itemId: "c", updatedAt: iso(1500), seq: 12, title: "审 AMD-AGI/Primus-SaFE#481" }),
    wi({
      itemId: "d",
      updatedAt: iso(18000),
      seq: 11,
      title: "给 fleetpilot 加超时告警",
      canAccept: false,
      pendingQuestion: "告警发到哪个 Teams 频道？",
    }),
    wi({ ...done, itemId: "e", updatedAt: iso(172800), seq: 9, title: "审 AMD-AGI/Hyperloom#77", outcome: "accepted" }),
    wi({ ...done, itemId: "f", updatedAt: iso(259200), seq: 8, title: "清理过期的 worktree", outcome: "stopped" }),
    wi({
      ...done,
      itemId: "g",
      updatedAt: iso(300000),
      seq: 7,
      title: "升级 SaFE 节点驱动到 6.4",
      outcome: "accepted",
    }),
    wi({
      ...done,
      itemId: "h",
      updatedAt: iso(400000),
      seq: 6,
      title: "审 AMD-AGI/Primus-SaFE#470",
      outcome: "dropped",
    }),
    wi({
      ...running,
      itemId: "i",
      updatedAt: iso(5400),
      seq: 15,
      title: "排查 mi355x 训练任务 OOM",
      summary: "复现中：第 3 次运行",
    }),
    wi({
      ...running,
      itemId: "j",
      updatedAt: iso(9000),
      seq: 16,
      title: "写本周 PrimusClaw Assistant 周报",
      summary: "已整理 12 条",
    }),
    wi({
      ...running,
      itemId: "k",
      updatedAt: iso(12000),
      seq: 17,
      title: "审 AMD-AGI/Hyperloom#80",
      summary: "排队中",
      kind: "review",
    }),
  ];
}

/** What the asker of a review may know of it, Claw's defaults for what it did not say. */
export function askerView(fields: Partial<AskerView> & Pick<AskerView, "itemId" | "status">): AskerView {
  return { prUrl: "", verdict: "", merged: false, waitingFor: "", findings: null, note: "", prSummary: "", ...fields };
}

function asked(itemId: string, reviewer: string, fields: Partial<AskerView> & Pick<AskerView, "status">) {
  return { itemId, reviewer, view: askerView({ itemId, ...fields }) };
}

const PULL = "https://github.com/AMD-AGI/PrimusClaw/pull/";
const ASKED: ReviewAskedOfOther[] = [
  asked("kwi_1", "Lin Mei", {
    status: "waiting_for_reviewer",
    prUrl: `${PULL}331`,
    verdict: "approve",
    waitingFor: "confirm_merge",
  }),
  asked("kwi_2", "Lin Mei", { status: "in_progress", prUrl: `${PULL}329` }),
  asked("kwi_3", "Zhang San", { status: "done", prUrl: `${PULL}318`, verdict: "approve", merged: true }),
];

function board(withAsked: boolean) {
  return assistantRenderers.board({
    items: boardItems(),
    asked: withAsked ? ASKED : [],
    now: NOW,
    accept: [],
    retry: [],
    lang: null,
  });
}

function work(item: WorkItem, text: string, cardId: string) {
  return assistantRenderers.workCard({ item, text, cardId, note: "", watch: false, watching: false, lang: null });
}

const [, , result, question] = boardItems() as [WorkItem, WorkItem, WorkItem, WorkItem];

export const ASSISTANT_CARDS = entries(
  ["board", () => board(false)],
  ["board_asked", () => board(true)],
  [
    "work_result",
    () =>
      work(
        result,
        "审完了：一处需要改（凭据轮换没有加锁），其余没有问题。\n要我按这个结论在 GitHub 上提交 review 吗？",
        "card-2",
      ),
  ],
  ["work_question", () => work(question, "告警发到哪个 Teams 频道？", "card-3")],
  ["work_done", () => assistantRenderers.workDone({ verb: "Accepted", item: result })],
  ["work_stopped", () => assistantRenderers.workDone({ verb: "已停止 / Stopped", item: result })],
  [
    "assistant_action",
    () =>
      assistantRenderers.actionCard({
        text: "要我把这个 PR 交给 Lin Mei 代审吗？会以他的身份 review，通过后合入。",
        cardId: "card-4",
        command: "/review AMD-AGI/Primus-SaFE#481 @Lin Mei",
        lang: null,
      }),
  ],
  [
    "assistant_confirm",
    () =>
      assistantRenderers.confirmWrite({
        text: "每天 09:00 给你发 SaFE 节点日报（工作日）。",
        cardId: "card-5",
        allowLabel: "创建定时任务",
        lang: "zh",
      }),
  ],
  [
    "assistant_choice",
    () =>
      assistantRenderers.choiceCard({
        text: "部署到哪个集群？",
        cardId: "card-6",
        options: ["prod（生产）", "staging（测试）", "两个都部署"],
        multiple: false,
        note: "",
        lang: null,
      }),
  ],
  [
    "assistant_choice_multi",
    () =>
      assistantRenderers.choiceCard({
        text: "Which repositories should the weekly report cover?",
        cardId: "card-7",
        options: ["AMD-AGI/PrimusClaw", "AMD-AGI/Primus-SaFE", "AMD-AGI/Primus-Turbo"],
        multiple: true,
        note: "",
        lang: null,
      }),
  ],
  [
    "assistant_choice_again",
    () =>
      assistantRenderers.choiceCard({
        text: "",
        cardId: "card-6",
        options: ["prod（生产）", "staging（测试）"],
        multiple: false,
        note: "请先选一项，再点发送。",
        lang: "zh",
      }),
  ],
  [
    "assistant_choice_sent",
    () =>
      assistantRenderers.choiceChosen({
        text: "部署到哪个集群？",
        chosen: ["prod（生产）", "staging（测试）"],
        lang: "zh",
      }),
  ],
);
