// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The questions a review item asks its owner (`reviewState` in `review-items.ts`), in English and in Chinese. A review session sends no
 * worker report, so its question is the server's, written in English on the item; read alone, a reviewer who writes Chinese got a Chinese
 * frame around an English body ("…卡住了，需要你回复：Look at AMD-AGI/PrimusClaw#646", 2026-11-10 daily gaps, N20). The notice that the
 * item needs its owner (`outbound.ts`) reads the stored English question back into Chinese through `reviewQuestionZh`.
 *
 * One table for both: `reviewState` writes `REVIEW_QUESTIONS.x.en(...)`, and the reading back is derived from the same English templates,
 * so a template changed in one place is still read back.
 */
type Template = { en: (arg: string) => string; zh: (arg: string) => string };

export const REVIEW_QUESTIONS = {
  confirmApproval: { en: (pr) => `Confirm or deny the approval of ${pr}`, zh: (pr) => `确认或拒绝对 ${pr} 的批准` },
  confirmMerge: { en: (pr) => `Confirm or deny the merge of ${pr}`, zh: (pr) => `确认或拒绝合入 ${pr}` },
  reviewAgain: { en: (pr) => `Review ${pr} again?`, zh: (pr) => `要重新评审 ${pr} 吗？` },
  lookAt: { en: (pr) => `Look at ${pr}`, zh: (pr) => `请看一下 ${pr}` },
  lookAtReview: { en: (pr) => `Look at the review of ${pr}`, zh: (pr) => `请看一下 ${pr} 的评审` },
  restartReview: { en: (pr) => `Restart the review of ${pr}?`, zh: (pr) => `要重新开始评审 ${pr} 吗？` },
  lookAtSession: { en: (pr) => `Look at the review session of ${pr}`, zh: (pr) => `请看一下 ${pr} 的评审会话` },
  waitingForApproval: { en: (who) => `Waiting for ${who} to confirm the approval`, zh: (who) => `等 ${who} 确认批准` },
  waitingForMerge: { en: (who) => `Waiting for ${who} to confirm the merge`, zh: (who) => `等 ${who} 确认合入` },
} satisfies Record<string, Template>;

const ARG = "\u0000";
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Each template's English as a pattern whose one group is its argument, built from the template itself; the one with the most fixed text
 * first, so "Look at the review of X" is not read as "Look at" with the argument "the review of X".
 */
const READ_BACK: Array<{ re: RegExp; zh: (arg: string) => string }> = Object.values(REVIEW_QUESTIONS as Record<string, Template>)
  .map((t) => ({ fixed: t.en(ARG).length, re: new RegExp(`^${escape(t.en(ARG)).replace(ARG, "(.+)")}$`), zh: t.zh }))
  .sort((x, y) => y.fixed - x.fixed);

/** The Chinese of a question a review item stores (one of `REVIEW_QUESTIONS`), or null for any other text. */
export function reviewQuestionZh(question: string): string | null {
  for (const { re, zh } of READ_BACK) {
    const m = re.exec(question);
    if (m) return zh(m[1]!);
  }
  return null;
}
