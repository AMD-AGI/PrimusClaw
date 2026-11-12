// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** TurnEngine: how the router's run and hooks become one turn (the Python agent's TurnContext). */

import assert from "node:assert/strict";
import { it } from "node:test";

import type { ConversationRef, Envelope, MessageId, OutMessage } from "../../src/ports/surface.js";
import type { TurnHooks as RouterHooks, TurnRun } from "../../src/routing/turn-runner.js";
import { noModelRefusalPolicy } from "../../src/plugins/model-refusal-policy.js";
import { integrationRegistry, type Integrations } from "../../src/plugins/integrations.js";
import { type ReviewTurnOptions, type TurnApprovals, TurnEngine } from "../../src/turn/runner.js";
import { Timeline } from "./timeline.js";
import {
  Bus,
  type BusOptions,
  ev,
  fakeTurnCards,
  RecordingErrors,
  RecordingLogger,
  result,
  type Script,
  ScriptedClaw,
  textOf,
} from "./world.js";

/** The test chat as the router hands it: the recording outbound side with its reference. */
class Chat extends Bus {
  readonly edited = new Set<MessageId>();
  readonly replyTo = "";
  markSettled(id: MessageId): void {
    this.edited.add(id);
  }
  constructor(
    clock: Timeline,
    readonly ref: ConversationRef,
    options: BusOptions = {},
  ) {
    super(clock, options);
  }
}

interface Recorded {
  readonly approvals: unknown[][];
  readonly hooks: unknown[][];
}

function approvals(recorded: Recorded, take: boolean, fail = false): TurnApprovals {
  return {
    record: (...args: [string, string, string, string, number | undefined, Envelope]) => {
      recorded.approvals.push(["record", ...args.slice(0, 5)]);
      if (fail) throw new Error("the store is gone");
      return take;
    },
    sent: (...args) => recorded.approvals.push(["sent", ...args]),
    unsent: (...args) => recorded.approvals.push(["unsent", ...args]),
  };
}

function routerHooks(recorded: Recorded, report?: OutMessage): RouterHooks {
  return {
    onSession: (...args) => recorded.hooks.push(["session", ...args]),
    onRunning: () => recorded.hooks.push(["running"]),
    onTurn: (...args) => recorded.hooks.push(["turn", ...args]),
    stopRequested: () => false,
    toolDenied: () => false,
    stopConfirmed: () => false,
    reportView: () => report,
  };
}

interface Setup {
  readonly script: Script;
  readonly run?: Partial<TurnRun>;
  readonly kind?: ConversationRef["kind"];
  readonly streams?: boolean;
  readonly take?: boolean;
  readonly report?: OutMessage;
  readonly bus?: BusOptions;
  readonly failSend?: number;
  readonly recorded?: Recorded;
  readonly integrations?: Integrations;
  readonly noFiles?: boolean;
}

async function go(setup: Setup) {
  const clock = new Timeline();
  const ref: ConversationRef = { id: "c1", kind: setup.kind ?? "personal", tenantId: "t", wire: {} };
  const chat = new Chat(clock, ref, setup.bus);
  const claw = new ScriptedClaw(clock, setup.script);
  if (setup.failSend) claw.failSendWith = setup.failSend;
  const recorded: Recorded = setup.recorded ?? { approvals: [], hooks: [] };
  const dropped: number[] = [];
  const engine = new TurnEngine({
    claw,
    clock,
    log: new RecordingLogger(),
    refusals: noModelRefusalPolicy,
    errors: new RecordingErrors(),
    publicBaseUrl: "https://x.test",
    style: {
      streamText: false,
      suggestedReplies: false,
      streamsIn: (kind) => (setup.streams ?? false) && kind === "personal",
    },
    approvals: approvals(recorded, setup.take ?? true),
    cards: fakeTurnCards,
    ...(setup.noFiles
      ? {}
      : {
          fetchFiles: () => Promise.resolve([[], [["a.png", "too big"]]] as const),
          onFilesDropped: (n: number) => dropped.push(n),
        }),
    ...(setup.integrations ? { integrations: setup.integrations } : {}),
  });
  const run: TurnRun = {
    conversation: chat,
    userId: "aad-run",
    credential: "ak-run",
    provider: undefined,
    sessionId: null,
    text: "go",
    messageId: "act-1",
    group: false,
    ownerName: "Alice",
    model: "m-1",
    fallbackModel: "",
    sessionModel: "",
    repo: null,
    showChanges: false,
    quote: "",
    sent: "",
    files: [],
    lang: "en",
    ownThumbs: false,
    notifies: false,
    review: undefined,
    ...setup.run,
  };
  const outcome = await clock.pump(engine.run(run, routerHooks(recorded, setup.report)));
  await clock.drain();
  return { outcome, chat, claw, recorded, dropped };
}

const ANSWER: Script = [[0.3, result("All done.")]];

it("the run's credential reaches Claw, the new session and its model are recorded, and the answer comes back", async () => {
  const { outcome, claw, recorded, chat } = await go({ script: ANSWER });
  assert.deepEqual(claw.calls[0], ["create", "ak-run", "go"]);
  assert.equal(claw.created[0]?.idempotencyKey, "act-1");
  assert.deepEqual(recorded.hooks.slice(0, 2), [
    ["session", "sess-ak-run", "m-1"],
    ["turn", "sess-ak-run", "started", "m1"],
  ]);
  assert.ok(recorded.hooks.some((h) => h[0] === "running"));
  assert.deepEqual(recorded.hooks.at(-1), ["turn", "sess-ak-run", "delivered", "m1"]);
  assert.equal(outcome.finalAnswer, "All done.");
  assert.equal(chat.streamOps.length, 0); // no stream where the style has none
});

it("a run with a chosen language sends it after the message; one without sends the words alone", async () => {
  const chosen = await go({ script: ANSWER, run: { text: "帮我看看", replyLang: "en" } });
  assert.deepEqual(chosen.claw.calls[0], ["create", "ak-run", "帮我看看\n\n[Reply language: English]"]);
  const none = await go({ script: ANSWER, run: { text: "帮我看看" } });
  assert.deepEqual(none.claw.calls[0], ["create", "ak-run", "帮我看看"]);
});

it("a provider's fresh credential is used instead of the run's", async () => {
  const { claw } = await go({ script: ANSWER, run: { provider: () => Promise.resolve("tok-fresh") } });
  assert.deepEqual(claw.calls[0], ["create", "tok-fresh", "go"]);
});

it("a live stream answers the person's message only where the style streams this kind of chat", async () => {
  const streamed = await go({ script: ANSWER, streams: true });
  assert.equal(streamed.chat.streamOps[0]?.op, "open");
  assert.equal(streamed.chat.streamOps.at(-1)?.text, "All done.");
  const group = await go({ script: ANSWER, streams: true, kind: "group", run: { group: true } });
  assert.equal(group.chat.streamOps.length, 0);
});

it("an approval is recorded before its card goes, and marked sent; one already shown elsewhere is not sent again", async () => {
  const script: Script = [
    [0.1, ev("permissionRequest", "m1", { tool: "bash", tool_use_id: "tu-1", timeout_ms: 90_000 })],
    [0.3, result("ok")],
  ];
  const shown = await go({ script });
  assert.deepEqual(shown.recorded.approvals, [
    ["record", "aad-run", "sess-ak-run", "tu-1", "bash", 90],
    ["sent", "sess-ak-run", "tu-1", "teams-3"],
  ]);
  assert.equal(shown.chat.sent.filter((s) => s.message?.body.type === "view").length, 1);
  const elsewhere = await go({ script, take: false });
  assert.deepEqual(elsewhere.recorded.approvals, [["record", "aad-run", "sess-ak-run", "tu-1", "bash", 90]]);
  assert.equal(elsewhere.chat.sent.filter((s) => s.message?.body.type === "view").length, 0);
});

it("an approval card the chat did not take is marked unsent and the turn fails", async () => {
  const script: Script = [[0.1, ev("permissionRequest", "m1", { tool: "bash", tool_use_id: "tu-1" })]];
  const recorded: Recorded = { approvals: [], hooks: [] };
  await assert.rejects(
    go({ script, recorded, bus: { fail: (s) => s.message?.body.type === "view" } }),
    /the queue is down/,
  );
  assert.deepEqual(recorded.approvals, [
    ["record", "aad-run", "sess-ak-run", "tu-1", "bash", undefined],
    ["unsent", "sess-ak-run", "tu-1"],
  ]);
  assert.deepEqual(recorded.hooks.at(-1), ["turn", "sess-ak-run", "failed", ""]);
});

it("the router's report card goes under a turn that went wrong", async () => {
  const report: OutMessage = { body: { type: "text", text: "REPORT" } };
  const { chat } = await go({ script: ANSWER, report, failSend: 500, run: { sessionId: "s1" } });
  assert.equal(textOf(chat.sent.at(-1)?.message), "REPORT");
});

it("files the router could not fetch are counted and named", async () => {
  const { dropped, chat } = await go({ script: ANSWER, run: { files: [{ name: "a.png", type: "png", handle: {} }] } });
  assert.deepEqual(dropped, [1]);
  assert.ok(chat.sent.some((s) => textOf(s.message) === "I could not pass on `a.png` (too big)."));
});

it("a review run carries its own options: acting as, the pull request, its lead, its one message and its result line", async () => {
  const lines: string[] = [];
  const review: ReviewTurnOptions = {
    actingAs: "u-reviewer",
    reviewTarget: { owner: "o", repo: "r", number: 7 },
    modelKey: "mk",
    reviewModel: "rm",
    reviewOnly: true,
    attach: false,
    attachMessageId: "",
    lead: "Reviewing o/r#7",
    mention: { id: "aad-a", name: "Alice", email: "", channelUserId: "29:a" },
    shapeAnswer: (answer) => `SHAPED ${answer}`,
    onGithubResult: (outcome) => {
      lines.push(outcome[1]);
      return `result ${outcome[1]}`;
    },
  };
  const script: Script = [
    [
      0.1,
      ev("toolUsed", "m1", { tool: "gh_review_submit", status: "success", description: '{"status": "submitted"}' }),
    ],
    [0.3, result("Looks good.")],
  ];
  const { claw, chat, outcome } = await go({ script, run: { review: { kind: "review", turn: review } } });
  const created = claw.created[0];
  assert.equal(created?.actingAs, "u-reviewer");
  assert.deepEqual(created.reviewTarget, { owner: "o", repo: "r", number: 7 });
  assert.equal(created.modelKey, "mk");
  assert.equal(created.model, "rm");
  assert.equal(created.reviewOnly, true);
  assert.ok(textOf(chat.sent[1]?.message).startsWith("Reviewing o/r#7\n\n"));
  assert.deepEqual(lines, ["submitted"]);
  assert.equal(textOf(chat.chat.at(-1)?.message), "SHAPED Looks good.");
  assert.deepEqual(chat.chat.at(-1)?.message.mentions, [
    { id: "aad-a", name: "Alice", email: "", channelUserId: "29:a" },
  ]);
  assert.equal(outcome.finalAnswer, "Looks good.");
  // what the review service reads of the turn afterwards (agent.py, after run_turn)
  assert.deepEqual(outcome.review, {
    moved: false,
    refusal: null,
    ranModel: "m-1", // (no routed model said: the session's, which the create gave it: the run's model)
    wrote: [["gh_review_submit", "submitted", ""]],
    prSummary: "",
  });
});

it("a chat turn carries no review outcome", async () => {
  const chatTurn = await go({ script: [[0.1, result("Hi.")]] });
  assert.equal(chatTurn.outcome.finalAnswer, "Hi.");
  assert.equal(chatTurn.outcome.review, undefined);
});

it("a review with only what it must carry, a repository for a new session, and a deployment's integrations in the progress", async () => {
  const registry = integrationRegistry();
  registry.addMcpServer("jobhub", "JobHub", { query: true });
  const review: ReviewTurnOptions = {
    actingAs: "u",
    reviewTarget: { owner: "o", repo: "r", number: 1 },
    modelKey: "",
    reviewModel: "",
    reviewOnly: false,
    attach: false,
    attachMessageId: "",
    lead: "",
    mention: undefined,
    shapeAnswer: (answer) => answer,
    onGithubResult: () => undefined,
  };
  const script: Script = [
    [0.1, ev("toolUsed", "m1", { tool: "mcp__jobhub__list_jobs", status: "start" })],
    [3.0, result("ok")],
  ];
  const { claw, chat } = await go({
    script,
    integrations: registry,
    noFiles: true,
    run: {
      review: { kind: "review", turn: review },
      repo: { url: "https://g/r", branch: "" },
      files: [{ name: "", type: "png", handle: {} }],
    },
  });
  const made = claw.created.at(-1);
  assert.deepEqual(
    [made?.modelKey, made?.model, made?.repo],
    [undefined, undefined, { url: "https://g/r", branch: "" }],
  );
  assert.ok(chat.updates.some(([, text]) => text.includes("⏳ Querying JobHub")));
  assert.ok(
    chat.sent.some((s) => textOf(s.message) === "I could not pass on `an image` (this worker does not take files)."),
  );
});
