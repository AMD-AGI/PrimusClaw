// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The router handing messages to the features: the assistant, an attached remote agent, the review service, handlers. */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { InboundMessage, JsonObject } from "@primusclaw/personal-agent";

import type {
  AssistantRouteRequest,
  RemoteAgentCommand,
  RemotePrompt,
  UnderstandRequest,
} from "../../src/routing/features.js";
import { ALICE } from "./fixtures.js";
import { clickOf, link, message, said, world } from "./world.js";

function assistantWorld(understands = false) {
  const routed: AssistantRouteRequest[] = [];
  const understood: UnderstandRequest[] = [];
  const stopped: string[] = [];
  const w = world({
    assistant: {
      on: () => true,
      understands: () => understands,
      reachable: () => true,
      hiddenCommand: (text, lang) => (text.trim() === "/new" ? `${lang}: no sessions` : undefined),
      board: () => {
        stopped.push("board");
        return Promise.resolve();
      },
      stop: () => {
        stopped.push("stop");
        return Promise.resolve(true);
      },
      route: (request) => {
        routed.push(request);
        return Promise.resolve(request.prompt !== "not mine");
      },
      understand: (request) => {
        understood.push(request);
        return Promise.resolve(true);
      },
    },
  });
  return { w, routed, understood, stopped };
}

test("with the assistant on, a message goes to it; one it does not take is a turn; its commands are its own", async () => {
  const { w, routed, stopped } = assistantWorld();
  link(w, ALICE.id, "ak");
  await w.router.handle(message("what is new"));
  await w.router.handle(message("not mine"));
  await w.router.settled();
  await w.router.handle(message("/new"));
  await w.router.handle(message("/board"));
  await w.router.handle(message("/stop"));
  assert.deepEqual(
    routed.map((r) => r.prompt),
    ["what is new", "not mine"],
  );
  assert.deepEqual(w.turns.calls, [["create", "ak", "not mine"]]);
  assert.deepEqual(
    said(w).filter((t) => t.startsWith("en:")),
    ["en: no sessions"],
  );
  assert.deepEqual(stopped, ["board", "stop"]);
  assert.equal(routed[0]?.attached, undefined); // (no remote agents here: nothing said of what the chat is attached to)
});

test("with the assistant on, /sessions shows the remote agents' sessions as /agents does; without remote agents it says why there are none", async () => {
  const listed: string[] = [];
  const on = (enabled: boolean, understands = false) =>
    world({
      assistant: {
        on: () => true,
        understands: () => understands,
        reachable: () => true,
        hiddenCommand: (text, lang) =>
          ["/new", "/sessions"].includes(text.trim()) ? `${lang}: no sessions` : undefined,
        board: () => Promise.resolve(),
        stop: () => Promise.resolve(true),
        route: () => Promise.resolve(true),
        understand: () => Promise.resolve(true),
      },
      remote: {
        enabled,
        attached: () => false,
        prompt: () => Promise.resolve(),
        agent: () => Promise.resolve(),
        agents: (chat) => (listed.push(chat.id), Promise.resolve()),
        stop: () => Promise.resolve(false),
        attachment: () => ({ label: "", host: "", cwd: "", cardWindowLine: "" }),
      },
    });
  const w = on(true);
  link(w, ALICE.id, "ak");
  await w.router.handle(message("/sessions"));
  await w.router.handle(message("sessions")); // (the menu's word)
  await w.router.handle(message("/new"));
  assert.deepEqual(listed, [ALICE.id, ALICE.id], "the agents' list, as /agents shows it");
  assert.deepEqual(
    said(w).filter((t) => t.startsWith("en:")),
    ["en: no sessions"],
    "only /new is still answered that there is one conversation",
  );
  // (a person the assistant understands: an exact command, the menu's word included, is still read here)
  const understood = on(true, true);
  link(understood, ALICE.id, "ak");
  await understood.router.handle(message("sessions"));
  await understood.router.handle(message("/sessions"));
  assert.deepEqual(listed, [ALICE.id, ALICE.id, ALICE.id, ALICE.id], "the same for a person the assistant understands");
  const off = on(false);
  link(off, ALICE.id, "ak");
  await off.router.handle(message("/sessions"));
  assert.deepEqual(listed.length, 4, "no remote agents: nothing listed");
  assert.deepEqual(
    said(off).filter((t) => t.startsWith("en:")),
    ["en: no sessions"],
  );
});

test("a person the assistant understands is sent as themselves with the chat's context; an exact command is read here", async () => {
  const { w, understood } = assistantWorld(true);
  link(w, ALICE.id, "ak-alice");
  w.exchange.enabled = true;
  w.exchange.tokens.set(ALICE.id, "tok-a");
  await w.router.handle(message("please review my PR"));
  await w.router.handle(message("/whoami"));
  assert.equal(understood.length, 1);
  assert.equal(understood[0]?.credential, "tok-a");
  assert.equal(understood[0].modelKey, "ak-alice");
  assert.ok(said(w).at(-1)?.startsWith("This chat is connected, but SaFE could not tell me"));
  w.exchange.tokens.delete(ALICE.id);
  await w.router.handle(message("again please"));
  assert.equal(understood[1]?.credential, "ak-alice"); // (no token: it goes on the linked key)
});

function remoteWorld(window: "card" | "chat" = "chat") {
  const prompts: RemotePrompt[] = [];
  const agents: RemoteAgentCommand[] = [];
  const contexts: string[] = [];
  const attachedKeys = new Set<string>([ALICE.id]);
  const w = world({
    remote: {
      enabled: true,
      attached: (key) => attachedKeys.has(key),
      windowMode: () => window,
      quotesWindow: (_key, m: InboundMessage) => m.quotes.length > 0,
      chatContext: (userId) => {
        contexts.push(userId);
        return Promise.resolve({ session_id: "rs-7" } as JsonObject);
      },
      attachment: () => ({
        label: "Codex",
        host: "dev-pod",
        cwd: "/home/me",
        cardWindowLine: "The card is the window.",
      }),
      prompt: (request) => {
        prompts.push(request);
        return Promise.resolve();
      },
      agent: (command) => {
        agents.push(command);
        if (command.args === "attach dev-pod/claude") attachedKeys.add(command.chat.id);
        if (command.args === "detach") attachedKeys.delete(command.chat.id);
        return Promise.resolve();
      },
      stop: () => Promise.resolve(true),
    },
  });
  return { w, prompts, agents, contexts, attachedKeys };
}

test("an attached chat talks to its agent; @Clawy and a message posted for the person stay the bot's", async () => {
  const { w, prompts } = remoteWorld();
  link(w, ALICE.id, "ak");
  await w.router.handle(message("run the tests"));
  await w.router.handle({ ...message("@Clawy what time is it"), namesBotFirst: true });
  await w.router.handle({ ...message("review o/r#1"), provenance: "on_behalf" });
  await w.router.settled();
  await w.router.handle(message("/stop"));
  assert.deepEqual(
    prompts.map((p) => p.prompt),
    ["run the tests"],
  );
  assert.equal(w.turns.calls.length, 2);
  await w.router.handle(message("/help"));
  assert.ok(said(w).at(-1)?.includes("This chat is attached to Codex on dev-pod `/home/me`: what you say goes to it."));
});

test("a card-window chat keeps its box for the bot unless a reply quotes the card; /agent and /agents go to the agent feature", async () => {
  const { w, prompts, agents } = remoteWorld("card");
  link(w, ALICE.id, "ak");
  await w.router.handle(message("hello bot"));
  await w.router.settled();
  await w.router.handle({
    ...message("go on"),
    quotes: [
      { author: "Codex", text: "card", fromBot: true, sentAt: "", messageId: "m1", deleted: false, source: "entity" },
    ],
  });
  await w.router.handle(message("/agent sessions"));
  await w.router.handle(message("/agents new codex /x"));
  await w.router.handle(message("/help"));
  assert.deepEqual(
    prompts.map((p) => p.prompt),
    ["go on"],
  );
  assert.deepEqual(
    agents.map((a) => a.args),
    ["sessions", "new codex /x"],
  );
  assert.ok(said(w).at(-1)?.includes("This chat is attached to Codex on dev-pod `/home/me`. The card is the window."));
});

test("a group binds to the sender's agent session, talks to it while bound, and comes back", async () => {
  const { w, prompts, agents, attachedKeys } = remoteWorld();
  attachedKeys.clear();
  link(w, ALICE.id, "ak");
  const g = (text: string) => message(text, { kind: "group", conversation: "g-1" });
  await w.router.handle(g("/agent sessions"));
  await w.router.handle(g("切到 dev-pod 的 claude"));
  await w.router.handle(g("run make"));
  await w.router.handle(g("停掉它"));
  await w.router.handle(g("回到助理"));
  await w.router.handle(g("plain question"));
  await w.router.settled();
  assert.equal(said(w)[0], "`/agent` works only in a 1:1 chat. Please do this in a 1:1 chat with me.");
  assert.deepEqual(
    agents.map((a) => [a.chat.id, a.args]),
    [
      ["aad-a|g-1", "attach dev-pod/claude"],
      ["aad-a|g-1", "detach"],
    ],
  );
  assert.deepEqual(
    prompts.map((p) => p.prompt),
    ["run make"],
  );
  assert.deepEqual(w.turns.calls, [["create", "ak", "plain question"]]);
  assert.notEqual(w.store.references.getReference("aad-a|g-1"), null);
});

test("commands of features: a handler before the account check, one after, an interceptor, and the review-stop words", async () => {
  const ran: string[] = [];
  const w = world({
    handlers: {
      commands: [
        {
          name: "github",
          beforeCredential: true,
          run: (_r, args) => (ran.push(`github ${args}`), Promise.resolve(true)),
        },
        { name: "brief", run: (r, args) => (ran.push(`brief ${args} ${r.credential}`), Promise.resolve(true)) },
      ],
      personalInterceptors: [
        {
          name: "feedback",
          intercept: (r) => Promise.resolve(r.text.startsWith("/feedback") && ran.push("feedback") > 0),
        },
      ],
    },
  });
  await w.router.handle(message("/github bind"));
  await w.router.handle(message("/feedback it broke"));
  link(w, ALICE.id, "ak");
  await w.router.handle(message("/brief on 09:00"));
  assert.deepEqual(ran, ["github bind", "feedback", "brief on 09:00 ak"]);
  assert.deepEqual(w.turns.calls, []);
  const command = await w.router.runCommand(
    "/whoami",
    w.router.chat(ALICE, w.surface.conversation(message("x").conversation)),
  );
  assert.equal(command, true);
  assert.equal(w.router.hasPersonalTurn(ALICE.id), false);
});

test("clicks go to the handler of their verb: before the credential, with it, and in a group", async () => {
  const seen: string[] = [];
  const w = world({
    handlers: {
      clicks: [
        {
          verbs: ["work"],
          beforeCredential: (c) => Promise.resolve(c.action.data["early"] === true && seen.push("early") > 0),
          withCredential: async (c, key) => {
            seen.push(`work ${key}`);
            await c.settle("done");
          },
          inGroup: async (c) => {
            seen.push("group");
            await c.settle("in group");
            return true;
          },
        },
      ],
    },
  });
  link(w, ALICE.id, "ak");
  await w.router.handle(clickOf("work", { early: true }));
  await w.router.handle(clickOf("work", {}));
  await w.router.handle(clickOf("work", {}, { group: true }));
  assert.deepEqual(seen, ["early", "work ak", "group"]);
  assert.ok(said(w).includes("note::done") && said(w).includes("note::in group"));
  assert.ok(said(w).includes("note::That button is not active any more.")); // (the early answer settled nothing: the net did)
});

test("the bind button looks for the binding: not there yet, the card comes back; there, the chat is connected", async () => {
  const w = world({ config: { exchangeForChat: true } });
  w.exchange.enabled = true;
  await w.router.handle(clickOf("bind", { action: "confirm" }));
  w.exchange.down = true;
  await w.router.handle(clickOf("bind", { action: "confirm" }));
  w.exchange.down = false;
  w.exchange.tokens.set(ALICE.id, "tok");
  await w.router.handle(clickOf("bind", { action: "confirm" }));
  const lines = said(w);
  assert.ok(lines.includes("<view:binding>"));
  assert.ok(
    lines.includes(
      "I do not see your confirmation yet. Open the link in the card above and confirm, then press the button again.",
    ),
  );
  assert.ok(
    lines.includes(
      "note:Connect Clawy:I could not reach the Primus platform. Please try again in a minute. Press Confirm again then. [Confirm]",
    ),
  );
  assert.ok(lines.includes("note::Connected. Send me a message to get started, or /help for commands."));
  assert.deepEqual(w.exchange.invalidated, [ALICE.id, ALICE.id, ALICE.id]);
});

test("unlink with chats on the exchange: the key goes, and the person is told the binding stays", async () => {
  const w = world({ config: { exchangeForChat: true } });
  w.exchange.enabled = true;
  link(w, ALICE.id, "ak");
  w.exchange.tokens.set(ALICE.id, "tok");
  await w.router.handle(message("/unlink"));
  assert.ok(said(w).at(-1)?.endsWith("delete it in SaFE under identity bindings."));
  await w.router.handle(message("/unlink"));
  assert.ok(said(w).at(-1)?.startsWith("This chat acts as you through a SaFE identity binding"));
});

test("a group's review-stop words stop the person's own reviews in Claw at once", async () => {
  const w = world({ assistant: { understands: () => true } });
  const stops: string[] = [];
  Object.assign(w.deps, { reviewStop: () => [["", 825]] as const });
  Object.assign(w.deps.claw.workItems, {
    list: () => Promise.resolve([{ itemId: "it-1", kind: "review", pull: { owner: "o", repo: "r", number: 825 } }]),
    stop: (_key: string, itemId: string) => {
      stops.push(itemId);
      return Promise.resolve({ ok: true, error: "" });
    },
  });
  link(w, ALICE.id, "ak");
  const interceptor = w.router.group.reviewStopInterceptor();
  const m = message("停 825", { kind: "group", conversation: "g-1" });
  const taken = await interceptor.intercept({
    sender: ALICE,
    conversation: w.surface.conversation(m.conversation),
    scope: "g-1",
    lang: () => "zh",
    message: m,
    text: m.text,
  });
  assert.equal(taken, true);
  assert.deepEqual(stops, ["it-1"]);
  assert.equal(said(w).at(-1), "o/r#825：代审已停下。");
});

test("test_a_handler_that_crashes_is_also_said_in_a_new_message", async () => {
  const w = world({
    handlers: {
      clicks: [{ verbs: ["work"], withCredential: () => Promise.reject(new Error("boom")) }],
    },
  });
  link(w, ALICE.id, "ak");
  await assert.rejects(w.router.handle(clickOf("work", {})), /boom/u);
  assert.deepEqual(said(w), [
    "note::I could not finish that. Please send me a message to carry on.",
    "I could not finish that. Please send me a message to carry on.",
  ]);
});

test("a vote goes to the feedback handler, and is dropped when there is none", async () => {
  const votes: string[] = [];
  const vote = {
    type: "vote" as const,
    id: "v1",
    sender: ALICE,
    conversation: message("x").conversation,
    locale: "",
    clientPlatform: "",
    messageId: "m1",
    reaction: "like" as const,
    comment: "",
  };
  const w = world({ handlers: { votes: { vote: (route) => (votes.push(route.vote.reaction), Promise.resolve()) } } });
  await w.router.handle(vote);
  await world().router.handle({ ...vote, id: "v2" });
  assert.deepEqual(votes, ["like"]);
});

test("two prompts for the attached agent at the same time: one takes the last task slot, the other is refused", async () => {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prompts: string[] = [];
  const w = world({
    limits: { maxConcurrentTasks: 1 },
    remote: {
      enabled: true,
      attached: () => true,
      prompt: async (p) => {
        prompts.push(p.prompt);
        await gate;
      },
    },
  });
  link(w, ALICE.id, "ak");
  const first = w.router.handle(message("one"));
  const second = w.router.handle(message("two"));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([first, second]);
  assert.equal(prompts.length, 1);
  assert.ok(said(w).includes("en: 1 running"));
});

test("files the channel gave no way to fetch count as files: no GitHub offer is asked again, and a group message is not empty", async () => {
  const offers: string[] = [];
  const w = world();
  Object.assign(w.deps, {
    github: {
      remember: () => undefined,
      helpValues: () => Promise.resolve({}),
      offerConnect: (r: { text: string }) => (offers.push(r.text), Promise.resolve()),
      pendingConfirmations: () => [],
      connectionState: () => Promise.resolve(undefined),
    },
  });
  link(w, ALICE.id, "ak");
  await w.router.handle({ ...message("my PRs?"), unreadableFiles: ["report.pdf"] });
  await w.router.handle(message("my PRs?"));
  await w.router.settled();
  assert.deepEqual(offers, ["my PRs?"]);
  await w.router.handle({ ...message("", { kind: "group", conversation: "g-1" }), unreadableFiles: ["a.png"] });
  await w.router.settled();
  assert.ok(!said(w).some((t) => t.startsWith("**What Clawy can do for you**")));
});

test("test_the_net_leaves_alone_what_it_must", async () => {
  const w = world({
    handlers: { clicks: [{ verbs: ["done"], withCredential: (c) => c.settle("handled").then(() => undefined) }] },
  });
  link(w, ALICE.id, "ak");
  await w.router.handle({ ...clickOf("gone", {}), invoke: false }); // (an Action.Submit message: no placeholder to replace)
  await w.router.handle(clickOf("done", {})); // (settled by its handler: the net leaves it)
  assert.deepEqual(w.surface.outbox.filter((r) => r.op === "update").length, 1);
  assert.ok(!said(w).some((t) => t.includes("not active any more")));
});
