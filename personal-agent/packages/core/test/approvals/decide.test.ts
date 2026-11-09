// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { it } from "node:test";

import { ApprovalDecisions, type ApprovalAudit, type DecisionDeps } from "../../src/approvals/decide.js";
import type { CardClick, SettleOptions } from "../../src/approvals/click.js";
import { ClawError, ClawUnreachable } from "../../src/claw/errors.js";
import type { Lang } from "../../src/locales/lang.js";
import { silentLogger } from "../../src/ports/logger.js";
import type { Approval, ApprovalState, Prefs } from "../../src/ports/store/index.js";
import type { OutMessage } from "../../src/ports/surface.js";
import { err, ok } from "../../src/result.js";
import type { TokenExchange } from "../../src/plugins/token-exchange.js";

const NOW = 1_700_000_000;

class World {
  now = NOW;
  approvals = new Map<string, Approval>();
  sessions = new Map<string, string>();
  acting = new Set<string>();
  claw: { calls: unknown[][]; fail: Error | undefined } = { calls: [], fail: undefined };
  audits: ApprovalAudit[] = [];
  refuse: string | undefined;
  taken = 0;
  givenBack = 0;
  denied: string[] = [];
  connected = 0;
  token: Awaited<ReturnType<TokenExchange["tokenFor"]>> = ok("idt-token");
  exchangeOn = true;

  pending(tool = "bash", extra: Partial<Approval> = {}): void {
    this.approvals.set("s1/tu1", {
      sessionId: "s1",
      toolUseId: "tu1",
      userId: "aad-a",
      tool,
      expiresAt: NOW + 600,
      state: "pending",
      ...extra,
    });
  }

  deps(): DecisionDeps {
    const prefs = { timezone: "Asia/Shanghai" } as Prefs;
    const exchange: TokenExchange = {
      enabled: this.exchangeOn,
      tokenFor: () => Promise.resolve(this.token),
      bindingRequest: () => Promise.resolve(err({ kind: "exchange_unavailable" })),
      invalidate: () => undefined,
    };
    const claw = {
      decide: (...args: unknown[]) => this.call("decide", args),
      answer: (...args: unknown[]) => this.call("answer", args),
    };
    return {
      store: {
        now: () => this.now,
        approvals: {
          getApproval: (s: string, t: string) => this.approvals.get(`${s}/${t}`) ?? null,
          closeApproval: (s: string, t: string, state: ApprovalState, options?: { onlyIfPending?: boolean }) => {
            const row = this.approvals.get(`${s}/${t}`);
            if (!row || ((options?.onlyIfPending ?? true) && row.state !== "pending")) return false;
            this.approvals.set(`${s}/${t}`, { ...row, state });
            return true;
          },
        },
        sessions: { getSession: (u: string, scope = "") => this.sessions.get(`${u}|${scope}`) ?? null },
        prefs: { getPrefs: () => prefs },
        reviewDelegation: { isActingSession: (s: string) => this.acting.has(s) },
      } as unknown as DecisionDeps["store"],
      claw,
      exchange,
      allowance: {
        take: () => {
          this.taken += 1;
          return this.refuse;
        },
        giveBack: () => {
          this.givenBack += 1;
        },
      },
      audit: (record) => this.audits.push(record),
      logger: silentLogger,
      connectIdentity: () => {
        this.connected += 1;
        return Promise.resolve();
      },
      onDenied: (user, scope) => this.denied.push(`${user}|${scope}`),
    };
  }

  private call(name: string, args: unknown[]): Promise<void> {
    this.claw.calls.push([name, ...args]);
    return this.claw.fail === undefined ? Promise.resolve() : Promise.reject(this.claw.fail);
  }
}

interface Settled {
  card: OutMessage | string;
  options: SettleOptions | undefined;
}

function click(data: Record<string, unknown>, user = "aad-a", scope = "", lang: Lang = "en") {
  const settled: Settled[] = [];
  const route: CardClick = {
    sender: { id: user, name: "", email: "", channelUserId: "" },
    conversation: {} as CardClick["conversation"],
    scope,
    action: { data },
    lang: () => lang,
    settle: (card, options) => {
      settled.push({ card, options });
      return Promise.resolve(true);
    },
  };
  return { route, settled };
}

const ALLOW = { primusclaw: "decision", session_id: "s1", tool: "bash", tool_use_id: "tu1", action: "allow" };
const ANSWER = {
  primusclaw: "answer",
  session_id: "s1",
  tool_use_id: "tu1",
  questions: [{ id: "q1", question: "Which?", options: [{ id: "a", label: "A" }] }],
  choice_0: "a",
};

function view(s: Settled): string {
  return typeof s.card === "string" ? s.card : s.card.body.type === "view" ? s.card.body.view.name : "?";
}

it("approve calls claw with the clickers own key and the card says it was approved", async () => {
  const w = new World();
  w.pending();
  const { route, settled } = click(ALLOW);
  await new ApprovalDecisions(w.deps()).decide(route, "ak-alice");
  assert.deepEqual(w.claw.calls, [["decide", "ak-alice", "s1", "tu1", "allow", {}]]);
  assert.equal(w.approvals.get("s1/tu1")?.state, "decided");
  assert.equal(view(settled[0] as Settled), "approvalDecided");
  assert.equal(settled[0]?.options?.fallback, "Approved: bash.");
  assert.deepEqual(
    w.audits.map((a) => [a.decision, a.outcome, a.approvalId, a.tool]),
    [["approve", "success", "tu1", "bash"]],
  );
});

it("deny sends deny and marks the running turn", async () => {
  const w = new World();
  w.pending();
  const { route, settled } = click({ ...ALLOW, action: "deny" });
  await new ApprovalDecisions(w.deps()).decide(route, "ak-alice");
  assert.equal((w.claw.calls[0] as unknown[])[4], "deny");
  assert.deepEqual(w.denied, ["aad-a|"]);
  assert.equal(w.taken, 0);
  assert.equal(settled[0]?.options?.fallback, "Denied: bash.");
});

it("someone elses approval, a forged card and an unknown action are refused without calling claw", async () => {
  const w = new World();
  w.pending();
  for (const [data, user, lang] of [
    [ALLOW, "aad-b", "en"],
    [{ ...ALLOW, action: "maybe" }, "aad-a", "zh"],
    [{ ...ALLOW, session_id: "s9", tool_use_id: "tu9" }, "aad-a", "en"],
  ] as const) {
    const { route, settled } = click(data, user, "", lang);
    await new ApprovalDecisions(w.deps()).decide(route, "ak-x");
    assert.equal(
      settled[0]?.card,
      lang === "zh" ? "这个审批请求已经失效了。" : "That approval request is no longer active.",
    );
  }
  assert.deepEqual(w.claw.calls, []);
});

it("an in chat card with no record is answered in the persons own session only", async () => {
  const w = new World();
  w.sessions.set("aad-a|", "s1");
  const { route } = click(ALLOW);
  await new ApprovalDecisions(w.deps()).decide(route, "ak-alice");
  assert.equal(w.claw.calls.length, 1);
  assert.deepEqual(
    w.audits.map((a) => [a.approvalId, a.tool]),
    [[null, null]],
  );
});

it("an answered or expired approval is not sent again", async () => {
  const w = new World();
  w.pending("bash", { state: "decided" });
  const first = click(ALLOW);
  await new ApprovalDecisions(w.deps()).decide(first.route, "ak-alice");
  assert.equal(first.settled[0]?.card, "That approval was already answered or has run out.");
  w.pending();
  w.now = NOW + 600;
  const second = click(ALLOW);
  await new ApprovalDecisions(w.deps()).decide(second.route, "ak-alice");
  assert.equal(view(second.settled[0] as Settled), "approvalExpired");
  assert.equal(w.approvals.get("s1/tu1")?.state, "expired");
  assert.deepEqual(w.claw.calls, []);
});

it("a click just before the deadline is accepted", async () => {
  const w = new World();
  w.pending();
  w.now = NOW + 599;
  const { route } = click(ALLOW);
  await new ApprovalDecisions(w.deps()).decide(route, "ak-alice");
  assert.equal(w.claw.calls.length, 1);
});

it("double tap calls claw once", async () => {
  const w = new World();
  w.pending();
  const deps = w.deps();
  const decisions = new ApprovalDecisions(deps);
  const first = click(ALLOW);
  await decisions.decide(first.route, "ak-alice");
  const again = click(ALLOW);
  await decisions.decide(again.route, "ak-alice");
  assert.equal(again.settled[0]?.card, "That approval was already answered or has run out.");
  w.pending();
  deps.store.approvals.closeApproval = () => false; // (the other press of a double tap claimed it first)
  const raced = click(ALLOW);
  await decisions.decide(raced.route, "ak-alice");
  assert.equal(raced.settled[0]?.card, "That approval was already answered or has run out.");
  assert.equal(w.claw.calls.length, 1);
  assert.equal(w.givenBack, 1);
});

it("claw saying the approval is gone turns the card into expired", async () => {
  for (const status of [404, 409, 410]) {
    const w = new World();
    w.pending();
    w.claw.fail = new ClawError(status);
    const { route, settled } = click(ALLOW);
    await new ApprovalDecisions(w.deps()).decide(route, "ak-alice");
    assert.equal(view(settled[0] as Settled), "approvalExpired");
    assert.equal(w.approvals.get("s1/tu1")?.state, "expired");
    assert.equal(w.audits[0]?.outcome, "expired");
    assert.equal(w.givenBack, 1);
  }
});

it("a transient claw error or no answer leaves the approval answerable", async () => {
  for (const [fail, text] of [
    [new ClawError(503), "PrimusClaw did not accept the decision (error 503). Press a button again in a moment."],
    [
      new ClawUnreachable("network", "decide"),
      "I could not reach PrimusClaw. Please press the button again in a moment.",
    ],
  ] as const) {
    const w = new World();
    w.pending();
    w.claw.fail = fail;
    const { route, settled } = click(ALLOW);
    await new ApprovalDecisions(w.deps()).decide(route, "ak-alice");
    assert.equal(w.approvals.get("s1/tu1")?.state, "pending");
    assert.equal(view(settled[0] as Settled), "approvalAgain");
    assert.equal(settled[0]?.options?.fallback, text);
    assert.equal(w.audits[0]?.outcome, "failure");
  }
});

it("a bug in the claw client is not swallowed", async () => {
  const w = new World();
  w.pending();
  w.claw.fail = new RangeError("bug");
  const { route } = click(ALLOW);
  await assert.rejects(new ApprovalDecisions(w.deps()).decide(route, "ak-alice"), RangeError);
});

it("an approval over the persons allowance is put back and claw is not called", async () => {
  const w = new World();
  w.pending();
  w.refuse = "You have approved many actions in a short time.";
  const { route, settled } = click(ALLOW);
  await new ApprovalDecisions(w.deps()).decide(route, "ak-alice");
  assert.equal(settled[0]?.options?.fallback, w.refuse);
  assert.deepEqual(w.claw.calls, []);
});

it("no linked key says the chat is not connected", async () => {
  const w = new World();
  w.pending();
  const { route, settled } = click(ALLOW, "aad-a", "", "zh");
  await new ApprovalDecisions(w.deps()).decide(route, null);
  const said = settled[0]?.card;
  assert.ok(typeof said === "string" && said.startsWith("这个聊天还没有连上"));
  assert.equal(w.givenBack, 1);
});

it("an acting session answers with the exchanged token and never the linked key", async () => {
  const w = new World();
  w.pending();
  w.acting.add("s1");
  const { route } = click(ALLOW);
  await new ApprovalDecisions(w.deps()).decide(route, "ak-alice");
  assert.deepEqual(w.claw.calls, [["decide", "idt-token", "s1", "tu1", "allow", { acting: true }]]);
});

it("an acting session without a binding puts the card back and offers to connect", async () => {
  const w = new World();
  w.pending();
  w.acting.add("s1");
  w.token = err({ kind: "not_bound" });
  const { route, settled } = click(ALLOW);
  await new ApprovalDecisions(w.deps()).decide(route, "ak-alice");
  assert.equal(view(settled[0] as Settled), "approvalAgain");
  assert.equal(w.connected, 1);
  assert.equal(w.approvals.get("s1/tu1")?.state, "pending");
  const group = click(ALLOW, "aad-a", "19:g");
  await new ApprovalDecisions(w.deps()).decide(group.route, "ak-alice");
  assert.equal(w.connected, 1);
  w.token = err({ kind: "exchange_failed", reason: "503" });
  const down = click(ALLOW);
  await new ApprovalDecisions(w.deps()).decide(down.route, "ak-alice");
  assert.ok(down.settled[0]?.options?.fallback?.startsWith("I could not reach the Primus platform"));
  w.exchangeOn = false;
  const off = click(ALLOW);
  await new ApprovalDecisions(w.deps()).decide(off.route, "ak-alice");
  assert.ok(off.settled[0]?.options?.fallback?.startsWith("This chat is not connected"));
  assert.deepEqual(w.claw.calls, []);
});

it("an acting session refusal names claws reason", async () => {
  const w = new World();
  w.pending();
  w.acting.add("s1");
  w.claw.fail = new ClawError(403, '{"error":"service_client_not_allowed"}');
  const { route, settled } = click(ALLOW);
  await new ApprovalDecisions(w.deps()).decide(route, "ak-alice");
  assert.ok(settled[0]?.options?.fallback?.startsWith("PrimusClaw does not take answers from me yet"));
  assert.ok(settled[0]?.options?.fallback?.endsWith("Your answer was not sent."));
});

it("a question is answered with the chosen labels and an empty answer puts the card back", async () => {
  const w = new World();
  w.pending("ask_user_question");
  const empty = click({ ...ANSWER, choice_0: "" });
  await new ApprovalDecisions(w.deps()).decide(empty.route, "ak-alice");
  assert.equal(view(empty.settled[0] as Settled), "question");
  assert.deepEqual(w.claw.calls, []);
  const { route, settled } = click(ANSWER);
  await new ApprovalDecisions(w.deps()).decide(route, "ak-alice");
  assert.deepEqual(w.claw.calls, [["answer", "ak-alice", "s1", "tu1", { q1: "A" }, [], {}]]);
  assert.equal(view(settled[0] as Settled), "questionAnswered");
  assert.equal(settled[0]?.options?.fallback, "Answered. The agent goes on with it.");
  assert.deepEqual(w.audits, []);
});

it("a question card cannot answer an approval and an expired question says the agent stopped waiting", async () => {
  const w = new World();
  w.pending("bash");
  const wrong = click(ANSWER);
  await new ApprovalDecisions(w.deps()).decide(wrong.route, "ak-alice");
  assert.equal(wrong.settled[0]?.card, "That question is no longer open.");
  w.pending("ask_user_question");
  w.claw.fail = new ClawError(404);
  const gone = click(ANSWER);
  await new ApprovalDecisions(w.deps()).decide(gone.route, "ak-alice");
  assert.equal(gone.settled[0]?.options?.fallback, "The agent stopped waiting for that answer.");
  w.claw.fail = new ClawError(500);
  w.pending("ask_user_question");
  const failed = click(ANSWER);
  await new ApprovalDecisions(w.deps()).decide(failed.route, "ak-alice");
  assert.ok(failed.settled[0]?.options?.fallback?.startsWith("PrimusClaw did not accept the answer (error 500)"));
});
