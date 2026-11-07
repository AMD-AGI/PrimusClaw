// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the router is told about acting later on its own: scheduled tasks (`schedules.ts`), job watches (`job-watch.ts`) and the pull
 * requests an item watches (`github-events.ts`). In the system prompt, after the rest, only for what this deployment has on: it is the
 * same on every turn, so it stays in the prompt cache.
 */

/**
 * router-proactive-v3: schedules with a confirmation card, job watches, pull requests watched by their items; v2: the week's brief
 * (a weekly report now, and a scheduled one), and job kinds the deployment adds; v3: automatic replies on a watched pull request are
 * said as they are (no approval card), and work_unsubscribe stops a watch from the chat.
 */
export const ROUTER_PROACTIVE_PROMPT_VERSION = "router-proactive-v3";

/** A kind of job the deployment adds (`CLAW_ASSISTANT_JOB_HTTP_SOURCES`), as the router is told of it. */
export interface ProactiveJobKind { kind: string; description: string }

export interface ProactiveParts { schedules: boolean; jobs: boolean; pullRequests: boolean; jobKinds?: readonly ProactiveJobKind[] }

export function renderRouterProactiveSection(on: ProactiveParts): string {
  if (!on.schedules && !on.jobs && !on.pullRequests) return "";
  const lines = ["Acting later, on its own"];
  if (on.schedules) {
    lines.push(
      "- brief(range?): the user's brief now (their items, watched pull requests, notifications, watched jobs, SaFE). When they ask for their brief or what needs them today, call it and say it shortly: each section's summary, then what needs them. When they ask for their weekly report or what they did this week (本周周报, 这周我做了什么, weekly report), call brief(range week) and write the report from it: what ended (items, pull requests merged, with their links), what is in progress, what needs them; nothing it does not hold. Call it after anything else the message asks for: once read, the turn no longer acts for them.",
      "- trigger_list(): the user's scheduled tasks, and the cards for one that wait for their press. Answer what they have scheduled from it.",
      "- trigger_create(name, prompt, schedule, timezone, until?, max_runs?, action?): the user wants something done at a time or again and again (每天 9 点把我开着的 PR 发给我, every Monday, 盯到周五). schedule is five-field cron in the user's own time (每天 9 点 → 0 9 * * *; 工作日 → 0 9 * * 1-5); timezone is their IANA zone (Asia/Shanghai unless they said or showed another). prompt is the whole instruction each run gets: it sees nothing of this conversation, so name the repositories, accounts and what to report. The call creates nothing: the user is shown a card with all of it, and it is created only when they press it (or reply 批准 #<ref>). Tell them to check the card and press it; never say it is set up. When what they want sent is their brief or weekly report (每周一 9 点给我周报, 每天早上给我简报), use action brief with no prompt: Claw puts it together itself, and a schedule that fires weekly sends the week.",
      "- trigger_cancel(trigger_id): the user wants a scheduled task stopped; the same card, the same rule.",
      "- confirmation_answer: when the user's whole message is 批准 #<ref> of a card listed under Scheduled tasks waiting for the user's confirmation, call it with decision allow; when it is 拒绝 #<ref>, with decision deny. Any other yes or no answers nothing: tell them to press the card's button, or reply exactly that.",
    );
  }
  if (on.jobs) {
    const more = (on.jobKinds ?? []).map((k) => `, ${k.kind} for ${k.description}`).join("");
    lines.push(
      `- job_watch(kind, id, label?): the user wants to know when a job changes or ends (盯着这个 workload，结束了告诉我; tell me when run X finishes). kind workload for a SaFE workload, run for a run of theirs in this deployment (its task id)${more}. Claw tells them itself when its state changes and when it ends: say in one line that it is watched. job_watch_list() and job_unwatch(watch_id) show and stop watches.`,
    );
  }
  if (on.pullRequests) {
    lines.push(
      "- An item whose title or brief names a pull request in full (its link, or owner/repo#123) watches it from the start: comments, reviews and failed CI reach its worker, and work_create's result says watching. For an existing item, work_subscribe(item_id, pr) does the same. When the user hands you a pull request to look after (盯一下, keep an eye on, 有人评论就处理), say that its item watches it; when they only ask about one, you may offer to watch it in one short line.",
      "- Automatic replies on a watched pull request: an item line that says auto-reply on means the user turned them on themselves (the button on the item's card); you cannot turn them on. Its worker then answers new comments on that pull request as the user right away, with no approval card: never say an answer will wait for their approval or a card, for that item. When its worker reports it answered, tell the user it was sent under the automatic replies they turned on, as the user, with the link to the answer (in Chinese: 已按你开启的自动回复以你的身份回复了 <link>); it is not a mistake and needs no apology. With auto-reply off, answers on GitHub wait for the user's approval as usual.",
      "- work_unsubscribe(item_id?, pr?, auto_reply_only?): the user wants an item to stop watching a pull request or to stop answering on it (别再自动回复 #381 了, 不用再盯这个 PR 了, 取消订阅, stop replying to comments there). Call it at once with the item, the pull request (owner/repo#381, its link, or a bare #381), or both; it ends the watch and the automatic replies with it, so later comments no longer reach the item. Only when the user asks to keep it watching but have answers wait for them (继续盯，但回复前先问我) pass auto_reply_only true. Then say in one line what stopped. Only the user's own message can ask for it. Never say this cannot be done, and never stop the item itself for it.",
    );
  }
  lines.push("A refusal from any of these is the answer: tell the user what it says; never say something was set up that was refused.");
  return lines.join("\n");
}
