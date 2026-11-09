// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { it } from "node:test";

import {
  ApprovalCards,
  TURN_DEADLINE_SECONDS,
  turnApprovalsFor,
  type ApprovalRecordStore,
} from "../../src/approvals/records.js";
import type { Conversation, Envelope, OutMessage } from "../../src/ports/surface.js";

function world(fail = false) {
  return build(fail);
}

function build(fail: boolean) {
  const saved = new Map<string, Envelope>();
  const log: string[] = [];
  const store: ApprovalRecordStore = {
    now: () => 1000,
    approvals: {
      saveApproval: (a) => {
        const key = `${a.sessionId}/${a.toolUseId}`;
        if (saved.has(key)) return false;
        saved.set(key, a.envelope ?? {});
        log.push(`save ${key} ${a.userId} ${a.tool} ${String(a.expiresAt)}`);
        return true;
      },
      approvalSent: (s, t) => void log.push(`sent ${s}/${t}`),
      forgetApproval: (s, t) => {
        saved.delete(`${s}/${t}`);
        log.push(`forget ${s}/${t}`);
      },
    },
  };
  const conversation = {
    outgoing: (m: OutMessage) => ({ operation: "send", activity: m.body.type }),
    deliver: (e: Envelope) => {
      log.push(`deliver ${JSON.stringify(e)}`);
      return fail ? Promise.reject(new Error("queue down")) : Promise.resolve();
    },
  } as unknown as Conversation;
  return { cards: new ApprovalCards(store), conversation, log, store };
}

const CARD: OutMessage = { body: { type: "text", text: "approve?" } };
const REQUEST = { userId: "aad-a", sessionId: "s1", toolUseId: "tu1", tool: "bash", expiresAt: 1600 };

it("a card is recorded with its envelope before it is sent and marked sent after", async () => {
  const { cards, conversation, log } = world();
  assert.equal(await cards.show(conversation, REQUEST, CARD), true);
  assert.deepEqual(log, [
    "save s1/tu1 aad-a bash 1600",
    'deliver {"operation":"send","activity":"text"}',
    "sent s1/tu1",
  ]);
});

it("one approval one card whichever way it arrives", async () => {
  const { cards, conversation, log } = world();
  await cards.show(conversation, REQUEST, CARD);
  assert.equal(await cards.show(conversation, REQUEST, CARD), false);
  assert.equal(log.filter((l) => l.startsWith("deliver")).length, 1);
});

it("a card that could not be sent leaves no record and the error goes on", async () => {
  const { cards, conversation, log } = world(true);
  await assert.rejects(cards.show(conversation, REQUEST, CARD), /queue down/);
  assert.equal(log.at(-1), "forget s1/tu1");
});

it("an approval a turn shows runs out when brain stops waiting or at the turn deadline", () => {
  const { cards } = world();
  assert.equal(cards.expiry(120, 1800), 1120);
  assert.equal(cards.expiry(undefined, 1800), 2800);
  assert.equal(cards.expiry(0, 1800), 2800);
});

it("a turns approvals are recorded for its person with brains wait or the turn deadline", () => {
  const { store, log } = world();
  const turn = turnApprovalsFor(store, "aad-b");
  assert.equal(turn.record("s2", "tu2", "bash", 90, { a: 1 }), true);
  assert.equal(turn.record("s2", "tu2", "bash", 90, { a: 1 }), false);
  assert.equal(turn.record("s3", "tu3", "ask_user_question", undefined, {}), true);
  turn.sent("s2", "tu2");
  turn.unsent("s3", "tu3");
  assert.deepEqual(log, [
    "save s2/tu2 aad-b bash 1090",
    `save s3/tu3 aad-b ask_user_question ${String(1000 + TURN_DEADLINE_SECONDS)}`,
    "sent s2/tu2",
    "forget s3/tu3",
  ]);
});
