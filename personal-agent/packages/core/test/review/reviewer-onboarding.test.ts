// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A review asked of someone who has steps left (their Primus account, `/github bind`, `/github auto-merge on`) is followed
 * until they are done: each step they finish is answered with the next one in their own chat, once; the asker hears which
 * step is missing, and once all are done hears it where they asked, with a button that starts the same request again,
 * through every check. Real service and store; fakes only at the identity service's and Claw's HTTP.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ClickRoute, CommandRoute, InboundMessage, OutMessage, UserRef } from "../../src/index.js";
import {
  ALICE,
  ALICE_DM,
  BOB,
  CAROL,
  CONV,
  PR,
  clawReviewsOverHttp,
  groupMessage,
  handBack,
  handoffEvent,
  handoffWorld,
  reviewWorld,
  saidIn,
  settleFollows,
  type ClawReviewsHttp,
  type HandoffWorld,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";

const PR2 = "AMD-AGI/Hyperloom#13";
const BOB_DM = "personal:aad-b";
const STEP1 = "还差第 1 步「连接 Primus 账号」";
const STEP3 = "还差第 3 步「发 `/github auto-merge on` 开启代审授权」";
const READY = "Bob 已完成授权，可以开始代审了。";

const dm = (id: string) => ({ id, kind: "personal" as const, tenantId: "tenant-1", wire: { conversation: { id } } });

/** How often `text` was said in `conversation`. */
function times(world: ReviewWorld, conversation: string, text: string): number {
  return saidIn(world.surface, conversation).split(text).length - 1;
}

/** The note cards sent in `conversation`: their text and the data of their buttons. */
function notes(world: ReviewWorld, conversation: string): { text: string; buttons: Record<string, unknown>[] }[] {
  return world.surface.of(conversation).flatMap((r) => {
    if (!("message" in r)) return [];
    const body = r.message.body;
    if (body.type !== "view" || body.view.name !== "note") return [];
    const model = body.view.model;
    return [{ text: model.text, buttons: (model.buttons ?? []).flatMap((b) => ("data" in b ? [{ ...b.data }] : [])) }];
  });
}

/** The latest button of `op` on a note card in `conversation`. */
function button(world: ReviewWorld, conversation: string, op: string): Record<string, unknown> {
  const found = notes(world, conversation)
    .flatMap((n) => n.buttons)
    .filter((b) => b.op === op)
    .at(-1);
  assert.ok(found, `no ${op} button in ${conversation}`);
  return found;
}

/** A press of a button, through the review service's own click route; what the card was settled with. */
async function press(
  world: ReviewWorld,
  who: UserRef,
  conversation: ReturnType<typeof dm> | typeof GROUP,
  data: Record<string, unknown>,
): Promise<(OutMessage | string)[]> {
  const settled: (OutMessage | string)[] = [];
  const route: ClickRoute = {
    sender: who,
    conversation: world.surface.conversation(conversation),
    scope: conversation.kind === "personal" ? "" : conversation.id,
    lang: () => "zh",
    action: {
      type: "action",
      id: `click-${String(world.surface.outbox.length)}`,
      sender: who,
      conversation,
      locale: "",
      clientPlatform: "",
      verb: String(data.primusclaw),
      invoke: true,
      clickVerb: "primusclaw.review_onboarding",
      data,
      cardMessageId: "",
    },
    settle: (card) => {
      settled.push(card);
      return Promise.resolve(true);
    },
  };
  const [clicks] = world.service.routeHandlers().clicks;
  assert.ok(clicks?.verbs.includes(String(data.primusclaw)));
  await clicks?.beforeCredential?.(route);
  await flush();
  return settled;
}

const GROUP = { id: CONV, kind: "group" as const, tenantId: "tenant-1", wire: { conversation: { id: CONV } } };

/** A message of `who` in their 1:1 chat, as the router sees it first (`remember`), and a `/github` command carried out. */
async function says(world: ReviewWorld, who: UserRef, text: string): Promise<void> {
  const message: InboundMessage = { ...groupMessage(text, who, [], `m-${who.id}-${text}`, "personal") };
  world.service.remember(message);
  if (text.startsWith("/github ")) {
    const [command] = world.service.routeHandlers().commands;
    const route: CommandRoute = {
      sender: who,
      conversation: world.surface.conversation(dm(`personal:${who.id}`)),
      scope: "",
      lang: () => "zh",
      credential: "",
      message,
    };
    await command?.run(route, text.slice("/github ".length));
  }
  await waitForBinding(world);
}

/** Lets a device flow's sleeps pass, as GitHub's interval asks, and what a message started in the background end. */
async function waitForBinding(world: ReviewWorld): Promise<void> {
  for (let i = 0; i < 20 && world.clock.pending > 0; i += 1) await world.clock.advance(10_000);
  await world.service.account.idle();
  await flush();
}

/** What runs in the background on answers that are already there (the fakes answer at once) runs to its end. */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** The identity service now knows Bob: he confirmed the card (nothing is sent to this worker when he does). */
function bobConfirms(world: ReviewWorld): void {
  world.identity.know("aad-b", "u-bob", null);
  world.bound.add("aad-b");
}

/** Bob as the identity service did not know him: no binding there, so no token either (his link is kept). */
function bobUnknown(world: ReviewWorld): void {
  world.identity.users.delete("aad-b");
  world.bound.delete("aad-b");
}

async function asked(world: ReviewWorld, text: string, sender: UserRef = ALICE, id = "g1"): Promise<void> {
  const message = groupMessage(text, sender, [BOB, CAROL], id);
  await world.service.request({
    message,
    text: message.text,
    sender,
    conversation: world.surface.conversation(message.conversation),
    scope: CONV,
    lang: () => "zh",
  });
}

const reviews = (http: ClawReviewsHttp) => http.requests.map((r) => r.body);

/** What a click was settled with, as text. */
const shown = (settled: OutMessage | string | undefined): string =>
  typeof settled === "string" ? settled : JSON.stringify(settled);

/** Steps 2 and 3 of Bob's, each answered once; the asker told once, with nothing started before she presses. */
async function bindAndAllow(world: HandoffWorld): Promise<void> {
  // Step 2 by the button under it: the device flow runs as his own /github bind does, and step 3 follows once
  const settled = await press(world, BOB, dm(BOB_DM), button(world, BOB_DM, "bind"));
  assert.equal(settled.length, 1);
  await waitForBinding(world);
  assert.deepEqual(
    world.identity.requests.filter((r) => r.action === "bind").map((r) => r.body.user),
    ["external:teams.microsoft.com|aad-b"],
  );
  assert.equal(times(world, BOB_DM, "Next is step 3 of 3"), 1);
  await world.service.sweepOnboarding();
  assert.equal(times(world, BOB_DM, "Next is step 3 of 3"), 1);
  assert.ok(notes(world, BOB_DM).some((n) => n.buttons.some((b) => b.op === "auto_merge_on")));
  assert.ok(!saidIn(world.surface, ALICE_DM).includes(READY));

  // Step 3: the asker is told where she asked, once, with the button that asks again
  await says(world, BOB, "/github auto-merge on");
  await world.service.sweepOnboarding();
  await says(world, BOB, "谢谢");
  const ready = notes(world, ALICE_DM).filter((n) => n.text.includes(READY));
  assert.equal(ready.length, 1);
  assert.ok(ready[0]?.text.includes(`（${PR}, ${PR2}，review 合入）`), ready[0]?.text ?? "");
  assert.equal(times(world, BOB_DM, "All steps are done. I told Alice"), 1);
}

test("a reviewer the identity service does not know is walked through every step, and the asker retries the same handoff", async () => {
  const world = handoffWorld();
  const http = clawReviewsOverHttp(world);
  http.recordHandoff("h-1");
  http.recordHandoff("h-2");
  world.store.members.rememberMember("29:a", "aad-a", "Alice");
  bobUnknown(world);
  await handBack(world, handoffEvent({ prs: [PR, PR2], handoffId: "h-1", note: `请 Bob review 合入 ${PR} ${PR2}` }));
  assert.deepEqual(reviews(http), []);
  // The asker: which step is missing, not just "not connected"
  assert.equal(times(world, ALICE_DM, `Bob 还不能被我代审：${STEP1}（共 3 步：`), 1, saidIn(world.surface, ALICE_DM));
  // The reviewer: every step, the current one marked, in both languages, and the identity card
  const bob = saidIn(world.surface, BOB_DM);
  assert.ok(bob.includes(`Alice asked me to review and merge ${PR}, ${PR2} as you`), bob);
  assert.ok(
    bob.includes(
      "1. Connect your Primus account: press Confirm on the identity service card I sent you <- this step now",
    ),
    bob,
  );
  assert.ok(bob.includes("2. Connect GitHub: send me `/github bind` here"), bob);
  assert.ok(bob.includes("3. Allow reviews as you: send me `/github auto-merge on` here"), bob);
  assert.ok(bob.includes("1. 连接你的 Primus 账号：点我发给你的身份服务卡片上的确认 ← 现在这一步"), bob);
  assert.ok(bob.includes("3. 开启代审授权：在这里发 `/github auto-merge on`"), bob);
  assert.deepEqual(world.said.connect, ["aad-b:"]);

  // Asked again (a new handoff): the reviewer is not sent it all again the same day
  await handBack(world, handoffEvent({ eventId: "ev-h2", prs: [PR, PR2], handoffId: "h-2" }));
  assert.equal(times(world, BOB_DM, "as you; I have done nothing yet"), 1);
  assert.equal(world.said.connect.length, 1);
  assert.equal(times(world, ALICE_DM, STEP1), 2);

  // Nothing changed: the sweep says nothing
  await world.service.sweepOnboarding();
  assert.equal(times(world, BOB_DM, "Next is step"), 0);

  // Step 1 done at the identity service: the next step, once, however often it is read
  bobConfirms(world);
  await says(world, BOB, "好的"); // (any message of his reads it again)
  assert.equal(times(world, BOB_DM, "Next is step 2 of 3, so that Alice can have me review as you"), 1);
  await world.service.sweepOnboarding();
  await world.service.sweepOnboarding();
  assert.equal(times(world, BOB_DM, "Next is step 2 of 3, so that Alice can have me review as you"), 1);
  assert.equal(times(world, BOB_DM, "下一步是第 2 步（共 3 步）"), 1);
  assert.ok(
    saidIn(world.surface, BOB_DM).includes("1. 连接你的 Primus 账号：点我发给你的身份服务卡片上的确认（已完成）"),
  );
  assert.ok(
    saidIn(world.surface, BOB_DM).includes(
      "2. 连接 GitHub：在这里发 `/github bind`，按提示在 GitHub 输入验证码并批准（令牌只存在 Primus 身份服务） ← 现在这一步",
    ),
  );

  await bindAndAllow(world);
  assert.deepEqual(reviews(http), []); // (nothing starts until she presses it)

  // Her press starts the same handoff (the latest one, its pull requests and merge flag) as Bob, once
  await press(world, ALICE, dm(ALICE_DM), button(world, ALICE_DM, "retry"));
  await settleFollows(world);
  const [only, ...more] = http.requests;
  assert.equal(more.length, 0);
  assert.ok(only);
  assert.equal(only.headers["x-acting-as-token"], "tok-aad-b");
  assert.equal(only.headers["x-acting-as-api-key"], "ak-bob-linked");
  assert.equal(only.body.handoff_id, "h-2");
  assert.equal(only.body.acting_as, "u-bob");
  assert.equal(only.body.review_only, false);
  assert.deepEqual(
    (only.body.prs as { owner: string; repo: string; number: number }[]).map(({ owner, repo, number }) => ({
      owner,
      repo,
      number,
    })),
    [
      { owner: "AMD-AGI", repo: "Hyperloom", number: 12 },
      { owner: "AMD-AGI", repo: "Hyperloom", number: 13 },
    ],
  );
  // Pressed again: gone
  const again = await press(world, ALICE, dm(ALICE_DM), button(world, ALICE_DM, "retry"));
  assert.ok(shown(again[0]).includes("已失效"), shown(again[0]));
  assert.equal(http.requests.length, 1);
});

test("steps done before anything read them are answered once, with no step skipped back", async () => {
  const world = reviewWorld();
  const http = clawReviewsOverHttp(world);
  bobUnknown(world);
  await asked(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  assert.ok(saidIn(world.surface, CONV).includes(`Bob 还不能被我代审：${STEP1}`), saidIn(world.surface, CONV));
  // Everything at once, before any read: the asker is told, the reviewer gets no "next step" for steps already done
  bobConfirms(world);
  world.identity.know("aad-b", "u-bob", "bob-gh", true);
  await world.service.sweepOnboarding();
  assert.equal(times(world, BOB_DM, "Next is step"), 0);
  assert.equal(notes(world, CONV).filter((n) => n.text.includes(READY)).length, 1);
  assert.equal(times(world, BOB_DM, "All steps are done"), 1);
  // Out of order the other way: auto-merge on typed while GitHub is still unbound is refused there, and nothing moves
  const other = reviewWorld();
  clawReviewsOverHttp(other);
  other.identity.know("aad-b", "u-bob", null);
  await asked(other, `请 {Bob} 帮我 review ${PR}`);
  assert.ok(saidIn(other.surface, CONV).includes("还差第 2 步「发 `/github bind` 连接 GitHub」"));
  await says(other, BOB, "/github auto-merge on");
  assert.equal(times(other, BOB_DM, "Next is step"), 0);
  // ...then bind, then on: one message per step, and the asker's button keeps "review only"
  await says(other, BOB, "/github bind");
  assert.equal(times(other, BOB_DM, "Next is step 3 of 3"), 1);
  await says(other, BOB, "/github auto-merge on");
  const ready = notes(other, CONV).filter((n) => n.text.includes(READY));
  assert.equal(ready.length, 1);
  assert.ok(ready[0]?.text.includes("只 review"), ready[0]?.text ?? "");
  assert.deepEqual(reviews(http), []);
});

test("several asks of the same reviewer send each step once, naming every asker, and each asker hears it once", async () => {
  const world = reviewWorld();
  clawReviewsOverHttp(world);
  world.bound.add("aad-c");
  world.identity.know("aad-c", "u-carol", "carol-gh");
  bobUnknown(world);
  await asked(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  await asked(world, `请 {Bob} 帮我 review 合入 ${PR}`, ALICE, "g2");
  await asked(world, `请 {Bob} 帮我 review 合入 ${PR2}`, CAROL, "g3");
  assert.equal(times(world, BOB_DM, "as you; I have done nothing yet"), 1);
  bobConfirms(world);
  await Promise.all([world.service.sweepOnboarding(), says(world, BOB, "hi"), world.service.sweepOnboarding()]);
  assert.equal(times(world, BOB_DM, "Next is step 2 of 3, so that Alice、Carol can have me review as you"), 1);
  world.identity.know("aad-b", "u-bob", "bob-gh", true);
  await Promise.all([world.service.sweepOnboarding(), says(world, BOB, "hi again")]);
  const ready = notes(world, CONV).filter((n) => n.text.includes(READY));
  assert.deepEqual(
    ready.map((n) => n.text.includes(PR2)),
    [false, true],
  );
  assert.equal(times(world, BOB_DM, "All steps are done. I told Alice、Carol"), 1);
  // Only the one who asked may press her button
  const settled = await press(world, CAROL, GROUP, ready[0]?.buttons[0] ?? {});
  assert.ok(JSON.stringify(settled).includes("只有发起这次代审的人可以重新发起"));
  // Not pressed; Bob turns it off and Alice asks the same again: she is told again once he is back on
  await says(world, BOB, "/github auto-merge off");
  await asked(world, `请 {Bob} 帮我 review 合入 ${PR}`, ALICE, "g4");
  assert.ok(saidIn(world.surface, CONV).includes(`Bob 还不能被我代审：${STEP3}`));
  await says(world, BOB, "/github auto-merge on");
  assert.equal(notes(world, CONV).filter((n) => n.text.includes(READY)).length, 3);
});

test("a reviewer who says no stays at no: the asker is told once and nothing starts, even from an old button", async () => {
  const world = reviewWorld();
  const http = clawReviewsOverHttp(world);
  world.identity.know("aad-b", "u-bob", "bob-gh", false);
  await asked(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  assert.ok(saidIn(world.surface, CONV).includes(`Bob 还不能被我代审：${STEP3}`), saidIn(world.surface, CONV));
  assert.ok(notes(world, BOB_DM).some((n) => n.buttons.some((b) => b.op === "auto_merge_on")));
  await press(world, BOB, dm(BOB_DM), button(world, BOB_DM, "decline"));
  assert.equal(times(world, CONV, `Bob 选择暂不开启代审授权，所以 ${PR} 的代审不会开始`), 1);
  await world.service.sweepOnboarding();
  await says(world, BOB, "/github auto-merge off");
  assert.equal(times(world, CONV, "选择暂不开启代审授权"), 1);
  assert.equal(world.identity.users.get("aad-b")?.delegation, false);
  assert.equal(notes(world, CONV).filter((n) => n.text.includes(READY)).length, 0);
  assert.deepEqual(reviews(http), []);

  // Ready, then switched off before the asker pressed: the press runs every check again and starts nothing
  const later = reviewWorld();
  const laterHttp = clawReviewsOverHttp(later);
  later.identity.know("aad-b", "u-bob", "bob-gh", false);
  await asked(later, `请 {Bob} 帮我 review 合入 ${PR}`);
  await says(later, BOB, "/github auto-merge on");
  const retry = button(later, CONV, "retry");
  await says(later, BOB, "/github auto-merge off");
  await press(later, ALICE, GROUP, retry);
  assert.deepEqual(reviews(laterHttp), []);
  assert.equal(times(later, CONV, `Bob 还不能被我代审：${STEP3}`), 2);
});

test("a press a day later asks afresh as an ordinary request, and a reviewer without a key of their own is told that step too", async () => {
  const world = handoffWorld();
  const http = clawReviewsOverHttp(world);
  http.recordHandoff("h-1", false);
  world.identity.know("aad-b", "u-bob", "bob-gh", false);
  await handBack(world, handoffEvent({ handoffId: "h-1", merge: false }));
  await says(world, BOB, "/github auto-merge on");
  const retry = button(world, ALICE_DM, "retry");
  // A day later Claw no longer has the handoff: the same request, as an ordinary one, still review only
  await world.clock.advance(25 * 3600_000);
  await press(world, ALICE, dm(ALICE_DM), retry);
  await settleFollows(world);
  assert.equal(http.requests.length, 1);
  assert.equal(http.requests[0]?.body.handoff_id, undefined);
  assert.equal(http.requests[0]?.body.review_only, true);

  const unlinked = reviewWorld();
  clawReviewsOverHttp(unlinked);
  unlinked.store.links.unlink("aad-b");
  await asked(unlinked, `请 {Bob} 帮我 review 合入 ${PR}`);
  assert.ok(
    saidIn(unlinked.surface, CONV).includes("还差第 4 步「发 `/link` 连接自己的 PrimusClaw key」（共 4 步："),
    saidIn(unlinked.surface, CONV),
  );
  assert.ok(
    saidIn(unlinked.surface, BOB_DM).includes(
      "4. Link your own PrimusClaw key: send me `/link` here (a review asked of you runs on your own model quota) <- this step now",
    ),
  );
  await unlinked.service.sweepOnboarding();
  assert.equal(notes(unlinked, CONV).filter((n) => n.text.includes(READY)).length, 0);
  unlinked.link("aad-b", "Bob", "ak-bob-again");
  await unlinked.service.sweepOnboarding();
  assert.equal(notes(unlinked, CONV).filter((n) => n.text.includes(READY)).length, 1);
});

test("a step button pressed outside the person's own chat does nothing there", async () => {
  const world = reviewWorld();
  world.identity.know("aad-b", "u-bob", "bob-gh", false);
  const settled = await press(world, BOB, GROUP, { primusclaw: "review_onboarding", op: "auto_merge_on" });
  assert.ok(shown(settled[0]).includes("1:1"));
  assert.equal(world.identity.users.get("aad-b")?.delegation, false);
  const odd = await press(world, BOB, dm(BOB_DM), { primusclaw: "review_onboarding", op: "something" });
  assert.ok(shown(odd[0]).includes("已失效"));
});

test("a reviewer who could not be reached is sent every step on their next message, once", async () => {
  const world = reviewWorld();
  clawReviewsOverHttp(world);
  world.identity.know("aad-b", "u-bob", null);
  const surface = world.surface as unknown as { reachable: Set<string> };
  surface.reachable = new Set(["aad-a"]);
  await asked(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  assert.ok(saidIn(world.surface, CONV).includes("我没能私信 Bob；请 Bob 在 1:1 里给我发任意一条消息"));
  assert.equal(saidIn(world.surface, BOB_DM), "");
  surface.reachable = new Set(["aad-a", "aad-b"]);
  await says(world, BOB, "你好");
  await world.service.sweepOnboarding();
  const bob = saidIn(world.surface, BOB_DM);
  assert.equal(times(world, BOB_DM, "Alice asked me in a group chat to review and merge"), 1, bob);
  assert.ok(bob.includes("2. Connect GitHub: send me `/github bind` here") && bob.includes("<- this step now"), bob);
  assert.ok(!bob.includes("Next is step"), bob);
  assert.ok(notes(world, BOB_DM).some((n) => n.buttons.some((b) => b.op === "bind")));
});

/** Every send into `conversation` fails, as a channel that refuses it does, until the returned function is called. */
function failSends(world: ReviewWorld, conversation: string): () => void {
  const surface = world.surface as unknown as { conversation: (ref: { id: string }) => { send: unknown } };
  const real = surface.conversation.bind(world.surface);
  surface.conversation = (ref) => {
    const made = real(ref);
    if (ref.id === conversation) made.send = () => Promise.reject(new Error("the channel refused it"));
    return made;
  };
  return () => {
    surface.conversation = real;
  };
}

test("a reviewer not reachable when the sweep first reads them is still sent every step on their next message", async () => {
  const world = reviewWorld();
  clawReviewsOverHttp(world);
  world.identity.know("aad-b", "u-bob", null);
  const surface = world.surface as unknown as { reachable: Set<string> };
  surface.reachable = new Set(["aad-a"]);
  await asked(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  assert.ok(saidIn(world.surface, CONV).includes("请 Bob 在 1:1 里给我发任意一条消息"));
  // (the sweep runs within a minute of the ask; Bob still cannot be reached, so nothing is claimed as said)
  await world.service.sweepOnboarding();
  await world.service.sweepOnboarding();
  assert.equal(saidIn(world.surface, BOB_DM), "");
  surface.reachable = new Set(["aad-a", "aad-b"]);
  await says(world, BOB, "你好");
  await world.service.sweepOnboarding();
  const bob = saidIn(world.surface, BOB_DM);
  assert.equal(times(world, BOB_DM, "Alice asked me in a group chat to review and merge"), 1, bob);
  assert.ok(bob.includes("2. Connect GitHub: send me `/github bind` here") && bob.includes("<- this step now"), bob);
  assert.equal(notes(world, BOB_DM).filter((n) => n.buttons.some((b) => b.op === "bind")).length, 1);
});

test("a next step whose message failed is sent on the next read, once", async () => {
  const world = reviewWorld();
  clawReviewsOverHttp(world);
  bobUnknown(world);
  await asked(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  bobConfirms(world);
  const restore = failSends(world, BOB_DM);
  await world.service.sweepOnboarding();
  assert.equal(times(world, BOB_DM, "Next is step 2 of 3"), 0);
  restore();
  await world.service.sweepOnboarding();
  await says(world, BOB, "hi");
  await world.service.sweepOnboarding();
  assert.equal(times(world, BOB_DM, "Next is step 2 of 3"), 1, saidIn(world.surface, BOB_DM));
  assert.equal(notes(world, BOB_DM).filter((n) => n.buttons.some((b) => b.op === "bind")).length, 1);
});

test("an asker who could not be told the reviewer is ready is told on the next read, once, and the retry works", async () => {
  const world = reviewWorld();
  const http = clawReviewsOverHttp(world);
  world.identity.know("aad-b", "u-bob", "bob-gh", false);
  await asked(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  const restore = failSends(world, CONV);
  await says(world, BOB, "/github auto-merge on");
  await world.service.sweepOnboarding();
  restore();
  assert.equal(notes(world, CONV).filter((n) => n.text.includes(READY)).length, 0);
  assert.equal(times(world, BOB_DM, "All steps are done"), 0, "the reviewer hears it once the asker has");
  await world.service.sweepOnboarding();
  await world.service.sweepOnboarding();
  assert.equal(notes(world, CONV).filter((n) => n.text.includes(READY)).length, 1);
  assert.equal(times(world, BOB_DM, "All steps are done. I told Alice"), 1);
  await press(world, ALICE, GROUP, button(world, CONV, "retry"));
  await settleFollows(world);
  assert.equal(http.requests.length, 1);
  assert.equal(http.requests[0]?.headers["x-acting-as-token"], "tok-aad-b");
});

/** Every note card (a step's buttons) sent into `conversation` fails; plain text still goes. */
function failCards(world: ReviewWorld, conversation: string): void {
  const surface = world.surface as unknown as {
    conversation: (ref: { id: string }) => { send: (message: OutMessage) => Promise<unknown> };
  };
  const real = surface.conversation.bind(world.surface);
  surface.conversation = (ref) => {
    const made = real(ref);
    if (ref.id !== conversation) return made;
    const send = made.send.bind(made);
    made.send = (message) =>
      message.body.type === "view" && message.body.view.name === "note"
        ? Promise.reject(new Error("the channel refused the card"))
        : send(message);
    return made;
  };
}

test("a step whose text went but whose card failed is not said again, by the sweep or by the reviewer's messages", async () => {
  const world = reviewWorld();
  clawReviewsOverHttp(world);
  bobUnknown(world);
  await asked(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  failCards(world, BOB_DM);
  bobConfirms(world);
  for (let i = 0; i < 5; i += 1) await world.service.sweepOnboarding();
  await says(world, BOB, "hi");
  assert.equal(times(world, BOB_DM, "Next is step 2 of 3"), 1, saidIn(world.surface, BOB_DM));
  assert.equal(notes(world, BOB_DM).filter((n) => n.buttons.some((b) => b.op === "bind")).length, 0);

  // The first message too: its card failing does not leave the steps unsaid for the sweep to say again
  const first = reviewWorld();
  clawReviewsOverHttp(first);
  first.identity.know("aad-b", "u-bob", "bob-gh", false);
  failCards(first, BOB_DM);
  await asked(first, `请 {Bob} 帮我 review 合入 ${PR}`);
  assert.ok(saidIn(first.surface, CONV).includes(STEP3), saidIn(first.surface, CONV));
  assert.ok(saidIn(first.surface, CONV).includes("我已私信 TA 这几步"), saidIn(first.surface, CONV));
  for (let i = 0; i < 5; i += 1) await first.service.sweepOnboarding();
  await says(first, BOB, "hi");
  assert.equal(times(first, BOB_DM, "as you; I have done nothing yet"), 1, saidIn(first.surface, BOB_DM));
  assert.equal(times(first, BOB_DM, "Next is step"), 0);
});

test("a step held back by the daily limit for another notice is still sent, once, and the asker hears it was", async () => {
  const world = reviewWorld();
  clawReviewsOverHttp(world);
  world.identity.know("aad-b", "u-bob", "bob-gh", false);
  // (earlier today Bob was sent a GitHub notice of the same kind for something else)
  assert.ok(world.store.reviewDelegation.claimGithubNotice("aad-b", "bind", 86_400));
  await asked(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  assert.equal(times(world, BOB_DM, "as you; I have done nothing yet"), 1, saidIn(world.surface, BOB_DM));
  assert.ok(saidIn(world.surface, BOB_DM).includes("<- this step now"));
  assert.equal(notes(world, BOB_DM).filter((n) => n.buttons.some((b) => b.op === "auto_merge_on")).length, 1);
  assert.ok(saidIn(world.surface, CONV).includes(STEP3));
  assert.ok(saidIn(world.surface, CONV).includes("我已私信 TA 这几步"), saidIn(world.surface, CONV));
  // Asked again, and read again: nothing more for Bob
  await asked(world, `请 {Bob} 帮我 review 合入 ${PR2}`, ALICE, "g2");
  await world.service.sweepOnboarding();
  await says(world, BOB, "hi");
  assert.equal(times(world, BOB_DM, "as you; I have done nothing yet"), 1);
  assert.equal(notes(world, BOB_DM).filter((n) => n.buttons.some((b) => b.op === "auto_merge_on")).length, 1);
  // ...and he can do it from there
  await press(world, BOB, dm(BOB_DM), button(world, BOB_DM, "auto_merge_on"));
  assert.equal(notes(world, CONV).filter((n) => n.text.includes(READY)).length, 2);
});

test("an asker who could not be told the reviewer said no is told on the next sweep, once", async () => {
  const world = reviewWorld();
  const http = clawReviewsOverHttp(world);
  world.identity.know("aad-b", "u-bob", "bob-gh", false);
  await asked(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  const decline = button(world, BOB_DM, "decline");
  const restore = failSends(world, CONV);
  await press(world, BOB, dm(BOB_DM), decline);
  await world.service.sweepOnboarding();
  restore();
  assert.equal(times(world, CONV, "选择暂不开启代审授权"), 0);
  await world.service.sweepOnboarding();
  assert.equal(times(world, CONV, `Bob 选择暂不开启代审授权，所以 ${PR} 的代审不会开始`), 1);
  await world.service.sweepOnboarding();
  await says(world, BOB, "/github auto-merge off");
  assert.equal(times(world, CONV, "选择暂不开启代审授权"), 1);
  // Nothing waits for Bob any more, and nothing starts
  assert.equal(times(world, BOB_DM, "Next is step"), 0);
  assert.equal(notes(world, CONV).filter((n) => n.text.includes(READY)).length, 0);
  assert.deepEqual(reviews(http), []);
});
