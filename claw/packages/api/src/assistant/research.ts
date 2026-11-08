// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Deep research (`CLAW_ASSISTANT_RESEARCH`): a report on a topic, with a citation for every finding, made in the background.
 *
 *  - The router hands "research X", "a comparison report on X and Y" to a work item, never writes it from what the model knows
 *    (`ROUTER_RESEARCH_PROMPT`, after the router's writing section, which would otherwise have it write the text itself).
 *  - The worker researches with `web_search` and `web_fetch`, writes a Markdown report whose every finding ends with `[n]` and whose
 *    list of sources gives each number its address, and delivers it with `deliver_text` (`WORKER_RESEARCH_PROMPT`).
 *  - Brain checks that report before it is stored (`ExecuteRequest.cite_check`, Brain's `tools/cite-check.ts`): every cited source is
 *    opened, a finding none of its opened sources supports is marked unverified, a source that could not be opened is marked in the
 *    list, and the file ends with the counts. The model's own text never reaches the user unchecked: the check is on the call, not in
 *    the prompt.
 *
 * Search: `web_search` is whichever backend Brain's deployment names (`WEB_SEARCH_PROVIDER`, `WEB_SEARCH_FALLBACK`); nothing here
 * depends on which.
 *
 * research-v1: the router's hand-off and the worker's method, with deliver_text checked.
 */
import { CLAW_ASSISTANT_ENABLED, CLAW_ASSISTANT_RESEARCH } from "../config.js";
import { TOOL_NAME_PREFIX } from "./prompts.js";

export const RESEARCH_PROMPT_VERSION = "research-v1";

/** Whether research reports are on. */
export function assistantResearchOn(): boolean {
  return CLAW_ASSISTANT_ENABLED && CLAW_ASSISTANT_RESEARCH;
}

/** The tool whose text Brain checks against its citations: the worker's `deliver_text`. */
export const RESEARCH_CHECKED_TOOL = `${TOOL_NAME_PREFIX}deliver_text`;

export const ROUTER_RESEARCH_PROMPT = `Research reports
A request to research a topic and report on it (调研, 研究一下, 出一份对比报告, 综述, 写个调研报告, research, compare X and Y with sources, a report on the state of X) is a work item, not Writing is yours: it needs searches and pages read, which take minutes. Call work_create with a brief that names the topic, what to compare or answer, the language to write it in (the user's), and that the report cites its sources. Never write such a report yourself from what you know. When its result comes back, say the conclusions in a few lines and that the report is attached; the file already carries its sources and the check of them.`;

export const WORKER_RESEARCH_PROMPT = `Research reports
When the item asks for research or a report with sources, this is how it is done.
1. Plan: split the question into 3 to 6 sub-questions (for a comparison, the same points for each thing compared). Report them with report(kind="progress").
2. Search and read: for each sub-question, two to four web_search calls with different wording, the exact names and versions. Then web_fetch the pages that answer it and read the part that does (find, offset); a search result's snippet is never evidence. Prefer primary sources: official documentation, release notes, the project's repository, papers, the vendor's own pages. Stop after about 40 fetches or 25 minutes and report what is still unknown rather than searching on. When web_search fails, search by fetching a search page with web_fetch (https://html.duckduckgo.com/html/?q=<words>) and read the links it lists.
3. Write the report in Markdown, in the language the brief asks for: first the conclusions in a few lines, with the date they hold for; then the findings, a comparison table where things are compared; then disagreements between sources and what is still unknown. Every finding, every table cell with a fact, and every number ends with its citation: [1], or [1][3] for two sources. A finding no page you read states is not written as a finding; if you add your own inference, say so in the sentence and give it no citation.
4. End the report with a list of sources, one per line, in exactly this form: [n]: title — https://the.address/of/the/page. Only pages you opened with web_fetch and read; the address exactly as you fetched it. Every [n] in the text has its line; numbers start at 1.
5. Deliver it with deliver_text (a name such as <topic>-report.md). Before the file is stored, the system opens every source and checks each cited finding against its page: a finding no source supports is marked unverified (未证实), and an address that does not open is marked in the list. The tool's answer begins with what the check found. Check your findings against the pages before you deliver, and deliver the report once: every call is another file the user receives.
6. Then report(kind="answer"): the conclusions in a few lines, the counts the check gave (how many findings are supported, how many unverified), and that the report is attached. Never present an unverified finding as established.`;

/** A worker turn's research part: its method in the system text, and its `deliver_text` checked. Nothing when research is off. */
export function applyWorkerResearch(task: Record<string, unknown>, append: (text: string) => void, on: boolean = assistantResearchOn()): boolean {
  if (!on) {
    delete task.cite_check;
    return false;
  }
  task.cite_check = { tools: [RESEARCH_CHECKED_TOOL] };
  append(WORKER_RESEARCH_PROMPT);
  return true;
}
