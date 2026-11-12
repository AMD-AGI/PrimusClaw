// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The conformance kit: what every surface package must pass, on the product path. One run of the surface's own worker
 * (`KitRun`) against the fake Claw serves every test; each test has people and chats of its own, says what they do in
 * surface-neutral words through the surface's driver, and checks what reached the chat and what Claw was asked. A surface
 * package runs it from one test file:
 *
 *     surfaceConformance(teamsUnderTest());
 *
 * What depends on what the surface can do is read from its caps: a surface that cannot stream must show the answer as a
 * message instead, one that cannot edit must never edit, and the interactive cards are checked where views are drawn.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { SURFACE_CHANNEL } from "@primusclaw/personal-agent";

import { keyOf } from "./claw.js";
import type { KitChat, KitPerson, SeenMessage, SurfaceUnderTest } from "./driver.js";
import { dmOf, KitRun, person } from "./world.js";

/** What Claw takes as a surface label (`NOTIFICATION_SURFACE_PATTERN` of Claw's wire contract). */
const CLAW_SURFACE_LABEL = /^[a-z][a-z0-9_-]{0,31}$/;

/** The people whose 1:1 messages go to their assistant. */
const ASSISTED = { reply: person("reply"), choice: person("choice") };

/**
 * The person's words came back as the chat turn's answer: the fake Claw answers "Echo: <prompt>", and the prompt holds the
 * words (in a group with the chat's recent messages and the reply language around them).
 */
function answers(words: string): (m: SeenMessage) => boolean {
  return (m) => m.final && m.text.startsWith("Echo: ") && m.text.includes(words);
}

/** The buttons of `message` that call the bot back (not links), in order. */
function actionButtons(message: SeenMessage): string[] {
  return message.buttons.filter((b) => b.url === undefined).map((b) => b.title);
}

function isoNow(): string {
  return new Date().toISOString();
}

/** The run every test of one surface shares (started before the first, stopped by the last). */
interface Shared {
  run: KitRun | undefined;
}

function runOf(shared: Shared): KitRun {
  if (shared.run === undefined) throw new Error("the surface's worker did not start");
  return shared.run;
}

/** `who` links their 1:1 chat; that chat. */
async function linked(run: KitRun, who: KitPerson): Promise<KitChat> {
  const dm = dmOf(who);
  await run.link(who, dm);
  return dm;
}

/**
 * A pressed card is settled: edited in place where the surface edits, else answered with a new message; a surface that
 * cannot edit never edits.
 */
async function settled(run: KitRun, dm: KitChat, card: SeenMessage): Promise<void> {
  const shown = run.driver.seen(dm);
  const after = shown.findIndex((m) => m.op === card.op && m.id === card.id && m.text === card.text) + 1;
  assert.ok(after > 0, "the card is among what the chat was shown");
  if (run.driver.caps.edit) {
    await run.shown(dm, (m) => m.op === "edit" && m.id === card.id, "the card edited in place", after);
  } else {
    await run.shown(dm, (m) => m.op === "post", "a message after the press", after);
    assert.deepEqual(
      run.driver.seen(dm).filter((m) => m.op === "edit"),
      [],
      "no edit on a surface that cannot edit",
    );
  }
}

function names(shared: Shared): void {
  it("names itself as core and Claw need it: a channel id Claw takes as a surface, a full and a short name", () => {
    const { caps } = runOf(shared).driver;
    assert.match(caps.channel, SURFACE_CHANNEL);
    assert.match(caps.channel, CLAW_SURFACE_LABEL, "a label Claw takes as a subscription's surface");
    assert.ok(caps.name.length > 0 && caps.shortName.length > 0, "names");
    assert.ok(caps.streamSeconds > 0, "a stream's life");
  });
}

function identity(shared: Shared): void {
  it("a person links their chat with the console's code; their subscription names this surface", async () => {
    const run = runOf(shared);
    const who = person("link");
    await linked(run, who);
    const sub = run.subscriptionOf(who);
    assert.ok(sub, "a notification subscription was made");
    assert.equal(sub.body["surface"], run.driver.caps.channel);
    assert.equal(run.claw.callsBy(who.id, "GET", "/api/v1/users/self").length > 0, true, "the key's owner was asked");
  });

  it("a person who has not linked is told how to connect, and nothing is sent to Claw for them", async () => {
    const run = runOf(shared);
    const who = person("stranger");
    const dm = dmOf(who);
    await run.driver.say(dm, who, "hello");
    await run.shown(dm, (m) => m.final && m.text.length > 0, "the connect message");
    assert.deepEqual(run.claw.callsBy(who.id, "POST", "/v1/sessions"), []);
  });
}

function turns(shared: Shared): void {
  it("a message in a 1:1 chat starts a turn with the person's key, and its answer reaches the chat", async () => {
    const run = runOf(shared);
    const who = person("turn");
    const dm = await linked(run, who);
    await run.driver.say(dm, who, "hello there");
    await run.shown(dm, answers("hello there"), "the turn's answer");
    assert.equal(run.claw.callsBy(who.id, "POST", "/v1/sessions").length, 1);
  });

  it("a turn's live message ends in its answer where the surface streams; elsewhere the answer is a message", async () => {
    const run = runOf(shared);
    const who = person("stream");
    const dm = await linked(run, who);
    const before = run.driver.seen(dm).length;
    await run.driver.say(dm, who, "count to three");
    const answer = await run.shown(dm, answers("count to three"), "the turn's answer", before);
    const shown = run.driver.seen(dm).slice(before);
    const streamed = shown.filter((m) => m.op === "stream");
    if (run.driver.caps.streaming) {
      assert.equal(answer.op, "stream", "the answer closes the live message");
      assert.ok(
        streamed.some((m) => !m.final && m.id === answer.id),
        "the live message showed progress first",
      );
      assert.equal(streamed.filter((m) => m.final).length, 1, "one final");
    } else {
      assert.deepEqual(streamed, [], "no stream on a surface that cannot stream");
    }
    assert.equal(shown.filter(answers("count to three")).length, 1, "the answer is shown once");
  });

  it("in a group the bot answers only when it is @mentioned", async () => {
    const run = runOf(shared);
    const who = person("group");
    await linked(run, who);
    const group: KitChat = { id: "kit-group", kind: "group" };
    await run.driver.say(group, who, "lunch at noon?");
    await delay(300);
    assert.deepEqual(run.driver.seen(group), [], "a message that does not mention the bot is not answered");
    assert.deepEqual(run.claw.callsBy(who.id, "POST", "/v1/sessions"), []);
    await run.driver.say(group, who, "summarise the thread", { mentionsBot: true });
    await run.shown(group, answers("summarise the thread"), "the group's answer");
  });
}

function claw(shared: Shared): void {
  it("a message to the assistant names this surface, and the reply Claw sends back reaches the chat it came from", async () => {
    const run = runOf(shared);
    const who = ASSISTED.reply;
    const dm = await linked(run, who);
    await run.driver.say(dm, who, "what is on my plate?");
    const session = `a-${who.id}`;
    const path = `/v1/sessions/${session}/messages`;
    await run.until(() => run.claw.calls("POST", path).length > 0, "the message to Claw");
    const sent = run.claw.calls("POST", path)[0]?.json as Record<string, unknown>;
    assert.equal(sent["content"], "what is on my plate?");
    const context = sent["channel_context"] as Record<string, unknown> | undefined;
    assert.equal(context?.["channel"], run.driver.caps.channel, "channel_context.channel names this surface");
    const answered = await run.event(who, {
      event_id: "ev-say",
      type: "assistant.say",
      session_id: session,
      turn_message_id: run.claw.latestMessage(session),
      text: "Two reviews and a deploy.",
      occurred_at: isoNow(),
    });
    assert.deepEqual(answered, { status: 200, body: { status: "delivered" } });
    await run.shown(dm, (m) => m.final && m.text.includes("Two reviews and a deploy."), "the reply");
  });

  it("a proactive notice Claw sends reaches the person's 1:1 chat once", async () => {
    const run = runOf(shared);
    const who = person("notice");
    const dm = await linked(run, who);
    const event = {
      event_id: "ev-run",
      type: "run.completed",
      session_id: "s-nightly",
      title: "Nightly build",
      summary: "All 12 jobs passed.",
      occurred_at: isoNow(),
    };
    assert.deepEqual(await run.event(who, event), { status: 200, body: { status: "delivered" } });
    await run.shown(dm, (m) => m.text.includes("Nightly build"), "the notice");
    assert.deepEqual(await run.event(who, event), { status: 200, body: { status: "duplicate" } });
    assert.equal(run.driver.seen(dm).filter((m) => m.text.includes("Nightly build")).length, 1);
  });
}

function cards(shared: Shared, views: boolean): void {
  const skip = views ? false : "the surface draws no views";
  it(
    "a choice card: its options are shown, and what is picked reaches the assistant as the person's message",
    { skip },
    async () => {
      const run = runOf(shared);
      const who = ASSISTED.choice;
      const dm = await linked(run, who);
      const session = `a-${who.id}`;
      const said = { event_id: "ev-choice", type: "assistant.say", session_id: session, occurred_at: isoNow() };
      await run.event(who, { ...said, text: "Deploy to which cluster?", choices: { options: ["prod", "staging"] } });
      const card = await run.shown(dm, (m) => m.choices.length > 0, "the choice card");
      assert.deepEqual(card.choices, ["prod", "staging"]);
      const [send] = actionButtons(card);
      assert.ok(send !== undefined, "the card has a button to send what was picked");
      await run.driver.press(dm, who, card, send, ["staging"]);
      const path = `/v1/sessions/${session}/messages`;
      await run.until(() => run.claw.calls("POST", path).length > 0, "the pick sent to Claw");
      assert.equal((run.claw.calls("POST", path)[0]?.json as Record<string, unknown>)["content"], "staging");
      await settled(run, dm, card);
    },
  );

  it(
    "an approval card: its first button approves, and Claw is told the person's decision with their key",
    { skip },
    async () => {
      const run = runOf(shared);
      const who = person("approve");
      const dm = await linked(run, who);
      const approval = { tool: "Bash", tool_use_id: "tu-1", target: "make release" };
      const expires = Math.floor(Date.now() / 1000) + 600;
      const event = {
        event_id: "ev-ap",
        type: "approval.requested",
        session_id: "s-run",
        expires_at: expires,
        approval,
      };
      assert.deepEqual(await run.event(who, { ...event, occurred_at: isoNow() }), {
        status: 200,
        body: { status: "delivered" },
      });
      const card = await run.shown(dm, (m) => actionButtons(m).length >= 2, "the approval card");
      await run.driver.press(dm, who, card, actionButtons(card)[0] ?? "");
      const path = "/v1/sessions/s-run/messages";
      await run.until(() => run.claw.calls("POST", path).length > 0, "the decision sent to Claw");
      const decided = run.claw.calls("POST", path)[0];
      assert.ok(decided !== undefined);
      assert.equal(decided.headers["authorization"], `Bearer ${keyOf(who.id)}`);
      assert.deepEqual(decided.json, { messageType: "decision", extData: { tool_use_id: "tu-1", action: "allow" } });
      await settled(run, dm, card);
    },
  );
}

function lastly(shared: Shared): void {
  it("what the surface says it cannot do, it never did in any test: no stream, edit or button its caps rule out", () => {
    const { caps } = runOf(shared).driver;
    const shown = runOf(shared).driver.seen();
    assert.ok(shown.length > 0);
    if (!caps.streaming)
      assert.deepEqual(
        shown.filter((m) => m.op === "stream"),
        [],
      );
    if (!caps.edit)
      assert.deepEqual(
        shown.filter((m) => m.op === "edit"),
        [],
      );
    if (!caps.views)
      assert.deepEqual(
        shown.filter((m) => m.buttons.length > 0 || m.choices.length > 0),
        [],
      );
  });

  it("stops within a second: stop and run both return", async () => {
    const took = await runOf(shared).stop();
    assert.ok(took < 1000, `stopping took ${String(Math.round(took))} ms`);
  });
}

/** Every conformance test, for `sut`, on one run of its worker. */
export function surfaceConformance(sut: SurfaceUnderTest, options: { readonly views?: boolean } = {}): void {
  describe(`surface conformance: ${sut.name}`, () => {
    const shared: Shared = { run: undefined };
    before(async () => {
      shared.run = await KitRun.start(sut, { assistant: Object.values(ASSISTED) });
    });
    after(async () => {
      await shared.run?.stop();
    });
    names(shared);
    identity(shared);
    turns(shared);
    claw(shared);
    cards(shared, options.views ?? true);
    lastly(shared);
  });
}
