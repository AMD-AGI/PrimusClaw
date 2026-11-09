// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the worker appends to a person's message before it goes to Claw, and how it is taken off again: the request
 * for a change summary (the phone has no diff view), then the reply-style rule a Claw rule tool holds.
 */

/** What the reply-style rule is introduced with. */
export const RULE_HEADING = "## Teams reply style (formatting only, facts unchanged)";
/** What the change-summary request is introduced with. */
export const CHANGE_HEADING = "## Teams change summary (only when files in a git repository changed)";
/** The change-summary request: about the answer's last lines, not a style, so it is kept apart from the rule. */
export const CHANGE_SUMMARY_RULE =
  "If during this task you changed files in a git working tree, end your answer with a short section titled " +
  "**Changes**: in one code block, the output of `git diff --stat HEAD` (and, for a new file git does not track yet, " +
  'its line from `git status --short`), at most 15 lines, then "+N more files" for the rest. Read-only commands ' +
  "only; do not stage, commit or push to produce it. If nothing in a git working tree changed, leave the section out.";
/** Exactly what the worker appends first, whether or not a rule follows. */
export const CHANGE_SECTION = `\n\n${CHANGE_HEADING}\n\n${CHANGE_SUMMARY_RULE}`;
/** A rule is edited in Claw; a changed rule reaches the chat within this. */
export const RULE_TTL_MS = 600_000;
/** A reply-style rule is about 1 KB; anything this large is not one. */
export const RULE_MAX_BYTES = 32_768;

/**
 * `text` as the person wrote it, with what the worker appended taken off again. The change summary is a fixed text and
 * always the first thing appended, so it marks where the person's own words end: it is looked for from the end, and
 * everything from it on goes. A message from before the request existed has only the rule: it is cut where the rule's
 * heading first starts.
 */
export function withoutRule(text: string): string {
  let at = text.lastIndexOf(CHANGE_SECTION);
  if (at === -1) at = text.indexOf("\n\n" + RULE_HEADING);
  return at === -1 ? text : text.slice(0, at);
}

/**
 * The content of a message to a plain session: the person's text, then the change-summary request (only where a rule
 * tool is configured), then the rule when there is one.
 */
export function messageContent(text: string, rule: string, withRuleTool: boolean): string {
  const sections = [
    ...(withRuleTool ? [CHANGE_SECTION.replace(/^\n+|\n+$/g, "")] : []),
    ...(rule === "" ? [] : [`${RULE_HEADING}\n\n${rule}`]),
  ];
  return [text, ...sections].join("\n\n");
}
