// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A review the person's assistant handed back to this chat (`assistant.action` with `review`: Claw's `review_start` naming
 * someone else). It runs on the reviewer's own credentials, which only this worker brings. Typed data Claw checked against
 * the person's message; nothing here is read from words, and nothing of a malformed one is used.
 */

import { z } from "zod";

import { cpHead, pyStrip, squashSpaces } from "../text/py-text.js";
import { pullRef } from "../review-text/pull-ref.js";
import type { PullRef } from "../claw/model.js";

export const MAX_PULLS_PER_REQUEST = 30;
export const HELD_SAYS_MAX = 5;
export const HELD_SAY_MAX_CHARS = 4000;
/** What Claw takes of the asker's own words (`requester_note`), which it quotes to the reviewer as untrusted. */
export const REQUESTER_NOTE_MAX = 2000;
/** The handoff a 1:1 message declares (`channel_context.handoffs`) and Claw names its action with. */
export const REVIEW_HANDOFF = "review_for_other";

export interface ReviewHandoff {
  readonly reviewerUserId: string;
  readonly reviewerName: string;
  readonly pulls: readonly PullRef[];
  readonly merge: boolean;
  /** The person's own message, quoted to the reviewer as untrusted. */
  readonly note: string;
  /** The record Claw kept of the handoff, echoed when the review is started ('' from a Claw that sends none). */
  readonly handoffId: string;
  /** What the assistant said in the same turn before handing this over: the answer to the handoff carries it. */
  readonly said: readonly string[];
}

const GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/u;

const pull = z.object({
  owner: z.string().regex(GITHUB_NAME),
  repo: z.string().regex(GITHUB_NAME),
  number: z.number().int().positive(),
});

const handoffSchema = z.object({
  reviewer: z.object({
    user_id: z.string().min(1).max(200),
    name: z.string().optional().default(""),
  }),
  prs: z.array(z.unknown()).min(1).max(MAX_PULLS_PER_REQUEST),
  merge: z.boolean(),
  requester_note: z.string().optional().default(""),
  handoff_id: z.string().max(128).optional().default(""),
  held_says: z.array(z.string()).optional().default([]),
});

/** The `review` of an `assistant.action`, or undefined when it is not one in every field. */
export function parseReviewHandoff(raw: unknown): ReviewHandoff | undefined {
  const parsed = handoffSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const data = parsed.data;
  const pulls: PullRef[] = [];
  for (const item of data.prs) {
    const one = pull.safeParse(item);
    if (!one.success) return undefined;
    const ref = pullRef(one.data.owner, one.data.repo, one.data.number);
    if (!pulls.some((p) => p.owner === ref.owner && p.repo === ref.repo && p.number === ref.number)) pulls.push(ref);
  }
  const said = data.held_says
    .filter((t) => pyStrip(t))
    .map((t) => cpHead(pyStrip(t), HELD_SAY_MAX_CHARS))
    .slice(0, HELD_SAYS_MAX);
  return {
    reviewerUserId: data.reviewer.user_id,
    reviewerName: cpHead(squashSpaces(data.reviewer.name), 100),
    pulls,
    merge: data.merge,
    note: cpHead(pyStrip(data.requester_note), REQUESTER_NOTE_MAX),
    handoffId: pyStrip(data.handoff_id),
    said,
  };
}
