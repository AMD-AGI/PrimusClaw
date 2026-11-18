// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the router writes itself: a document, a draft, a translation, a summary. Appended after the router's prompt.
 *
 * Writing needs no shell and no sandbox, and a work item for it cost the user their text: "write me a 1500-word introduction as a
 * markdown file" went to a worker whose sandbox could not start, the worker wrote the text into its last message, nobody read that
 * message, and the user got a line saying the file could not be saved (2026-11-06 parity run, F1). A comment drafted for a pull request
 * went the same way (G2). So the router writes such text itself, hands a file over with `deliver_text` (`text-delivery.ts`) and puts a
 * comment to the user as a card with `github_comment` (`schedules.ts`), which posts it only when they press it.
 *
 * router-write-v1: writing, drafting and translating done by the router; a file with deliver_text; a comment with github_comment.
 * router-write-v2: v1 with what was found said before the comment's card: a message that asks questions about a pull request and for a
 * comment on it is answered first, then the card is put (2026-11-06 parity run, G2: the user saw an approval and none of the answers).
 */
export const ROUTER_WRITING_PROMPT_VERSION = "router-write-v2";

/** `comment`: the router has `github_comment` (the confirmation cards are on). */
export function renderRouterWritingSection(opts: { comment: boolean }): string {
  const comment = opts.comment
    ? "- A comment for a pull request or an issue (留评论, 发个评论, comment on it): read what it is about first (the pull request, its files, its checks), write the comment yourself. When the user also asked about it (what it changes, how many files, its CI, its open threads), say those answers first, with the numbers, and that the comment waits for them on a card; then call github_comment with it. That shows the user the exact comment on a card and posts it as their GitHub account only when they press it: tell them to check the card. Never start a work item to write or post a comment, and never say it was posted.\n"
    : "";
  return `Writing is yours
Writing needs no worker: you write it yourself, in this turn, whatever its length, and that is not a write in the sense of What is a work item, because nothing changes for anyone but the user.
- A text the user asks for (an article, an introduction, notes, an email or a message for them to send, a summary, a translation, a review of a text they gave): write it and say it, whole. Only the text they asked for: no heading such as 译文 before a translation, no offer after it.
- When they ask for it as a file (存成 markdown, 给我一个 md 文件, as a .txt or .csv), or it is longer than one message holds: call deliver_text with a file name and the whole text, then say one short line about the file; never paste the text into say as well.
${comment}- A work item is still the way for what needs a shell, a checkout, a run, data the user attached, or a change to a system.`;
}
