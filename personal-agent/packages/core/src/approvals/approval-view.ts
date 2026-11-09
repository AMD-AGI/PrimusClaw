// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What an approval card says, so a person can decide without reading a request body (teams_agent/approval_view.py): the model's
 * one-sentence summary (marked as the model's) or the agent's own words, the action, the key arguments, the reason, and the raw
 * call folded under Details in a 1:1 chat only. This is the semantic view; the Teams card is drawn from it by the teams package.
 *
 * Nothing here knows any tool or server. Credentials are never shown (`sensitive.ts`), and a group chat never gets the input.
 */

import { pickLang } from "../language/detect.js";
import type { Lang } from "../locales/lang.js";
import { redactText } from "../security/redact.js";
import { clip, cpHead, cpLen, cpTail, flat, pyJson } from "../text/plain.js";
import { credentialValues, maskValue, scrub } from "./sensitive.js";

export const TITLE_ID = "approval-title";
export const DETAILS_ID = "approval-details";
export const SUMMARY_MAX = 300;
export const DESCRIPTION_MAX = 200;
export const INTENT_MAX = 200;
export const VALUE_MAX = 120;
export const COMMAND_MAX = 300;
export const COMMAND_EDGE = 140;
export const NAME_MAX = 40;
export const MAX_OTHER_ARGS = 5;
export const RAW_MAX = 1500;

/** One `name: value` line of the card. */
export type ArgumentLine = readonly [name: string, value: string];

export interface ArgumentLines {
  /** The fields the call is about first (in the order the tool's name gives them), then up to MAX_OTHER_ARGS more. */
  readonly lines: readonly ArgumentLine[];
  /** The stated reason, shown apart. */
  readonly reason: ArgumentLine | undefined;
  /** How many other fields did not fit. */
  readonly more: number;
}

/** `mcp__<server>__<tool>` -> `tool words (server)`; any other name with its separators turned into spaces. */
export function humanizeTool(tool: string): string {
  let name = tool.trim();
  let server = "";
  const match = /^mcp__(.+?)__(.+)$/s.exec(name);
  if (match) {
    server = match[1] ?? "";
    name = match[2] ?? "";
  }
  const spaced =
    name
      .split(/[_\-\s]+/)
      .join(" ")
      .trim() || name;
  return server ? `${spaced} (${server})` : spaced;
}

function bareName(tool: string): string {
  const match = /^mcp__(.+?)__(.+)$/s.exec(tool);
  return match ? (match[2] ?? "") : tool;
}

function isEmptyInput(input: unknown): boolean {
  if (input === null || input === undefined) return true;
  if (Array.isArray(input)) return input.length === 0;
  return typeof input === "object" && Object.keys(input).length === 0;
}

/** A value as one line of text: strings flattened, everything else as compact JSON. */
function show(value: unknown): string {
  if (typeof value === "string") return flat(value);
  return pyJson(value, { compact: true });
}

/**
 * A shell command for the card: whole up to COMMAND_MAX, else its start and its end with the middle elided (a chained
 * `git push` sits at the end, so a plain cut at the front would hide the part that is being approved).
 */
export function clipCommand(text: string): string {
  const line = flat(text);
  if (cpLen(line) <= COMMAND_MAX) return line;
  return `${cpHead(line, COMMAND_EDGE).trimEnd()} … ${cpTail(line, COMMAND_EDGE).trimStart()}`;
}

/** The call's key arguments, its reason and how many fields did not fit. A credential-named field shows as [hidden]. */
export function argumentLines(tool: string, toolInput: unknown): ArgumentLines {
  if (isEmptyInput(toolInput)) return { lines: [], reason: undefined, more: 0 };
  const input = typeof toolInput === "object" && !Array.isArray(toolInput) ? toolInput : { input: toolInput };
  const masked = maskValue(input, credentialValues(input)) as Record<string, unknown>;
  const bare = `_${bareName(tool).toLowerCase()}_`;
  const about: ArgumentLine[] = [];
  const others: ArgumentLine[] = [];
  let reason: ArgumentLine | undefined;
  for (const [name, value] of Object.entries(masked)) {
    const lower = name.toLowerCase();
    const pair: ArgumentLine = [
      clip(name, NAME_MAX),
      lower === "command" ? clipCommand(show(value)) : clip(show(value), VALUE_MAX),
    ];
    if (lower === "reason") reason ??= pair;
    else if (bare.includes(`_${lower}_`)) about.push(pair);
    else others.push(pair);
  }
  about.sort((a, b) => bare.indexOf(`_${a[0].toLowerCase()}_`) - bare.indexOf(`_${b[0].toLowerCase()}_`));
  return {
    lines: [...about, ...others.slice(0, MAX_OTHER_ARGS)],
    reason,
    more: Math.max(0, others.length - MAX_OTHER_ARGS),
  };
}

/** The call as JSON for the collapsed section: credential-named fields and secret shapes already masked. */
export function rawDetails(tool: string, toolInput: unknown): string {
  const body = pyJson(maskValue(toolInput, credentialValues(toolInput)));
  return `${tool}\n${cpLen(body) <= RAW_MAX ? body : `${cpHead(body, RAW_MAX - 1)}…`}`;
}

/** The semantic content of an approval card; the buttons are the caller's. */
export interface ApprovalView {
  readonly lang: Lang;
  readonly group: boolean;
  /** The model's one-sentence summary ('' when none): shown bold, with a note that the model wrote it. */
  readonly summary: string;
  /** What the agent said it was about to do, shown when there is no summary (1:1 only; '' when none). */
  readonly intent: string;
  /** The action's readable name ('' when the call names no tool: the view says "an action" in its language). */
  readonly action: string;
  /** The tool's own description, in a 1:1 chat only ('' when none). */
  readonly description: string;
  readonly args: readonly ArgumentLine[];
  readonly reason: string | undefined;
  /** The deployment's wording of the rule that held the call ('' when none). */
  readonly ruleLabel: string;
  readonly moreFields: number;
  /** The raw call for the Details fold ('' when there is no input, and always in a group). */
  readonly details: string;
  /** Who alone can answer, in a group ('' for "the person who asked"). */
  readonly owner: string;
}

export interface ApprovalRequest {
  readonly tool: string;
  readonly toolInput: unknown;
  /** The permission event's optional fields: summary, tool_description, intent, approval_label. */
  readonly event?: Readonly<Record<string, unknown>> | null | undefined;
  readonly lang?: string | null | undefined;
  readonly group: boolean;
  readonly owner?: string | undefined;
}

/** One line from text Claw or the model wrote: scrubbed of typed credentials, masked by shape, then clipped (in that order). */
function eventField(
  event: Readonly<Record<string, unknown>>,
  name: string,
  limit: number,
  secrets: readonly string[],
): string {
  const value = event[name];
  if (typeof value !== "string") return "";
  return clip(redactText(flat(scrub(flat(value), secrets))).text, limit);
}

export function approvalView(request: ApprovalRequest): ApprovalView {
  const event = request.event ?? {};
  const secrets = credentialValues(request.toolInput);
  const summary = eventField(event, "summary", SUMMARY_MAX, secrets);
  const description = eventField(event, "tool_description", DESCRIPTION_MAX, secrets);
  const intent = eventField(event, "intent", INTENT_MAX, secrets);
  const lang: Lang = request.lang === "zh" || request.lang === "en" ? request.lang : pickLang(summary, intent);
  const name = request.tool.trim() ? humanizeTool(request.tool) : "";
  const base = {
    lang,
    group: request.group,
    summary,
    owner: request.owner ?? "",
    ruleLabel: eventField(event, "approval_label", INTENT_MAX, secrets),
  };
  if (request.group) {
    return {
      ...base,
      intent: "",
      action: name,
      description: "",
      args: [],
      reason: undefined,
      moreFields: 0,
      details: "",
      ruleLabel: "",
    };
  }
  const { lines, reason, more } = argumentLines(request.tool, request.toolInput);
  return {
    ...base,
    intent,
    action: name,
    description,
    args: lines,
    reason: reason?.[1],
    moreFields: more,
    details: isEmptyInput(request.toolInput) ? "" : rawDetails(request.tool, request.toolInput),
  };
}
