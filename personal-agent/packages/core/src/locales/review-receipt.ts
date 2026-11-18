// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a review's one message says where it was asked: the verdict and whether it merged, the model it ran on, the tools'
 * plain words, and the shortening of a long answer. Both languages; the request's language picks one.
 */

/** A tool name or state the model wrote by its code, in plain words: [Chinese, English]. */
export const PLAIN_WORDS: Readonly<Record<string, readonly [string, string]>> = {
  gh_pr_get: ["读取 PR", "reading the pull request"],
  gh_pr_risk: ["风险检查", "the risk check"],
  gh_review_submit: ["提交评审", "submitting the review"],
  gh_pr_merge: ["合入", "merging"],
  dry_run: [
    "演练模式（写入关闭，GitHub 上没有发生任何事）",
    "practice mode (writes are off, nothing happened on GitHub)",
  ],
  confirmation_required: ["等确认", "waiting for confirmation"],
  delegation_off: ["自动合入已关闭", "auto-merge is switched off"],
  cannot_approve_own_pull_request: ["不能批准自己提交的 PR", "it cannot approve its own pull request"],
  acting_login_unknown: ["不知道对方的 GitHub 用户名", "the GitHub username is not known"],
  enqueue_refused: ["合并队列拒绝了", "the merge queue refused it"],
  github_workflow_scope_missing: ["缺少 GitHub 的 workflow 权限", "GitHub's workflow permission is missing"],
  enqueue_unconfirmed: ["不确定是否已进入合并队列", "it is not known whether it is in the merge queue"],
  review_target_mismatch: ["这次 review 绑定的是另一个 PR", "this review is bound to another pull request"],
  queue_position: ["队列位置", "queue position"],
};

export const DRY_RUN_ZH = "演练模式（写入关闭，GitHub 上没有发生任何事）";

const EVENT_ZH: Readonly<Record<string, string>> = { APPROVE: "批准", REQUEST_CHANGES: "要求修改", COMMENT: "评论" };
const EVENT_EN: Readonly<Record<string, string>> = {
  APPROVE: "approved",
  REQUEST_CHANGES: "changes requested",
  COMMENT: "commented",
};

/** [verdict zh, verdict en, merge state zh, merge state en] of a merge call that came back with `status`. */
export function mergeWords(actor: string, status: string): readonly [string, string, string, string] {
  const known: Readonly<Record<string, readonly [string, string]>> = {
    merged: ["已合入", "merged"],
    queued: ["已加入合并队列，是否合入由队列决定", "put in the merge queue; the queue decides whether it merges"],
    confirmation_required: [
      `合入等 ${actor} 确认，还没有合入`,
      `the merge waits for ${actor} to confirm; not merged yet`,
    ],
    dry_run: [`${DRY_RUN_ZH}，没有合入`, "practice run (writes are off), not merged"],
    enqueue_unconfirmed: [
      "不确定是否已进入合并队列，请看一下 PR",
      "not known whether it is in the merge queue; look at the PR",
    ],
  };
  const line = Object.hasOwn(known, status) ? known[status] : undefined;
  if (line !== undefined) return ["review 通过", "review passed", line[0], line[1]];
  const plain = Object.hasOwn(PLAIN_WORDS, status) ? PLAIN_WORDS[status] : undefined;
  return plain
    ? ["没有合入", "not merged", plain[0], plain[1]]
    : ["没有合入", "not merged", "合入没有完成", "the merge did not go through"];
}

/** [zh, en] of the verdict of a review call that came back with `status` and the review `event`. */
export function reviewWords(actor: string, status: string, event: string): readonly [string, string] {
  if (status === "submitted") {
    return [
      `review 完成：${Object.hasOwn(EVENT_ZH, event) ? (EVENT_ZH[event] ?? "") : "已提交评审"}`,
      `review done: ${Object.hasOwn(EVENT_EN, event) ? (EVENT_EN[event] ?? "") : "review posted"}`,
    ];
  }
  if (status === "confirmation_required") return [`评审等 ${actor} 确认`, `the review waits for ${actor} to confirm`];
  if (status === "dry_run") return [DRY_RUN_ZH, "practice run (writes are off)"];
  const plain = Object.hasOwn(PLAIN_WORDS, status) ? PLAIN_WORDS[status] : undefined;
  return plain
    ? [`评审没有提交：${plain[0]}`, `the review was not posted: ${plain[1]}`]
    : ["评审没有提交", "the review was not posted"];
}

export function notMergedWords(reviewOnly: boolean): readonly [string, string] {
  return reviewOnly ? ["只 review，没有合入", "review only, not merged"] : ["没有合入", "not merged"];
}

/** The one note of the model a review ran on, and (`autoOf`) that it ran under the reviewer's fully automatic setting. */
export function modelNoteText(name: string, zh: boolean, autoOf: string): string {
  if (zh) return `（模型：${name || "默认模型"}${autoOf ? `；按 ${autoOf} 的全自动设置，无需人工确认` : ""}）`;
  const auto = autoOf ? `; under ${autoOf}'s fully automatic setting, nobody was asked to confirm` : "";
  return `(model: ${name || "the default model"}${auto})`;
}

export const reviewReceiptText = {
  summaryLabel: { zh: "PR 概述：", en: "What it does: " },
  shortened: "\n\n... (shortened)",
  openFull: (link: string) => `\n\n[Open the full answer (only the person who asked can open it)](${link})`,
  resultLine: (p: { zh: boolean; pull: string; verdict: string; line: string; note: string; url: string }) =>
    p.zh
      ? `${p.pull}：${p.verdict}，${p.line}${p.note}\n${p.url}\n\n完整结论随后发出。`
      : `${p.pull}: ${p.verdict}, ${p.line} ${p.note}\n${p.url}\n\nThe full summary follows.`,
  headlineBare: (p: { zh: boolean; pull: string; note: string; url: string }) =>
    p.zh ? `${p.pull}${p.note}\n${p.url}` : `${p.pull} ${p.note}\n${p.url}`,
  headline: (p: {
    zh: boolean;
    pull: string;
    verdict: string;
    line: string;
    comments: number;
    note: string;
    url: string;
  }) =>
    p.zh
      ? `${p.pull}：${p.verdict}，${p.line}，${String(p.comments)} 条行内评论${p.note}\n${p.url}`
      : `${p.pull}: ${p.verdict}, ${p.line}, ${String(p.comments)} inline comment${p.comments === 1 ? "" : "s"} ${p.note}\n${p.url}`,
} as const;
