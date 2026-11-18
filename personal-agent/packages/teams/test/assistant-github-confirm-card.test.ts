// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The card for a merge (or an approval) a review the assistant started holds for the person (N54, 2026-11-18): the body Claw signs and
 * posts for it, read from the fixture Claw's own test checks its outbox against
 * (`claw/packages/api/test/fixtures/github-merge-card.outbox.json`, `assistant-review-confirm-card.test.ts` C1), goes through the
 * `/claw-events` route as Claw posts it, the proactive delivery and the say planner draw it as Teams shows it, and its buttons answer
 * the held write over Claw's HTTP client, as the person, with their exchanged token.
 *
 *   K1  the card: the words in it, "合入" and "不要" buttons that name the recorded card; nothing else is sent for it, once only
 *   K2  "合入": `POST /v1/assistant/confirmations/<id>/decision {decision: allow}` with the person's token, and the card says it merged
 *   K3  deny, an approval's card, every way the answer can end, and Claw's "retry" giving the card back to press again
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  AssistantActions,
  ok,
  silentLogger,
  type CardClick,
  type JsonObject,
  type OutMessage,
} from "@primusclaw/personal-agent";
import { clawEventsRoute, createClawClient, sign, type Fetch } from "@primusclaw/personal-agent-runtime";

import { ALICE, CardsWorld } from "../../../test-support/assistant/cards-world.js";
import { bodyText, render, str, titles } from "../../../test-support/assistant/teams-cards.js";

const FIXTURE = join(import.meta.dirname, "../../../../claw/packages/api/test/fixtures/github-merge-card.outbox.json");
const SECRET = "s3cret-alice";
const ROUTE = "route-alice";
const CONFIRMATION = "a3f9c2d1-0b7e-4c55-9e21-6d0f5b8c7a10";
const REF = "a3f9c2";

/** Claw's body for the card, as the fixture holds it, with this run's ids and times filled in. */
function body(o: { id?: string; kind?: string; label?: string } = {}): JsonObject {
  const id = o.id ?? CONFIRMATION;
  const ref = id.replace(/-/g, "").slice(0, 6);
  const raw = readFileSync(FIXTURE, "utf8")
    .replaceAll("<confirmation_id>", id)
    .replaceAll("<ref>", ref)
    .replaceAll("<event_id>", `say-${ref}`)
    .replaceAll("<occurred_at>", "2026-10-30T04:53:20.000Z")
    .replaceAll("<expires_at>", "2026-10-31T04:53:20.000Z");
  const event = JSON.parse(raw) as JsonObject;
  if (o.kind === undefined) return event;
  const confirm = event["confirm_write"] as JsonObject;
  return { ...event, confirm_write: { ...confirm, kind: o.kind, allow_label: o.label ?? str(confirm["allow_label"]) } };
}

/** The recorded card the first button of the last card names. */
function cardId(w: World): string {
  const [first] = w.cards.buttons();
  assert.ok(first !== undefined, "no button");
  return str((first["data"] as JsonObject)["card"]);
}

class World {
  readonly cards = CardsWorld.start({ render });
  /** What reached Claw's HTTP API: method, path, the bearer, the body. */
  readonly calls: Array<{ method: string; path: string; bearer: string; body: unknown }> = [];
  /** What Claw's decision route answers (`assistant-proactive.ts`: `{ok, data}` with the review's own answer in `data`). */
  answer: { status: number; json: unknown } = {
    status: 200,
    json: { ok: true, data: { ok: true, status: "merged", merge_sha: "f".repeat(40) } },
  };
  readonly settled: Array<{ card: OutMessage | string; fallback: string | undefined }> = [];
  readonly actions: AssistantActions;
  readonly route;

  constructor() {
    const { store, clock } = this.cards;
    store.notifySubs.saveNotifySub(ALICE, { route: ROUTE, subscriptionId: "sub-a", secret: SECRET });
    this.route = clawEventsRoute({
      notifySubs: store.notifySubs,
      links: store.links,
      references: store.references,
      claims: store.idempotency,
      deliver: (userId, reference, event) => this.cards.proactive.handle(userId, reference, event),
      clock,
      gone: false,
    });
    const fetch: Fetch = (url, init) => {
      const headers = init.headers as Record<string, string>;
      this.calls.push({
        method: String(init.method),
        path: url.slice("https://claw.test".length),
        bearer: headers["Authorization"] ?? "",
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return Promise.resolve(new Response(JSON.stringify(this.answer.json), { status: this.answer.status }));
    };
    const claw = createClawClient({ baseUrl: "https://claw.test", clock, fetch });
    this.actions = new AssistantActions({
      store,
      claw: claw.assistant,
      exchange: {
        enabled: true,
        tokenFor: (user: string) => Promise.resolve(ok(`tok-${user}`)),
        bindingRequest: () => Promise.reject(new Error("not used")),
        invalidate: () => undefined,
      },
      runCommand: () => Promise.resolve(false),
      exactCommand: () => false,
      agentActionAllowed: () => false,
      understands: () => true,
      reachable: () => true,
      logger: silentLogger,
    });
  }

  /** Claw's signed post of `event` to the person's route, as its outbox sends it. */
  async post(event: JsonObject): Promise<{ status: number; json: unknown }> {
    const bytes = new TextEncoder().encode(JSON.stringify(event));
    const stamp = String(Math.trunc(this.cards.clock.epochMs() / 1000));
    const response = await this.route.handle({
      headers: {
        "x-claw-timestamp": stamp,
        "x-claw-event-id": str(event["event_id"]),
        "x-claw-signature": sign(SECRET, stamp, bytes),
      },
      params: { route: ROUTE },
      query: new URLSearchParams(),
      body: bytes,
    });
    return { status: response.status, json: "json" in response ? response.json : undefined };
  }

  /** A press on the last card's button `op`, by `user`, as the router hands it over. */
  press(op: string, user = ALICE): Promise<void> {
    const button = this.cards.buttons().find((b) => (b["data"] as JsonObject)["op"] === op);
    assert.ok(button, `no ${op} button`);
    const data = button["data"] as JsonObject;
    const click: CardClick = {
      sender: { id: user, name: "", email: "", channelUserId: "" },
      conversation: {} as CardClick["conversation"],
      scope: "",
      action: { data },
      lang: () => "zh",
      settle: (card, options) => {
        this.settled.push({ card, fallback: options?.fallback });
        return Promise.resolve(true);
      },
    };
    return this.actions.confirmClick(click);
  }

  /** What the person was told by the last press: a note, or the words beside the card it gave back. */
  told(): string {
    const last = this.settled.at(-1);
    if (last === undefined) return "";
    return typeof last.card === "string" ? last.card : (last.fallback ?? "");
  }
}

test("K1 Claw's card for a held merge is drawn as a card with its buttons, from the body as Claw posts it, once", async () => {
  const w = new World();
  const event = body();
  const posted = await w.post(event);
  assert.deepEqual(posted, { status: 200, json: { status: "delivered" } });
  const sent = w.cards.sent();
  assert.equal(sent.length, 1, "one message: the card, holding the words");
  const card = w.cards.lastCard();
  assert.equal(
    bodyText(card).includes(
      `#1 Primus-SaFE#892 的合入在等你确认：点「合入」，或回复 批准 #${REF}；不想合就回复 拒绝 #${REF}。`,
    ),
    true,
    bodyText(card),
  );
  const buttons = w.cards.buttons();
  assert.deepEqual(titles(buttons), ["合入", "不要"]);
  const recorded = w.cards.store.assistantButtons.getConfirmCard(cardId(w));
  assert.deepEqual(
    [recorded?.confirmationId, recorded?.kind, recorded?.state, recorded?.userId],
    [CONFIRMATION, "github_merge", "open", ALICE],
  );
  // Claw's copy of the same post (a retry, another replica) is not a second card.
  assert.deepEqual(await w.post(event), { status: 200, json: { status: "duplicate" } });
  assert.equal(w.cards.sent().length, 1);
});

test("K2 合入 answers the held merge as the person, with their token, and says it merged", async () => {
  const w = new World();
  await w.post(body());
  await w.press("allow");
  assert.deepEqual(w.calls, [
    {
      method: "POST",
      path: `/v1/assistant/confirmations/${CONFIRMATION}/decision`,
      bearer: `Bearer tok-${ALICE}`,
      body: { decision: "allow" },
    },
  ]);
  assert.equal(w.told(), "已合入。");
  const card = w.cards.store.assistantButtons.getConfirmCard(cardId(w));
  assert.equal(card?.state, "done");
  // Pressed again: nothing more reaches Claw.
  await w.press("allow");
  assert.equal(w.calls.length, 1);
});

test("K3 every way the answer ends is said, an approval's card is its own, and Claw's retry gives the card back", async () => {
  const cases: Array<[string, string, string, string]> = [
    ["github_merge", "deny", "denied", "好的，没有合入。"],
    ["github_merge", "allow", "queued", "已放进合并队列，检查通过后合入。"],
    ["github_merge", "allow", "stale", "这个 PR 之后有了新提交，所以什么都没做。需要的话让我再审一次。"],
    ["github_merge", "allow", "expired", "这张卡已过期，什么都没做。需要的话请再跟我说一次。"],
    ["github_review", "allow", "submitted", "批准已发出。"],
    ["github_review", "deny", "denied", "好的，没有发出批准。"],
  ];
  for (const [kind, op, status, said] of cases) {
    const w = new World();
    w.answer = { status: 200, json: { ok: true, data: { ok: true, status } } };
    await w.post(body({ kind, label: kind === "github_review" ? "发出批准" : "合入" }));
    assert.equal(titles(w.cards.buttons())[0], kind === "github_review" ? "发出批准" : "合入");
    await w.press(op);
    assert.deepEqual(
      w.calls.map((c) => c.body),
      [{ decision: op }],
      `${kind} ${status}`,
    );
    assert.equal(w.told(), said, `${kind} ${status}`);
  }
  // A gate refused it: the reason is said.
  const refused = new World();
  refused.answer = { status: 200, json: { ok: true, data: { ok: true, status: "refused", reason: "ci_not_green" } } };
  await refused.post(body());
  await refused.press("allow");
  assert.equal(refused.told(), "没能完成（ci_not_green）。");

  // Claw could not try it just now: the card comes back open, and a second press goes through.
  const w = new World();
  w.answer = { status: 200, json: { ok: true, data: { ok: true, status: "retry", reason: "identity_unavailable" } } };
  await w.post(body());
  await w.press("allow");
  const back = w.settled.at(-1);
  assert.ok(back !== undefined && typeof back.card !== "string", "the card is given back");
  assert.equal(back.card.body.type, "view");
  assert.equal(w.told(), "PrimusClaw 暂时没能执行，它还在等你确认，请过一会儿再按一次。");
  assert.equal(w.cards.store.assistantButtons.getConfirmCard(cardId(w))?.state, "open");
  w.answer = { status: 200, json: { ok: true, data: { ok: true, status: "merged" } } };
  await w.press("allow");
  assert.equal(w.told(), "已合入。");
  assert.equal(w.calls.length, 2);
});
