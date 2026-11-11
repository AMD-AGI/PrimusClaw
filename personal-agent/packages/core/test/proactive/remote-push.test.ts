// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The assistant's half of what a remote agent says on its own and of Claw's pushes of a session: when it may wake the person
 * (`reachable`: quiet hours and /pause hold it, a person who wrote a moment ago lifts quiet hours but never a pause), what is held
 * and how it is released, and which pushes of a session reach the chat. Following the session itself is the remote line's.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { advanceSeconds } from "../../../../test-support/store.js";
import { ALICE, at, shown, world } from "../../../../test-support/assistant/proactive-world.js";
import type { JsonObject } from "../../src/json.js";
import type { RemoteAskRequest } from "../../src/proactive/deps.js";
import { DirectChat } from "../../src/direct-chat/direct-chat.js";
import type { RequestContext, RequestScope } from "../../src/ports/request-scope.js";

const LABEL = "\u{1F7E0} Claude Code on dev-pod";
const SECRET = "ghp_" + "a".repeat(36);

/** Out of the reply window: the person last wrote three hours ago. */
function longAgo(w: ReturnType<typeof world>): void {
  advanceSeconds(w.clock, 3 * 3600);
}

function quietAllDay(w: ReturnType<typeof world>): void {
  w.store.prefs.setTimezone(ALICE, "UTC");
  w.store.prefs.setQuiet(ALICE, ["00:00", "23:59"]);
}

/** What the agent said on its own, as the chat shows it (headed with who said it). */
function onItsOwn(w: ReturnType<typeof world>): string[] {
  return shown(w.surface.outbox).filter((line) => line.includes(LABEL));
}

/** Claw's push of a development environment session: an `assistant.say` about the item, with `remote`. */
function remoteSay(
  sessionId: string,
  kind: string,
  eventId: string,
  options: { text?: string; ask?: JsonObject; occurredAt?: string; seq?: number } = {},
): JsonObject {
  const seq = options.seq ?? 7;
  return {
    type: "assistant.say",
    event_id: eventId,
    ...(options.occurredAt ? { occurred_at: options.occurredAt } : {}),
    text: options.text ?? `dev-pod 上的 claude 做完了 #${String(seq)}：跑 make test\n312 passed`,
    fallback: true,
    item: { item_id: "wi-1", seq, title: "dev-pod claude：跑 make test", board_state: "done" },
    remote: {
      kind,
      session_id: sessionId,
      machine: "dev-pod",
      agent: "claude",
      ...(options.ask ? { ask: options.ask } : {}),
    },
  };
}

function anAsk(actionId = "act-1", expiresAt = "2026-10-27T05:00:00Z"): JsonObject {
  return {
    action_id: actionId,
    tool: "Bash",
    title: "Run make test",
    options: [{ optionId: "allow-once" }, { optionId: "allow-with-updates" }, { optionId: "reject" }],
    expires_at: expiresAt,
  };
}

function attach(w: ReturnType<typeof world>, sessionId: string): void {
  w.store.remoteState.attachRemote(ALICE, {
    sessionId,
    connectorId: "c1",
    agentId: "claude",
    agentLabel: "\u{1F7E0} Claude Code",
    host: "dev-pod",
    cwd: "/home/me/a",
  });
}

it("in quiet hours what the agent says on its own is held and delivered when they end", async () => {
  const w = world();
  longAgo(w);
  quietAllDay(w);
  assert.equal(w.proactive.muted(ALICE), "quiet");
  assert.equal(w.proactive.reachable(ALICE), false);
  w.proactive.holdRemote(ALICE, LABEL, "Night result: all green.", "r1");
  assert.deepEqual(onItsOwn(w), []);
  assert.deepEqual(w.store.held.usersWithHeld(), [ALICE]);
  w.store.prefs.setQuiet(ALICE, null);
  await w.release.releaseDue();
  assert.deepEqual(onItsOwn(w), [`send ${LABEL}: Night result: all green.`]);
  assert.deepEqual(w.store.held.usersWithHeld(), []);
});

it("a pause holds it too and resume releases it", async () => {
  const w = world();
  longAgo(w);
  w.store.prefs.setPausedUntil(ALICE, w.store.now() + 7200);
  assert.equal(w.proactive.reachable(ALICE), false);
  w.proactive.holdRemote(ALICE, LABEL, "Paused-time result.", "r1");
  assert.deepEqual(w.store.held.usersWithHeld(), [ALICE]);
  w.store.prefs.setPausedUntil(ALICE, null);
  await w.release.releaseDue();
  assert.equal(onItsOwn(w).length, 1);
});

it("someone who wrote a moment ago is not held back by quiet hours", () => {
  const w = world();
  quietAllDay(w);
  assert.equal(w.proactive.muted(ALICE), "quiet");
  assert.equal(w.proactive.inReplyWindow(ALICE), true);
  assert.equal(w.proactive.reachable(ALICE), true);
});

it("a pause typed a moment ago still holds what the agent says on its own until it is over", async () => {
  const w = world();
  w.store.prefs.setPausedUntil(ALICE, w.store.now() + 2 * 3600);
  assert.equal(w.proactive.muted(ALICE), "paused");
  assert.equal(w.proactive.inReplyWindow(ALICE), true); // (the /pause is the person's last message)
  assert.equal(w.proactive.reachable(ALICE), false);
  w.proactive.holdRemote(ALICE, LABEL, "Result right after the pause command.", "r1");
  await w.release.releaseDue();
  assert.deepEqual(onItsOwn(w), []);
  advanceSeconds(w.clock, 2 * 3600 + 60);
  await w.release.releaseDue();
  assert.deepEqual(onItsOwn(w), [`send ${LABEL}: Result right after the pause command.`]);
});

it("a pause typed a moment ago gives no permission card", async () => {
  const w = world();
  w.store.prefs.setPausedUntil(ALICE, w.store.now() + 2 * 3600);
  // What the agent asks on its own (the remote line's follower) is put to the person only when this says so: never in a pause.
  assert.equal(w.proactive.muted(ALICE), "paused");
  assert.equal(w.proactive.reachable(ALICE), false);
  // Outside the reply window Claw's push of that request is held as well, card and all (as the Python worker's
  // `Proactive.handle`: a say in the reply window is a reply, delivered).
  advanceSeconds(w.clock, 3600);
  assert.equal(
    await w.proactive.handle(ALICE, w.reference, remoteSay("rs-1", "needs_you", "say-ask", { ask: anAsk() })),
    "held",
  );
  assert.deepEqual(shown(w.surface.outbox), []);
  assert.equal(w.store.remotePermissions.getRemotePermission("rs-1", "act-1"), null);
});

it("what is held is sent as messages the newest five and a line for the rest and secrets are masked", async () => {
  const w = world();
  for (let n = 0; n < 7; n += 1) {
    w.proactive.holdRemote(ALICE, LABEL, `held ${String(n)}${n === 6 ? ` token ${SECRET}` : ""}`, `r${String(n)}`);
  }
  assert.equal(w.proactive.muted(ALICE), undefined);
  await w.release.release(ALICE);
  const sent = shown(w.surface.outbox);
  assert.ok(sent[0]?.includes("2 earlier messages from your remote agent"), sent.join("\n"));
  assert.deepEqual(
    sent.slice(1).map((line) => /held (\d)/.exec(line)?.[1]),
    ["2", "3", "4", "5", "6"],
  );
  assert.ok(!sent.some((line) => line.includes(SECRET)));
});

it("what is held is masked in the store too", () => {
  const w = world();
  w.proactive.holdRemote(ALICE, LABEL, `key ${SECRET}`, "r1");
  const [held, ...more] = w.store.held.takeHeld(ALICE);
  assert.deepEqual(more, []);
  assert.ok(held !== undefined);
  const text = held["text"];
  assert.ok(typeof text === "string" && !text.includes("ghp_"));
  assert.equal(held["type"], "remote.said");
  assert.equal(held["label"], LABEL);
});

it("a needs you push is one approval card with the agents options for its session and request", async () => {
  const asked: RemoteAskRequest[] = [];
  const w = world({
    remote: {
      options: (raw): readonly unknown[] => (Array.isArray(raw) ? (raw as unknown[]) : []),
      askCard: (request) => {
        asked.push(request);
        return { body: { type: "text", text: `ask ${request.sessionId} ${String(request.ask["action_id"])}` } };
      },
      saidParts: (label, text) => [`${label}: ${text}`],
    },
  });
  const text = "dev-pod 上的 claude 在等你批准：Run make test（#7 跑 make test）。发 /agent attach rs-1 切过去处理。";
  assert.equal(
    await w.proactive.handle(ALICE, w.reference, remoteSay("rs-1", "needs_you", "say-ask", { text, ask: anAsk() })),
    "delivered",
  );
  assert.deepEqual(shown(w.surface.outbox), ["send ask rs-1 act-1"]); // (one push: the card, not the words to type)
  assert.deepEqual(
    asked.map((r) => [r.sessionId, r.about, r.options]),
    [["rs-1", "#7 dev-pod claude：跑 make test", anAsk()["options"]]],
  );
  // The card's button answers the agent through the request this push recorded for the person.
  const saved = w.store.remotePermissions.getRemotePermission("rs-1", "act-1");
  assert.equal(saved?.userId, ALICE);
});

it("the same request is one card whoever shows it first", async () => {
  const w = world();
  const push = (eventId: string, ask: JsonObject) =>
    w.proactive.handle(ALICE, w.reference, remoteSay("rs-1", "needs_you", eventId, { text: "x", ask }));
  assert.equal(await push("say-ask", anAsk()), "delivered");
  assert.equal(await push("say-ask-2", anAsk()), "dropped"); // (Claw's retry, or the same request pushed twice)
  // One that the attached chat's reader already showed is not shown again either.
  w.store.remotePermissions.saveRemotePermission({
    userId: ALICE,
    sessionId: "rs-1",
    actionId: "act-2",
    tool: "Edit main.go",
    options: [{ optionId: "allow-once" }],
    expiresAt: w.store.now() + 600,
  });
  assert.equal(await push("say-ask-3", anAsk("act-2")), "dropped");
  // One that ran out while it was held is not put to the person.
  assert.equal(await push("say-ask-4", anAsk("act-3", "2000-01-01T00:00:00Z")), "dropped");
  assert.deepEqual(shown(w.surface.outbox), ["send ask rs-1 act-1"]);
});

it("a finish is not pushed into the chat that shows that session", async () => {
  const w = world();
  w.proactive.showsAttached = true;
  attach(w, "rs-shown");
  advanceSeconds(w.clock, 60);
  const now = new Date(w.store.now() * 1000).toISOString();
  const push = (event: JsonObject) => w.proactive.handle(ALICE, w.reference, event);
  // The chat is that session's own view: its finish and its failure are not said a second time.
  assert.equal(await push(remoteSay("rs-shown", "done", "say-done", { occurredAt: now })), "dropped");
  const failed = "dev-pod 上的 claude 出错了，#7 没有做完：跑 make test";
  assert.equal(await push(remoteSay("rs-shown", "error", "say-err", { text: failed, occurredAt: now })), "dropped");
  assert.deepEqual(shown(w.surface.outbox), []);
  // Another session's finish is news here.
  const other = remoteSay("rs-other", "done", "say-other", {
    text: "dev-pod 上的 codex 做完了 #8：跑 lint\nclean",
    occurredAt: now,
    seq: 8,
  });
  assert.equal(await push(other), "delivered");
  assert.ok(shown(w.surface.outbox).some((line) => line.includes("做完了 #8")));
});

it("a finish and an error are pushed to a chat that is not attached", async () => {
  const w = world({ now: at(12) });
  w.proactive.showsAttached = true;
  const push = (event: JsonObject) => w.proactive.handle(ALICE, w.reference, event);
  assert.equal(await push(remoteSay("rs-1", "done", "say-done")), "delivered");
  const failed = "dev-pod 上的 claude 出错了，#7 没有做完：跑 make test";
  assert.equal(await push(remoteSay("rs-1", "error", "say-err", { text: failed })), "delivered");
  const said = shown(w.surface.outbox);
  assert.ok(said.some((line) => line.includes("做完了 #7")));
  assert.ok(said.some((line) => line.includes("出错了，#7")));
});

/** A synchronous stack of request contexts (what a router's scope holds while it handles an event). */
class StackScope implements RequestScope {
  private readonly stack: RequestContext[] = [];

  run<T>(context: RequestContext, fn: () => T): T {
    this.stack.push(context);
    const out = fn();
    if (out instanceof Promise) return out.finally(() => this.stack.pop()) as T;
    this.stack.pop();
    return out;
  }

  current(): RequestContext | undefined {
    return this.stack.at(-1);
  }
}

/** A chat in an agent's window, paused, holding an English say and an English permission request of its agent. */
async function heldInEnglish(scope: RequestScope) {
  const asked: RemoteAskRequest[] = [];
  const w = world({
    requestScope: scope,
    direct: new DirectChat(true, [ALICE]),
    remote: {
      options: (raw): readonly unknown[] => (Array.isArray(raw) ? (raw as unknown[]) : []),
      askCard: (request) => {
        asked.push(request);
        return { body: { type: "text", text: `ask ${request.sessionId}` } };
      },
      saidParts: (label, text) => [`${label}: ${text}`],
    },
  });
  attach(w, "rs-1");
  longAgo(w);
  w.store.prefs.setPausedUntil(ALICE, w.store.now() + 3600);
  const say = { type: "assistant.say", event_id: "s1", text: "The build is green again." };
  assert.equal(await w.proactive.handle(ALICE, w.reference, say), "held");
  assert.equal(
    await w.proactive.handle(
      ALICE,
      w.reference,
      remoteSay("rs-1", "needs_you", "p1", { text: "Run make test?", ask: anAsk("act-1", "2026-10-28T00:00:00Z") }),
    ),
    "held",
  );
  w.store.prefs.setPausedUntil(ALICE, null);
  return { w, asked };
}

function suggested(w: ReturnType<typeof world>): string[] {
  return w.surface.outbox.flatMap((r) => ("message" in r ? (r.message.suggestions ?? []).map((s) => s.title) : []));
}

it("held messages released while the person's message is handled answer in their client's language", async () => {
  // Python: `/resume` (agent.py `_release_if_open`) runs inside Agent.handle, where answer_lang reads CLIENT_LOCALE.
  const scope = new StackScope();
  const { w, asked } = await heldInEnglish(scope);
  const context = { clientLocale: "zh-CN", activityId: "a1", userId: ALICE, conversationId: `c-${ALICE}` };
  await scope.run(context, () => w.release.release(ALICE));
  assert.deepEqual(
    asked.map((r) => r.lang),
    ["zh"],
  );
  assert.ok(suggested(w).includes("回到 Clawy"), suggested(w).join(" | "));
});

it("a push or a sweep outside any message answers in the language of the text", async () => {
  // Python: a push (link_api) and the release sweep run with CLIENT_LOCALE unset: pick_lang of the text.
  const { w, asked } = await heldInEnglish(new StackScope());
  await w.release.release(ALICE);
  assert.deepEqual(
    asked.map((r) => r.lang),
    ["en"],
  );
  assert.ok(suggested(w).includes("Back to Clawy"), suggested(w).join(" | "));
});

/** A question a terminal asks (a connector's approval hooks), as Claw relays it (`remote.ask` with `origin: "terminal"`). */
function aTerminalAsk(actionId = "act-t1"): JsonObject {
  return {
    action_id: actionId,
    tool: "Run: npm test",
    origin: "terminal",
    kind: "execute",
    input: { command: "npm test", description: "Run the tests" },
    options: [
      { optionId: "allow", name: "Yes", kind: "allow_once" },
      { optionId: "deny", name: "No", kind: "reject_once" },
    ],
    expires_at: "2026-10-27T05:00:00Z",
  };
}

function resolvedSay(sessionId: string, actionId: string, by: string, eventId: string): JsonObject {
  return {
    type: "assistant.say",
    event_id: eventId,
    text: by === "terminal" ? "（这个请求已在终端里回答）" : "（这个请求不再等待回答）",
    fallback: true,
    remote: {
      kind: "resolved",
      session_id: sessionId,
      machine: "dev-pod",
      agent: "claude",
      resolved: { action_id: actionId, by },
    },
  };
}

it("a terminal's question is posted as a card whose id is kept, with its whole ask", async () => {
  const w = world();
  const push = remoteSay("rs-t", "needs_you", "say-t", { text: "x", ask: aTerminalAsk() });
  assert.equal(await w.proactive.handle(ALICE, w.reference, push), "delivered");
  const posted = w.surface.outbox.filter((r) => r.op === "post");
  assert.equal(posted.length, 1);
  const saved = w.store.remotePermissions.getRemotePermission("rs-t", "act-t1");
  assert.ok(saved !== null);
  assert.equal(saved.messageId, (posted[0] as { id: string }).id);
  assert.deepEqual(saved.ask, { ...aTerminalAsk(), clawy_shown_whole: true });
  // One an agent Claw started asks keeps going out as before, with no ask kept.
  assert.equal(
    await w.proactive.handle(ALICE, w.reference, remoteSay("rs-1", "needs_you", "say-a", { text: "x", ask: anAsk() })),
    "delivered",
  );
  assert.equal(w.store.remotePermissions.getRemotePermission("rs-1", "act-1")?.ask, null);
});

it("answered at the terminal first: the card is edited in place to say so, without buttons, and nothing new is sent", async () => {
  const w = world();
  await w.proactive.handle(
    ALICE,
    w.reference,
    remoteSay("rs-t", "needs_you", "say-t", { text: "x", ask: aTerminalAsk() }),
  );
  const before = w.surface.outbox.length;
  assert.equal(
    await w.proactive.handle(ALICE, w.reference, resolvedSay("rs-t", "act-t1", "terminal", "say-r")),
    "delivered",
  );
  const after = w.surface.outbox.slice(before);
  assert.deepEqual(
    after.map((r) => r.op),
    ["update"],
  );
  const edit = after[0] as {
    id: string;
    message: {
      body: { type: string; view: { name: string; model: { title?: string; text: string; buttons?: unknown[] } } };
    };
  };
  assert.equal(edit.id, w.store.remotePermissions.getRemotePermission("rs-t", "act-t1")?.messageId);
  assert.equal(edit.message.body.view.name, "note");
  assert.match(edit.message.body.view.model.text, /terminal|终端/);
  assert.equal(edit.message.body.view.model.buttons, undefined);
  assert.equal(w.store.remotePermissions.getRemotePermission("rs-t", "act-t1")?.state, "terminal");
});

it("given up (timeout): the card says it no longer waits; answered here first: the notice changes nothing", async () => {
  const w = world();
  await w.proactive.handle(
    ALICE,
    w.reference,
    remoteSay("rs-t", "needs_you", "say-t", { text: "x", ask: aTerminalAsk() }),
  );
  await w.proactive.handle(ALICE, w.reference, resolvedSay("rs-t", "act-t1", "timeout", "say-r"));
  assert.equal(w.store.remotePermissions.getRemotePermission("rs-t", "act-t1")?.state, "expired");
  await w.proactive.handle(
    ALICE,
    w.reference,
    remoteSay("rs-t", "needs_you", "say-t2", { text: "x", ask: aTerminalAsk("act-t2") }),
  );
  w.store.remotePermissions.closeRemotePermission("rs-t", "act-t2", "decided");
  const before = w.surface.outbox.length;
  assert.equal(
    await w.proactive.handle(ALICE, w.reference, resolvedSay("rs-t", "act-t2", "terminal", "say-r2")),
    "delivered",
  );
  assert.deepEqual(w.surface.outbox.slice(before), []);
});

it("a resolved notice for a card this chat never showed is said as its one line", async () => {
  const w = world();
  assert.equal(
    await w.proactive.handle(ALICE, w.reference, resolvedSay("rs-x", "act-x", "terminal", "say-r")),
    "delivered",
  );
  assert.ok(shown(w.surface.outbox).some((line) => line.includes("已在终端里回答")));
});

it("the end of a terminal's question edits its card even in a chat attached to that session", async () => {
  const w = world();
  w.proactive.showsAttached = true;
  attach(w, "rs-t");
  advanceSeconds(w.clock, 60);
  await w.proactive.handle(
    ALICE,
    w.reference,
    remoteSay("rs-t", "needs_you", "say-t", { text: "x", ask: aTerminalAsk() }),
  );
  const before = w.surface.outbox.length;
  assert.equal(
    await w.proactive.handle(ALICE, w.reference, resolvedSay("rs-t", "act-t1", "terminal", "say-r")),
    "delivered",
  );
  assert.deepEqual(
    w.surface.outbox.slice(before).map((r) => r.op),
    ["update"],
  );
});

it("a terminal's question whose ids are not plain ids gets no card: its words are said instead", async () => {
  const w = world();
  const ask = { ...aTerminalAsk(), action_id: "x".repeat(129) };
  assert.equal(
    await w.proactive.handle(
      ALICE,
      w.reference,
      remoteSay("rs-t", "needs_you", "say-bad", { text: "终端在等你", ask }),
    ),
    "delivered",
  );
  assert.ok(!shown(w.surface.outbox).some((line) => line.includes("ask rs-t")));
  assert.ok(shown(w.surface.outbox).some((line) => line.includes("终端在等你")));
  assert.equal(w.store.remotePermissions.getRemotePermission("rs-t", "x".repeat(129)), null);
});

it("a terminal's request keeps only the options its card offers, and is marked as shown whole or not", async () => {
  const w = world();
  const cut = { ...aTerminalAsk("act-c"), input: { command: "x".repeat(20_000) } };
  await w.proactive.handle(ALICE, w.reference, remoteSay("rs-t", "needs_you", "say-c", { text: "x", ask: cut }));
  const row = w.store.remotePermissions.getRemotePermission("rs-t", "act-c");
  assert.ok(row !== null);
  assert.deepEqual(
    row.options.map((o) => (o as { optionId: string }).optionId),
    ["deny"],
  );
  assert.equal(row.ask?.["clawy_shown_whole"], false);
  await w.proactive.handle(
    ALICE,
    w.reference,
    remoteSay("rs-t", "needs_you", "say-w", { text: "x", ask: aTerminalAsk("act-w") }),
  );
  const whole = w.store.remotePermissions.getRemotePermission("rs-t", "act-w");
  assert.ok(whole !== null);
  assert.deepEqual(
    whole.options.map((o) => (o as { optionId: string }).optionId),
    ["allow", "deny"],
  );
  assert.equal(whole.ask?.["clawy_shown_whole"], true);
});

it("the terminal answers while a click is on its way: the end is kept, and the click's own outcome edits the card", async () => {
  const w = world();
  await w.proactive.handle(
    ALICE,
    w.reference,
    remoteSay("rs-t", "needs_you", "say-t", { text: "x", ask: aTerminalAsk() }),
  );
  w.store.remotePermissions.closeRemotePermission("rs-t", "act-t1", "sending");
  const before = w.surface.outbox.length;
  assert.equal(
    await w.proactive.handle(ALICE, w.reference, resolvedSay("rs-t", "act-t1", "terminal", "say-r")),
    "delivered",
  );
  assert.deepEqual(w.surface.outbox.slice(before), []);
  assert.equal(w.store.remotePermissions.getRemotePermission("rs-t", "act-t1")?.state, "terminal");
});
