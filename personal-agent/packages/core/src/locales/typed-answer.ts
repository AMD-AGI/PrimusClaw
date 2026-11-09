// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a typed answer is asked back with (`typed-answer/`). Each says it in Chinese and English at once, in one
 * message: a typed answer comes from a person whose language this agent has not settled, so both are written, as the
 * Python worker wrote them.
 */
export const typedAnswerText = {
  nothingWaits:
    "现在没有在等你确认的合入或 review（可能已经处理过，或已过期）。 / Nothing is waiting for your confirmation now.",
  notWaiting: (p: { name: string; listing: string }): string =>
    `${p.name} 没有在等你确认。在等你确认的是：${p.listing}。 / ${p.name} is not waiting for your confirmation; these are: ${p.listing}.`,
  whichRepo: (p: { name: string; count: number; listing: string; repo: string; number: number }): string =>
    `${p.name} 有 ${String(p.count)} 个：${p.listing}。请写上仓库名，例如「确认 ${p.repo}#${String(p.number)}」。 / ` +
    `Which one? Write the repository, e.g. 确认 ${p.repo}#${String(p.number)}.`,
  which: (p: { listing: string; first: number }): string =>
    `在等你确认的有：${p.listing}。请回复「确认 #${String(p.first)}」「拒绝 #${String(p.first)}」，或「全部确认」/「全部拒绝」。 / ` +
    `These wait for your confirmation: ${p.listing}. Reply 确认 #${String(p.first)} or 拒绝 #${String(p.first)}, or 全部确认 / 全部拒绝.`,
  heldTwice: (p: { pull: string; held: string; pr: number }): string =>
    `${p.pull} 有两项在等你确认：${p.held}。请回复「确认 #${String(p.pr)} 合入」或「确认 #${String(p.pr)} review」（拒绝同理）。 / ` +
    `${p.pull} holds both a merge and a review: reply 确认 #${String(p.pr)} 合入 or 确认 #${String(p.pr)} review.`,
  heldMerge: "合入",
  heldReview: (p: { event: string }): string => `发布 ${p.event} review`,
} as const;
