// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Who started the turn that just ended in a terminal: a person (typed at that terminal, a queued prompt, an accepted suggestion),
 * or something else (a message from another session, a scheduled prompt, a hook or a script). Claude Code writes where each
 * prompt came from into the conversation's transcript (`origin.kind`, `promptSource`, measured on 2.1.285-2.1.328), so the
 * connector reads that, rather than guessing from the words. The turn's own prompt is the newest prompt in the transcript;
 * Claude Code's notice that a background task finished (`origin.kind: "task-notification"`) is no new start: it continues the
 * turn that started the task, so the prompt before it decides.
 *
 * Read-only, from the tail of the transcript only; null whenever that does not say (no transcript, a Claude Code older than these
 * fields, a tail with no prompt in it), and the caller then does what it did before it knew (it tells the end as a person's).
 */
import fs from "node:fs";
import path from "node:path";
import { isPersonPrompt } from "./attach.js";
import { isObject } from "./util.js";

export type TurnOrigin = "person" | "automation";

/** How much of the end of a transcript is read to find the turn's prompt. */
export const TURN_ORIGIN_TAIL = 1024 * 1024;

/** Entries that only continue a turn that started earlier: a task's notification, the note of an interrupt, a compaction's summary. */
const CONTINUES = /^(?:<task-notification>|\[Request interrupted by user|This session is being continued from a previous conversation)/;
/** A slash command the person typed (Claude Code writes it without `origin` or `promptSource`, and not as meta). */
const COMMAND = /^<command-name>/;

function textOf(doc: Record<string, unknown>): string {
  const content = isObject(doc.message) ? doc.message.content : undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (isObject(b) && b.type === "text" && typeof b.text === "string" ? b.text : "")).join("\n");
}

function isToolResults(doc: Record<string, unknown>): boolean {
  const content = isObject(doc.message) ? doc.message.content : undefined;
  return Array.isArray(content) && content.length > 0 && content.every((b) => isObject(b) && b.type === "tool_result");
}

/**
 * What one transcript entry says about the start of a turn: `person` or `automation` when it is the turn's prompt, `skip` when it
 * is not (anything but a user entry, a tool's result, a sub-agent's line, a line Claude Code inserts into a turn, or one that
 * continues an earlier turn).
 */
export function entryOrigin(doc: Record<string, unknown>): TurnOrigin | "skip" {
  if (doc.type !== "user" || doc.isSidechain === true || "toolUseResult" in doc || isToolResults(doc)) return "skip";
  if (doc.isCompactSummary === true || doc.isVisibleInTranscriptOnly === true) return "skip";
  const text = textOf(doc).trimStart();
  const kind = isObject(doc.origin) && typeof doc.origin.kind === "string" ? doc.origin.kind : null;
  if (kind === "task-notification") return "skip";
  if (kind !== null || typeof doc.promptSource === "string") return isPersonPrompt(doc, text) ? "person" : "automation";
  // Says nothing of where it came from: a line Claude Code inserts (meta), a slash command and its output, or an older Claude Code.
  if (doc.isMeta === true) return "skip";
  if (COMMAND.test(text)) return "person";
  if (CONTINUES.test(text) || /^<(?:local-command-|command-(?:message|args)>|bash-(?:input|stdout|stderr)>)/.test(text)) return "skip";
  return isPersonPrompt(doc, text) ? "person" : "automation";
}

/** The origin of the newest turn in transcript text (whole lines; the first may be cut and is ignored when it does not parse). */
export function originOfTail(text: string): TurnOrigin | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let doc: unknown;
    try { doc = JSON.parse(line); } catch { continue; }
    if (!isObject(doc)) continue;
    const o = entryOrigin(doc);
    if (o !== "skip") return o;
  }
  return null;
}

/**
 * Who started the turn that ended in conversation `ref`, from its transcript at `transcriptPath`: only a transcript of that
 * conversation (`<ref>.jsonl`) under the agent's config folder (`<configDir>/projects/`) is read.
 */
export function turnOrigin(transcriptPath: unknown, configDir: string, ref: string, tail: number = TURN_ORIGIN_TAIL): TurnOrigin | null {
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath)) return null;
  const file = path.resolve(transcriptPath);
  const projects = path.resolve(configDir, "projects") + path.sep;
  if (!file.startsWith(projects) || path.basename(file) !== `${ref}.jsonl`) return null;
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, tail);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return originOfTail(buf.toString("utf8"));
  } catch {
    return null;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* closed */ }
  }
}
