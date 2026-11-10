// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A review whose turn ends with Claw holding a write for Bob (`test_github_review.held`): a high-risk merge, or a review posted
 * with his account; and the presses on the card that answers it.
 */
import assert from "node:assert/strict";

import { ClawError, err } from "../../src/index.js";
import type { GithubConfirmView } from "../../src/review/views.js";
import type { UserRef, ClickRoute, InboundAction, JsonObject } from "../../src/index.js";
import {
  ALICE,
  BOB,
  CONV,
  PR,
  groupMessage,
  reviewWorld,
  saidIn,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";

export { ClawError };

/** What Claw holds for Bob, as it lists it (`confirmation`). */
export function confirmation(changes: Record<string, unknown> = {}): JsonObject {
  return {
    id: "cf-1",
    repo: "AMD-AGI/Hyperloom",
    pr: 12,
    title: "Change the release workflow",
    author: "carol-gh",
    head_sha: "a".repeat(40),
    reasons: ["touches .github/workflows"],
    checks: { passed: 5, failed: 0, pending: 0 },
    actor_user_id: "u-bob",
    requester_user_id: "u-alice",
    session_id: "sess-1",
    expires_at: "2026-11-12T00:00:00Z",
    ...changes,
  };
}

/** What Claw holds as a review: what will be posted with the reviewer's account. */
export const REVIEW = {
  event: "REQUEST_CHANGES",
  body: "The retry loop never stops. Please bound it.",
  comments: [
    { path: "a.py", line: 3, side: "RIGHT", body: "bound this" },
    { path: "b.py", line: 9, side: "RIGHT", body: "and this" },
  ],
};
export const REVIEW_ITEM = { kind: "review", review: REVIEW, checks: {} };

/** Alice asks Bob in the group; his turn ends (`VERDICT: CLEAN`) with what Claw lists for him (`held`). */
export async function ask(world: ReviewWorld, id = "g1"): Promise<void> {
  const message = groupMessage(`请 {Bob} 帮我 review 合入 ${PR}`, ALICE, undefined, id);
  const conversation = world.surface.conversation(message.conversation);
  const before = world.started.length;
  await world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation,
    scope: CONV,
    lang: () => "zh",
  });
  const turn = world.started[before];
  assert.ok(turn !== undefined);
  turn.review.sessionId = "sess-1";
  await world.service.afterTurn(
    turn.review,
    "这是高风险变更，需要 Bob 确认。\nVERDICT: CLEAN",
    { moved: false, refusal: null, ranModel: "m", wrote: [], prSummary: "" },
    conversation,
  );
  turn.ended(); // (the turn is over: the next request of the same pull request may start)
  await Promise.resolve();
}

export async function held(changes: Record<string, unknown> = {}, world = reviewWorld()): Promise<ReviewWorld> {
  world.claw.confirmations = [confirmation(changes)];
  await ask(world);
  return world;
}

/** The confirmation cards sent into a conversation. */
export function cards(world: ReviewWorld, conversation: string): GithubConfirmView[] {
  return world.surface
    .of(conversation)
    .flatMap((r) =>
      r.op === "send" && r.message.body.type === "view" && r.message.body.view.name === "githubConfirm"
        ? [r.message.body.view.model]
        : [],
    );
}

export const groupText = (world: ReviewWorld) => saidIn(world.surface, CONV);
export const decisions = (world: ReviewWorld) =>
  world.claw.calls.filter((c) => c[0] === "decide").map((c) => c.slice(1));
export const row = (world: ReviewWorld, id = "cf-1") => world.store.githubConfirmations.getGithubConfirmation(id);

/** How a press was settled: the text, and whether its buttons stay. */
export interface Settled {
  readonly text: string;
  readonly buttons: boolean;
}

/** A press that was not settled at all. */
export const NOTHING: Settled = { text: "", buttons: false };

/** Bob (or `who`) presses Allow / Deny on the card of `confirmationId`. */
export async function press(
  world: ReviewWorld,
  decision: string,
  who: UserRef = BOB,
  confirmationId = "cf-1",
): Promise<Settled[]> {
  const settled: Settled[] = [];
  const conversation = world.surface.conversation({
    id: `personal:${who.id}`,
    kind: "personal",
    tenantId: "tenant-1",
    wire: { conversation: { id: `personal:${who.id}` } },
  });
  const action = {
    type: "action",
    verb: "github_confirm",
    data: { primusclaw: "github_confirm", confirmation: confirmationId, decision },
  } as unknown as InboundAction;
  const route = {
    action,
    sender: who,
    conversation,
    scope: "",
    lang: () => "en" as const,
    settle: (card: unknown) => {
      if (typeof card === "string") settled.push({ text: card, buttons: false });
      else {
        const json = JSON.stringify(card);
        settled.push({ text: json, buttons: json.includes('"buttons":[{') });
      }
      return Promise.resolve(true);
    },
  } as unknown as ClickRoute;
  const handler = world.service.routeHandlers().clicks.find((c) => c.verbs.includes("github_confirm"));
  await handler?.beforeCredential?.(route);
  return settled;
}

/** The identity service cannot exchange anyone's token just now. */
export function exchangeDown(world: ReviewWorld): () => void {
  const exchange = world.deps.exchange as { tokenFor: ReviewWorld["deps"]["exchange"]["tokenFor"] };
  const real = exchange.tokenFor;
  exchange.tokenFor = () => Promise.resolve(err({ kind: "exchange_failed" as const, reason: "identity service down" }));
  return () => {
    exchange.tokenFor = real;
  };
}

/** No chat with Bob, and no way to open one. */
export function bobUnreachable(world: ReviewWorld): void {
  (world.surface as unknown as { reachable: Set<string> }).reachable = new Set(["aad-a", "aad-c"]);
}
