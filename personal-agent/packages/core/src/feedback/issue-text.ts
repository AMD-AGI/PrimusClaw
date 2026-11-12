// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import {
  clipLine,
  cpHead,
  cpLength,
  cpSlice,
  isPyPrintable,
  isPySpace,
  pyRstrip,
  pyStrip,
  squashSpaces,
} from "../text/py-text.js";
import { EMAIL } from "./identifiers.js";
import { fence } from "./markdown.js";

/**
 * The words of an issue and its comments: the title, who reported it, the body, the comment of a second report in the
 * same session, and the comment with the conversation the reporter chose to add. Everything a person wrote is masked
 * (`Mask`), bounded, and kept from forming markdown that pings, links or forges the retry marker.
 */

/** Credential shapes in a text replaced by a placeholder (the runtime's redaction). */
export type Mask = (text: string) => string;

export const FEEDBACK_LABEL = "clawy-feedback";
export const LABEL_COLOR = "d93f0b";
/** The feedback label's description: who reports, from the chat app `channel` (`SurfaceCaps.shortName`, e.g. "Teams"). */
export function labelDescription(channel: string): string {
  return `Reported by a user from ${channel} through Clawy`;
}

const TITLE_TEXT_CHARS = 60;
const TITLE_MAX_CHARS = 120;
const TITLE_NAME_CHARS = 60;
const NAME_CHARS = 120;
const EMAIL_CHARS = 254;
export const MAX_TEXT_CHARS = 4000;
const QUESTION_CHARS = 3000;
const ANSWER_CHARS = 6000;
const CUT = "\n... (cut)";
const MARKDOWN = /([\\`*_[\]~])/g;

/** How the deployment names itself and where its users talk to it. */
export interface IssueWording {
  /** The bot's display name ("Clawy"). */
  readonly botName: string;
  /** The chat channel ("Teams"). */
  readonly channelName: string;
}

/** A stored report, as far as its issue text needs it. */
export interface ReportText {
  readonly id: number;
  /** Seconds since the epoch. */
  readonly createdAt: number;
  readonly text: string;
  /** The scene, as markdown (`sceneMarkdown`). */
  readonly scene: string;
  readonly reporterName: string;
  readonly reporterEmail: string;
  readonly sessionId: string;
}

/** One line of printable text, at most `limit` characters (an ellipsis marks a cut). */
export function plainLine(value: string, limit: number): string {
  const kept = Array.from(value)
    .filter((c) => isPyPrintable(c) || isPySpace(c))
    .join("");
  return clipLine(squashSpaces(kept), limit);
}

export function reporterName(value: string): string {
  return plainLine(value, NAME_CHARS);
}

/** The email when it is a plain address, else "": it is written into markdown, so nothing else may pass. */
export function reporterEmail(value: string): string {
  const text = pyStrip(value);
  return cpLength(text) <= EMAIL_CHARS && EMAIL.test(text) ? text : "";
}

/** The first line of every issue and comment: who reported it, escaped so it cannot format, link, ping or forge. */
export function reporterLine(name: string, email: string): string {
  const escaped = reporterName(name)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(MARKDOWN, "\\$1");
  const shown = escaped.replaceAll("@", "@​") || "unknown";
  return `Reported by **${shown}**${email ? ` (${email})` : ""}`;
}

/** `[<bot> feedback] <what went wrong> — <reporter>`, one line, at most 120 characters; the text gives way first. */
export function issueTitle(wording: IssueWording, text: string, name: string): string {
  const prefix = `[${wording.botName} feedback] `;
  const suffix = ` — ${plainLine(name, TITLE_NAME_CHARS) || "unknown"}`;
  const room = Math.max(0, Math.min(TITLE_TEXT_CHARS, TITLE_MAX_CHARS - cpLength(prefix) - cpLength(suffix)));
  return prefix + pyRstrip(cpHead(squashSpaces(text), room)) + suffix;
}

/** The reporter's own words with credential shapes masked, bounded. */
export function cleanText(mask: Mask, text: string): string {
  const masked = mask(pyStrip(text)).replaceAll("<!--", "<! --");
  return cpLength(masked) <= MAX_TEXT_CHARS ? masked : cpSlice(masked, 0, MAX_TEXT_CHARS) + CUT;
}

/** Hidden in the issue or comment, so a retry can tell that an earlier attempt got through. */
export function retryMarker(report: Pick<ReportText, "id" | "createdAt">): string {
  return `<!-- clawy-feedback-id: ${String(report.id)}-${String(Math.trunc(report.createdAt))} -->`;
}

/** The web console's page of a session. */
export function sessionLink(publicBaseUrl: string, sessionId: string): string {
  return `${publicBaseUrl}/primus-claw/${sessionId}`;
}

export function issueBody(wording: IssueWording, publicBaseUrl: string, report: ReportText): string {
  const link = report.sessionId
    ? `[${report.sessionId}](${sessionLink(publicBaseUrl, report.sessionId)})`
    : "none (the chat had no PrimusClaw session)";
  return (
    `${reporterLine(report.reporterName, report.reporterEmail)}\n\n` +
    `Reported from ${wording.channelName} through ${wording.botName}.\n\n` +
    `### What went wrong\n\n${fence(report.text)}\n\n${report.scene}\n\n### Claw session\n\n${link}\n\n` +
    `${retryMarker(report)}\n`
  );
}

/** The comment a second report in the same session within the dedupe window becomes. */
export function commentBody(report: ReportText): string {
  const stamp = new Date(Math.trunc(report.createdAt) * 1000).toISOString().slice(0, 19).replace("T", " ");
  return (
    `${reporterLine(report.reporterName, report.reporterEmail)}\n\n` +
    `### Another report from the same user in the same session (${stamp} UTC)\n\n${fence(report.text)}\n\n` +
    `${report.scene}\n\n${retryMarker(report)}\n`
  );
}

/** The reporter's last question and answer, added at their request: masked, bounded, fenced. */
export function conversationComment(mask: Mask, question: string, answer: string): string {
  const part = (title: string, text: string, limit: number): string => {
    const masked = mask(text) || "(empty)";
    const bounded = cpLength(masked) <= limit ? masked : cpSlice(masked, 0, limit) + CUT;
    return `**${title}**\n\n${fence(bounded)}`;
  };
  return (
    "### Conversation included by the user\n\nThe user chose to include their last question and the answer. " +
    "Credential-shaped values were hidden.\n\n" +
    part("Question", question, QUESTION_CHARS) +
    "\n\n" +
    part("Answer", answer, ANSWER_CHARS) +
    "\n"
  );
}
