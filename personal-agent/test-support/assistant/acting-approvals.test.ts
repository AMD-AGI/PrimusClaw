// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Approvals in a session that acts as a user (test_github_review.py): a review's own session is noted as acting the moment the
 * router's turn makes it; an approval in it is answered with the asker's exchanged token, never a linked key, in the group or in
 * their own chat; when no token can be had the card is put back as it was, and only the asker can answer. The presses are
 * Teams' own (an Action.Execute of the card) routed by the router to this line's ApprovalClicks over one store and one channel.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { ClawError, type OutMessage } from "@primusclaw/personal-agent";

import { RENDERERS, renderView } from "../../packages/teams/src/views/index.js";
import { ALICE, BOB, CONV, PR, groupMessage } from "../review-world.js";
import {
  ALICE_KEY,
  OPEN_APPROVAL,
  ORDINARY_SESSION,
  REVIEW_SESSION,
  approvalClick,
  pressesWorld,
  waiting,
  type PressesWorld,
} from "./review-presses.js";

/** Alice asks Bob in the group for a review (Python `ask`): the service starts its turn on the router. */
async function ask(w: PressesWorld): Promise<void> {
  const message = groupMessage(`请 {Bob} 帮我 review 合入 ${PR}`, ALICE, [BOB]);
  await w.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: w.surface.conversation(message.conversation),
    scope: CONV,
    lang: () => "zh",
  });
  await w.router.router.settled();
}

async function press(w: PressesWorld, ...presses: Parameters<typeof approvalClick>[0][]): Promise<void> {
  for (const options of presses) {
    await w.router.router.handle(approvalClick(options));
    await w.router.router.settled();
  }
}

/** The edits of the card the press was on ("card-9"), rendered as Teams gets them. */
function cardEdits(w: PressesWorld): Record<string, unknown>[] {
  return w.surface.outbox.flatMap((r) => (r.op === "update" && r.id === "card-9" ? [rendered(r.message)] : []));
}

function rendered(message: OutMessage): Record<string, unknown> {
  const body = message.body;
  if (body.type !== "view") return { text: body.type === "text" ? body.text : body.markdown };
  const attachments = (renderView(RENDERERS, body.view) as { attachments?: { content: Record<string, unknown> }[] })
    .attachments;
  return attachments?.[0]?.content ?? {};
}

function titles(card: Record<string, unknown>): string[] {
  return ((card["actions"] ?? []) as { title: string }[]).map((a) => a.title);
}

function said(w: PressesWorld): string {
  return JSON.stringify(w.surface.outbox);
}

function unlinkAlice(w: PressesWorld): void {
  w.store.links.unlink("aad-a");
}

it("a review session is remembered as one that acts as a user and an ordinary one is not", async () => {
  const w = pressesWorld();
  await ask(w);
  assert.equal(w.store.reviewDelegation.isActingSession(REVIEW_SESSION), true);
  assert.equal(w.store.reviewDelegation.isActingSession(ORDINARY_SESSION), false);
  assert.equal(w.store.reviewDelegation.isActingSession(""), false);
});

for (const chat of ["group", "1:1"] as const) {
  for (const linked of [false, true]) {
    for (const action of ["allow", "deny"]) {
      it(`an approval of a review session is answered with the exchanged token (${chat}, ${linked ? "linked-key" : "no-key"}, ${action})`, async () => {
        const w = pressesWorld();
        await ask(w);
        if (!linked) unlinkAlice(w); // (after her review started: unlinking forgets the approvals she had then)
        // (recorded by the turn, with the asker as its owner: what the engine's onApproval writes through TurnApprovals)
        w.store.approvals.saveApproval({
          userId: "aad-a",
          sessionId: REVIEW_SESSION,
          toolUseId: OPEN_APPROVAL.toolUseId,
          tool: OPEN_APPROVAL.tool,
          expiresAt: w.store.now() + 600,
        });
        assert.equal(w.store.approvals.getApproval(REVIEW_SESSION, "tu9")?.userId, "aad-a");
        await press(w, { action, chat });
        assert.deepEqual(w.decider.decides, [["decide", "tok-aad-a", REVIEW_SESSION, "tu9", action]]);
        assert.deepEqual(w.decider.acting, [["tok-aad-a", REVIEW_SESSION, "tu9"]]);
        assert.equal(w.store.approvals.getApproval(REVIEW_SESSION, "tu9")?.state, "decided");
        assert.ok(!said(w).includes(ALICE_KEY));
      });
    }
  }
}

for (const chat of ["group", "1:1"] as const) {
  for (const linked of [false, true]) {
    for (const [failure, text] of [
      ["not-bound", "not connected to your Primus account through the identity service"],
      ["exchange-down", "could not reach the Primus platform"],
    ] as const) {
      it(`when the token cannot be had the approval card stays as it was and no key is sent (${chat}, ${linked ? "linked-key" : "no-key"}, ${failure})`, async () => {
        const w = pressesWorld();
        if (!linked) unlinkAlice(w); // (before the approval is written: unlinking forgets the approvals she had then)
        waiting(w);
        if (failure === "not-bound") w.exchange.bound.delete("aad-a");
        else w.exchange.down = true;
        await press(w, { chat });
        assert.deepEqual(w.decider.decides, []); // (nothing was sent: not with a key, not with anything)
        assert.equal(w.store.approvals.getApproval(REVIEW_SESSION, "tu9")?.state, "pending"); // (nothing was claimed)
        const edits = cardEdits(w);
        assert.equal(edits.length, 1, JSON.stringify(edits));
        const [edit] = edits as [Record<string, unknown>];
        assert.ok(JSON.stringify(edit).includes(text), JSON.stringify(edit));
        assert.deepEqual(titles(edit), ["Approve", "Deny"]);
        assert.ok(!said(w).includes(ALICE_KEY));
        // connected again: the same card is answered, as a token
        w.exchange.down = false;
        w.exchange.bound.add("aad-a");
        await press(w, { chat, id: "a2" });
        assert.deepEqual(w.decider.decides, [["decide", "tok-aad-a", REVIEW_SESSION, "tu9", "allow"]]);
        assert.equal(w.store.approvals.getApproval(REVIEW_SESSION, "tu9")?.state, "decided");
      });
    }
  }
}

it("a person who is not connected is shown the way to connect in their own chat and never in the group", async () => {
  const w = pressesWorld();
  waiting(w);
  w.exchange.bound.delete("aad-a");
  await press(w, { chat: "group" });
  const connectCards = () =>
    w.surface.outbox.filter(
      (r) => "message" in r && JSON.stringify(rendered(r.message)).includes('"primusclaw":"bind"'),
    );
  assert.deepEqual(connectCards(), []);
  await press(w, { chat: "1:1", id: "a2" });
  const cards = connectCards();
  assert.equal(cards.length, 1); // (the card that connects: in their own chat)
  assert.equal(cards[0]?.conversation, "conv-aad-a");
});

for (const [body, text] of [
  ['{"ok":false,"error":"interactive_sign_in_required"}', "did not take my credential"],
  ['{"ok":false,"error":"service_client_not_allowed"}', "does not take answers from me yet"],
  ['{"ok":false,"error":"only_the_acting_user_can_decide"}', "not yours to give"],
  ["not json", "not yours to give"],
] as const) {
  it(`what claw says when it refuses an answer in a session that acts as a user is told and the card stays usable (${text})`, async () => {
    const w = pressesWorld();
    waiting(w);
    w.decider.failWith = new ClawError(403, body);
    await press(w, {});
    const edits = cardEdits(w);
    assert.equal(edits.length, 1, JSON.stringify(edits));
    const [edit] = edits as [Record<string, unknown>];
    assert.ok(JSON.stringify(edit).includes(text), JSON.stringify(edit));
    assert.ok(JSON.stringify(edit).includes("Your answer was not sent"));
    assert.deepEqual(titles(edit), ["Approve", "Deny"]);
    assert.equal(w.store.approvals.getApproval(REVIEW_SESSION, "tu9")?.state, "pending");
  });
}

for (const [acting, credential] of [
  [false, ALICE_KEY],
  [true, "tok-aad-a"],
] as const) {
  it(`a person with a binding answers an acting session with the token and an ordinary one with the key (${acting ? "acting" : "ordinary"}-session)`, async () => {
    const w = pressesWorld(); // (the exchange is on for the identity-only paths and off for chats)
    const session = waiting(w, acting);
    await press(w, { session, chat: "1:1" });
    assert.deepEqual(w.decider.decides, [["decide", credential, session, "tu9", "allow"]]);
    assert.equal(w.decider.acting.length, acting ? 1 : 0); // (only a session that acts as a user is answered as one)
  });
}

it("an ordinary session of a person with only a linked key is still answered with that key", async () => {
  const w = pressesWorld();
  w.exchange.bound.delete("aad-a");
  const session = waiting(w, false);
  await press(w, { session, chat: "1:1" });
  assert.deepEqual(w.decider.decides, [["decide", ALICE_KEY, session, "tu9", "allow"]]);
  assert.deepEqual(w.decider.acting, []);
});

it("a click by someone else or on a forged card is refused before any token is asked for", async () => {
  const w = pressesWorld();
  waiting(w);
  await press(w, { user: BOB, chat: "1:1" }, { user: BOB, id: "a2" }); // (not the owner: a 1:1 click of Bob's, nor in the group)
  assert.deepEqual(w.decider.decides, []);
  assert.deepEqual(w.exchange.asked, []);
  assert.equal(w.store.approvals.getApproval(REVIEW_SESSION, "tu9")?.state, "pending");
  await press(w, { id: "a3", toolUseId: "forged" });
  assert.deepEqual(w.decider.decides, []);
  assert.deepEqual(w.exchange.asked, []);
});
