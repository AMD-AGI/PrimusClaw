// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the worker appends to a person's message before it goes to Claw, and how it is taken off again: the request
 * for a change summary (the phone has no diff view), then the reply-style rule a Claw rule tool holds.
 */

/** The words after the chat app's name in what the reply-style rule is introduced with. */
const RULE_WORDS = "reply style (formatting only, facts unchanged)";
/** The words after the chat app's name in what the change-summary request is introduced with. */
const CHANGE_WORDS = "change summary (only when files in a git repository changed)";

/** How a heading names the chat app (`SurfaceCaps.shortName`, e.g. "Teams"); with none, the heading's own word leads. */
function headed(channel: string, words: string): string {
  return channel ? `## ${channel} ${words}` : `## ${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** What the reply-style rule is introduced with, e.g. "## Teams reply style (formatting only, facts unchanged)". */
export function ruleHeading(channel: string): string {
  return headed(channel, RULE_WORDS);
}
/** What the change-summary request is introduced with. */
export function changeHeading(channel: string): string {
  return headed(channel, CHANGE_WORDS);
}
/** The change-summary request: about the answer's last lines, not a style, so it is kept apart from the rule. */
export const CHANGE_SUMMARY_RULE =
  "If during this task you changed files in a git working tree, end your answer with a short section titled " +
  "**Changes**: in one code block, the output of `git diff --stat HEAD` (and, for a new file git does not track yet, " +
  'its line from `git status --short`), at most 15 lines, then "+N more files" for the rest. Read-only commands ' +
  "only; do not stage, commit or push to produce it. If nothing in a git working tree changed, leave the section out.";
/** Exactly what the worker appends first, whether or not a rule follows. */
export function changeSection(channel: string): string {
  return `\n\n${changeHeading(channel)}\n\n${CHANGE_SUMMARY_RULE}`;
}
/** A rule is edited in Claw; a changed rule reaches the chat within this. */
export const RULE_TTL_MS = 600_000;
/** A reply-style rule is about 1 KB; anything this large is not one. */
export const RULE_MAX_BYTES = 32_768;

/** A regular expression for `text` as it is written. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A heading that ends with `words`, after any chat app's name (or none): "\n\n## <name> <words>". */
function anyHeading(words: string): string {
  const first = words.charAt(0);
  return `\n\n## (?:[^\n]* )?[${first}${first.toUpperCase()}]${literal(words.slice(1))}`;
}

const CHANGE_SECTIONS = new RegExp(`${anyHeading(CHANGE_WORDS)}\n\n${literal(CHANGE_SUMMARY_RULE)}`, "g");
const RULE_HEADINGS = new RegExp(anyHeading(RULE_WORDS));

/**
 * `text` as the person wrote it, with what the worker appended taken off again, whichever chat app's name the headings
 * carry. The change summary is a fixed text and always the first thing appended, so it marks where the person's own words
 * end: it is looked for from the end, and everything from it on goes. A message from before the request existed has only
 * the rule: it is cut where the rule's heading first starts.
 */
export function withoutRule(text: string): string {
  const at = [...text.matchAll(CHANGE_SECTIONS)].at(-1)?.index ?? text.search(RULE_HEADINGS);
  return at === -1 ? text : text.slice(0, at);
}

/**
 * The content of a message to a plain session: the person's text, then the change-summary request (only where a rule
 * tool is configured), then the rule when there is one. `channel`: the chat app's short name the headings carry.
 */
export function messageContent(text: string, rule: string, withRuleTool: boolean, channel: string): string {
  const sections = [
    ...(withRuleTool ? [changeSection(channel).replace(/^\n+|\n+$/g, "")] : []),
    ...(rule === "" ? [] : [`${ruleHeading(channel)}\n\n${rule}`]),
  ];
  return [text, ...sections].join("\n\n");
}
