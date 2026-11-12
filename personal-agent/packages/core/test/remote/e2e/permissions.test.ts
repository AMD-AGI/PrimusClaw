// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A remote agent asks for permission: the card, and what a click does. The buttons are the options the adapter offered, with its
// own ids, and a click is checked against what the agent stored when it showed the card (the owner, the options, when it runs
// out), never against the card itself.
import assert from "node:assert/strict";
import { test } from "node:test";

import { advanceSeconds } from "../../../../../test-support/store.js";
import {
  CLAUDE_OPTIONS,
  CODEX_OPTIONS,
  CURSOR_OPTIONS,
  type FakeCommand,
  type FakeRemote,
  type PermissionOption,
} from "../../../../../test-support/remote-fake.js";
import { ALICE, type RemoteWorld, Script, USER_B, remoteWorld } from "../../../../../test-support/remote-world.js";
import { AAD, en } from "./helpers.js";
import { own } from "../../../src/own.js";

type Json = Record<string, unknown>;
const APPROVAL_ANSWERED = en.approvalAnswered;
const APPROVAL_INACTIVE = en.approvalInactive;
const ADAPTERS = [
  ["Claude", CLAUDE_OPTIONS, "claude"],
  ["Codex", CODEX_OPTIONS, "codex"],
  ["Cursor", CURSOR_OPTIONS, "cursor"],
] as const;

/** An agent that edits a file after asking, and says how the answer went. */
class AskingAgent extends Script {
  constructor(
    readonly offered: readonly PermissionOption[],
    readonly actionId = "act-1",
    readonly timeoutMs: unknown = 600_000,
  ) {
    super();
    this.onPrompt = (srv, sid) => this.ask(srv, sid);
    this.onDecision = (srv, sid, cmd) => this.decided(srv, sid, cmd);
  }

  async ask(srv: FakeRemote, sid: string): Promise<void> {
    await srv.say(sid, "I will add the line. ");
    await srv.tool(sid, "t1", "Edit README.md", "pending", "edit");
    await srv.emit(sid, "permissionRequest", {
      actionId: this.actionId,
      tool: "Edit README.md",
      kind: "edit",
      input: { path: "README.md" },
      options: this.offered,
      ...(this.timeoutMs === null ? {} : { timeout_ms: this.timeoutMs }),
    });
  }

  async decided(srv: FakeRemote, sid: string, cmd: FakeCommand): Promise<void> {
    const option = String(cmd.body["option_id"]);
    const kind = this.offered.find((o) => o.optionId === option)?.kind ?? "";
    await srv.emit(sid, "permission_resolved", { actionId: cmd.body["action_id"], optionId: option, by: cmd.user });
    const allowed = kind.startsWith("allow");
    await srv.tool(sid, "t1", "Edit README.md", allowed ? "completed" : "failed", "edit");
    await srv.say(sid, allowed ? "The README now has the line." : "You declined, so I changed nothing.");
    await srv.end(sid);
  }
}

/** A world where the agent has just asked for permission and the card is on screen. */
async function asked(
  w: RemoteWorld,
  options: readonly PermissionOption[],
  agent = "codex",
  actionId = "act-1",
  timeoutMs: unknown = 600_000,
) {
  w.server.addConnector(ALICE, "dev-pod", [[agent, agent, agent.charAt(0).toUpperCase() + agent.slice(1)]]);
  const script = new AskingAgent(options, actionId, timeoutMs);
  w.server.onCommand = script.hook;
  await w.say(`/agent new ${agent} /home/me/repo`);
  const sid = w.test.store.remoteState.attachedRemote(AAD)?.sessionId ?? "";
  await w.send("add a line to the README");
  await w.until(() => w.permissionCards().length > 0);
  const card = w.permissionCards()[0] ?? {};
  return { script, sid, card };
}

const actionsOf = (card: Json): Json[] => (card["actions"] ?? []) as Json[];
const dataOf = (action: Json | undefined): Json => (action?.["data"] ?? {}) as Json;
const button = (card: Json, optionId: string): Json =>
  dataOf(actionsOf(card).find((a) => dataOf(a)["option_id"] === optionId));
const perm = (w: RemoteWorld, sid: string) => w.test.store.remotePermissions.getRemotePermission(sid, "act-1");

/** Every text of a card in reading order, a fact as `name: value` (the header's bar left out). */
function textsOf(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(textsOf);
  if (typeof node !== "object" || node === null) return [];
  const n = node as Json;
  const out: string[] = [];
  if (n["type"] === "TextBlock" && n["text"] !== "┃") out.push(String(n["text"]));
  else if (n["type"] === "FactSet") {
    for (const fact of (n["facts"] ?? []) as Json[]) {
      const name = String(fact["title"]).replaceAll("⁠", "");
      out.push(`${name}${/[一-鿿]/u.test(name) ? "：" : ": "}${String(fact["value"])}`);
    }
  }
  for (const key of ["items", "columns"]) out.push(...textsOf(own(n, key) ?? []));
  return out;
}

test("each option the adapter offered can be chosen and its own id is what claw receives", async () => {
  for (const [name, options, agent] of ADAPTERS) {
    for (const option of options) {
      await remoteWorld(async (w) => {
        const { sid, card } = await asked(w, options, agent);
        assert.deepEqual(
          actionsOf(card).map((a) => dataOf(a)["option_id"]),
          options.map((o) => o.optionId),
        );
        await w.click(button(card, option.optionId));
        await w.idle();
        const decisions = w.server.commandsOf("decision");
        assert.equal(decisions.length, 1);
        assert.deepEqual(
          decisions[0]?.body,
          { action_id: "act-1", option_id: option.optionId },
          `${name} ${option.optionId}`,
        );
        assert.equal(decisions[0].user, ALICE);
        const expected = option.kind.startsWith("allow")
          ? "The README now has the line."
          : "You declined, so I changed nothing.";
        assert.equal(w.answer(), expected, `${name} ${option.optionId}`);
        assert.equal(perm(w, sid)?.state, "decided");
      });
    }
  }
});

test("the click replaces the card with what was chosen and by whom", () =>
  remoteWorld(async (w) => {
    const { card } = await asked(w, CLAUDE_OPTIONS, "claude");
    await w.click(button(card, "allow-once"));
    const updates = w.surface.outbox.filter((r) => r.op === "update" && r.id === "card-1");
    assert.equal(updates.length, 1);
    const content = w.renderedCards(updates)[0] ?? {};
    assert.ok(textsOf(content["body"])[0]?.startsWith("✅ Allowed once (you, "), JSON.stringify(content));
    assert.ok(!("actions" in content));
  }));

test("the card names whose agent asks and what it wants to do", () =>
  remoteWorld(async (w) => {
    const { card } = await asked(w, CODEX_OPTIONS);
    const texts = textsOf(card["body"]);
    assert.deepEqual(texts.slice(0, 4), [
      "⚠️ Approval needed",
      "⬛ Codex on dev-pod asks permission (edit).",
      "Action: Edit README.md",
      "path: README.md",
    ]);
    assert.ok(texts.some((t) => t.includes("changes what this agent may do on your machine"))); // the always option is explained
  }));

test("a double click sends one decision and the second is told it was answered", () =>
  remoteWorld(async (w) => {
    const { card } = await asked(w, CODEX_OPTIONS);
    const data = button(card, "allow_once");
    await Promise.all([w.click(data), w.click(data)]);
    assert.equal(w.server.commandsOf("decision").length, 1);
    const texts = w
      .said()
      .filter((t) => t === APPROVAL_ANSWERED || t.startsWith("Allowed once") || t.startsWith("✅ Allowed once"));
    // each click is an edit of its card and a line in a new message: the winner's card says "Allowed once (you, ...)" and its line
    // "Allowed once: Edit README.md.", the loser's both say it was answered
    const card1 = texts.find((t) => t.startsWith("✅ Allowed once ("));
    assert.deepEqual(
      [...texts].sort(),
      [APPROVAL_ANSWERED, APPROVAL_ANSWERED, card1, "Allowed once: Edit README.md."].sort(),
    );
  }));

test("a click that loses the race to close the request sends nothing", () =>
  remoteWorld(async (w) => {
    const { card } = await asked(w, CODEX_OPTIONS);
    const repo = w.test.store.remotePermissions;
    const real = repo.closeRemotePermission.bind(repo);
    const patched = repo as { closeRemotePermission: typeof real };
    patched.closeRemotePermission = (sid, action, state, options) =>
      state === "sending" ? false : real(sid, action, state, options);
    await w.click(button(card, "allow_once"));
    assert.equal(w.last(), APPROVAL_ANSWERED);
    assert.equal(w.server.commandsOf("decision").length, 0);
    patched.closeRemotePermission = real;
    await w.click(button(card, "allow_once")); // the click that won it has not sent anything yet: this one still can
    assert.equal(w.server.commandsOf("decision").length, 1);
  }));

test("a second click after the first finished is told it was answered", () =>
  remoteWorld(async (w) => {
    const { card } = await asked(w, CODEX_OPTIONS);
    await w.click(button(card, "allow_once"));
    await w.idle();
    const before = w.said().length;
    await w.click(button(card, "cancel")); // a different second choice does not get through either
    assert.equal(w.server.commandsOf("decision").length, 1);
    assert.deepEqual(w.said().slice(before), [APPROVAL_ANSWERED, APPROVAL_ANSWERED]); // (the edit, the line)
  }));

test("someone elses click does nothing and does not use their key for it", () =>
  remoteWorld(async (w) => {
    const { sid, card } = await asked(w, CODEX_OPTIONS);
    w.server.calls.length = 0;
    await w.click(button(card, "allow_once"), USER_B);
    assert.equal(w.last(), APPROVAL_INACTIVE);
    assert.equal(w.server.commandsOf("decision").length, 0);
    assert.equal(w.server.calls.filter(([, p]) => p.includes("decisions")).length, 0);
    assert.equal(perm(w, sid)?.state, "pending"); // the owner can still answer
    await w.click(button(card, "allow_once"));
    assert.equal(w.server.commandsOf("decision").length, 1);
  }));

test("a card edited to carry an option the agent never offered is refused here", () =>
  remoteWorld(async (w) => {
    const { card } = await asked(w, CODEX_OPTIONS);
    await w.click({ ...button(card, "allow_once"), option_id: "accept_everything_forever" });
    assert.equal(w.last(), APPROVAL_INACTIVE);
    assert.equal(w.server.commandsOf("decision").length, 0);
    assert.equal(w.server.calls.filter(([, p]) => p.includes("decisions")).length, 0); // it never even reached Claw
  }));

test("a click on nothing this worker showed is not active", async () => {
  for (const [label, data] of [
    ["an action id that was never asked", { action_id: "act-404" }],
    ["a session that is not this one's", { session_id: "00000000-0000-0000-0000-000000000000" }],
    ["no ids at all", { session_id: "", action_id: "", option_id: "" }],
  ] as const) {
    await remoteWorld(async (w) => {
      const { card } = await asked(w, CODEX_OPTIONS);
      await w.click({ ...button(card, "allow_once"), ...data });
      assert.equal(w.last(), APPROVAL_INACTIVE, label);
      assert.equal(w.server.commandsOf("decision").length, 0, label);
    });
  }
});

test("a request that ran out is refused whatever the button says", () =>
  remoteWorld(async (w) => {
    const { sid, card } = await asked(w, CODEX_OPTIONS, "codex", "act-1", 30_000);
    advanceSeconds(w.test.clock, 31);
    await w.click(button(card, "allow_once"));
    assert.ok(w.last().includes("run out and was refused"), w.last()); // (the line; the card says it in its own words)
    assert.equal(w.server.commandsOf("decision").length, 0);
    assert.equal(perm(w, sid)?.state, "expired");
    await w.click(button(card, "allow_once")); // and stays refused
    assert.equal(w.last(), APPROVAL_ANSWERED);
    assert.equal(w.server.commandsOf("decision").length, 0);
  }));

test("how long a request lives follows what the agent said within sense", async () => {
  for (const [timeoutMs, lives] of [
    [null, 600],
    [0, 600],
    [-5, 600],
    ["soon", 600],
    [true, 600],
    [99_999_999_999, 600],
    [45_000, 45],
    [3_600_000, 3600],
  ] as const) {
    await remoteWorld(async (w) => {
      const { sid } = await asked(w, CODEX_OPTIONS, "codex", "act-1", timeoutMs);
      const expires = perm(w, sid)?.expiresAt ?? 0;
      assert.ok(
        Math.abs(expires - w.test.clock.epochMs() / 1000 - lives) <= 1,
        `${String(timeoutMs)}: ${String(expires)}`,
      );
    });
  }
});

test("a refusal from claw brings the card back and a second press goes through", () =>
  remoteWorld(async (w) => {
    const { sid, card } = await asked(w, CLAUDE_OPTIONS, "claude");
    w.server.failOn("POST", "/decisions", 500);
    await w.click(button(card, "allow-once"));
    assert.ok(w.last().includes("did not accept the answer (error 500)"), w.last());
    const restored = w.cards().at(-1) ?? {};
    assert.deepEqual(
      actionsOf(restored).map((a) => dataOf(a)["option_id"]),
      ["allow-once", "allow-with-updates", "reject"],
    );
    assert.equal(perm(w, sid)?.state, "pending");
    assert.equal(w.server.commandsOf("decision").length, 0);
    w.server.fail.clear();
    await w.click(button(restored, "allow-once"));
    assert.equal(w.server.commandsOf("decision").length, 1);
    assert.equal(perm(w, sid)?.state, "decided");
  }));

test("a request claw no longer holds is told as answered or ran out", async () => {
  for (const status of [404, 409]) {
    await remoteWorld(async (w) => {
      const { sid, card } = await asked(w, CODEX_OPTIONS);
      w.server.failOn("POST", "/decisions", status);
      await w.click(button(card, "allow_once"));
      assert.equal(w.last(), APPROVAL_ANSWERED);
      assert.equal(perm(w, sid)?.state, "expired");
    });
  }
});

test("a request answered somewhere else closes the card here", () =>
  remoteWorld(async (w) => {
    const { sid, card } = await asked(w, CODEX_OPTIONS);
    await w.server.emit(sid, "permission_resolved", { actionId: "act-1", optionId: "allow_once", by: ALICE });
    await w.until(() => perm(w, sid)?.state === "decided");
    await w.click(button(card, "allow_once"));
    assert.equal(w.last(), APPROVAL_ANSWERED);
    assert.equal(w.server.commandsOf("decision").length, 0);
    await w.server.end(sid);
    await w.idle();
  }));

test("a request the connector sends again after a reconnect gets one card", () =>
  remoteWorld(async (w) => {
    const { sid } = await asked(w, CODEX_OPTIONS);
    await w.server.ask(sid, "act-1", "Edit README.md", CODEX_OPTIONS, { input: { path: "README.md" } });
    await w.server.ask(sid, "act-1", "Edit README.md", CODEX_OPTIONS, { input: { path: "README.md" } });
    await w.server.ask(sid, "act-2", "Run the tests", CODEX_OPTIONS, {
      kind: "execute",
      input: { command: "npm test" },
    });
    await w.until(() => w.permissionCards().length === 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(
      w.permissionCards().map((c) => dataOf(actionsOf(c)[0])["action_id"]),
      ["act-1", "act-2"],
    );
    await w.server.end(sid);
    await w.idle();
  }));

test("a request that cannot be answered says so instead of showing dead buttons", async () => {
  for (const [label, request] of [
    ["no options", { actionId: "a", tool: "x", options: [] }],
    ["options without ids", { actionId: "a", tool: "x", options: [{ name: "Yes", kind: "allow_once" }] }],
    ["no action id", { tool: "x", options: CODEX_OPTIONS }],
  ] as const) {
    await remoteWorld(async (w) => {
      w.server.addConnector(ALICE, "dev-pod", [["codex", "codex", "Codex"]]);
      const script = new Script();
      script.onPrompt = async (srv, sid) => {
        await srv.emit(sid, "permissionRequest", request);
        await srv.end(sid);
      };
      w.server.onCommand = script.hook;
      await w.say("/agent new codex /repo");
      await w.say("go");
      assert.equal(w.permissionCards().length, 0, label);
      assert.ok(
        w.said().some((t) => t.includes("offered no answer I can pass on")),
        label,
      );
    });
  }
});

test("a card that could not be sent can be shown when the connector asks again", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "dev-pod", [["codex", "codex", "Codex"]]);
    w.server.onCommand = new AskingAgent(CODEX_OPTIONS).hook;
    await w.say("/agent new codex /repo");
    const sid = w.test.store.remoteState.attachedRemote(AAD)?.sessionId ?? "";
    let failures = 0;
    w.refuse = (message) => {
      if (failures > 0 || message.body.type !== "view" || message.body.view.name !== "remotePermission") return false;
      failures += 1; // (the permission card, not the status card)
      return true;
    };
    await w.say("go");
    assert.ok(failures > 0);
    assert.equal(perm(w, sid), null); // nothing is kept for a card nobody saw
    w.refuse = null;
    await w.send("again"); // (the turn above ended with an error message; a new prompt can start)
    await w.server.ask(sid, "act-1", "Edit README.md", CODEX_OPTIONS);
    await w.until(() => w.permissionCards().length > 0);
    await w.server.end(sid);
    await w.idle();
  }));

test("a card is not held back by quiet hours because the user just asked for the work", () =>
  remoteWorld(async (w) => {
    w.test.store.prefs.setPausedUntil(AAD, w.test.clock.epochMs() / 1000 + 10_000);
    const { card } = await asked(w, CODEX_OPTIONS);
    assert.ok(actionsOf(card).length > 0);
    assert.deepEqual(w.test.store.held.usersWithHeld(), []);
    await w.click(button(card, "cancel"));
    await w.idle();
    assert.equal(w.answer(), "You declined, so I changed nothing.");
  }));

test("the stored row has what the click is checked against", () =>
  remoteWorld(async (w) => {
    const { sid } = await asked(w, CLAUDE_OPTIONS, "claude");
    const row = perm(w, sid);
    assert.ok(row);
    assert.deepEqual([row.userId, row.tool, row.state], [AAD, "Edit README.md", "pending"]);
    const options = row.options as Json[];
    assert.deepEqual(
      options.map((o) => o["optionId"]),
      ["allow-once", "allow-with-updates", "reject"],
    );
    assert.deepEqual(
      options.map((o) => o["kind"]),
      ["allow_once", "allow_always", "reject_once"],
    );
    assert.ok(Math.abs(row.expiresAt - (w.test.clock.epochMs() / 1000 + 600)) <= 1);
  }));

// --- found by review (#636 r1): a request whose card cannot be built is forgotten, so the connector's next resend shows it ------

test("a request whose card cannot be built is forgotten and its resend gets the card", () =>
  remoteWorld(async (w) => {
    const views = (w.remote as unknown as { ctx: { views: { permission: (...args: unknown[]) => unknown } } }).ctx
      .views;
    const real = views.permission;
    let tries = 0;
    views.permission = (...args: unknown[]) => {
      tries += 1;
      if (tries === 1) throw new RangeError("Maximum call stack size exceeded"); // (what a request nested too deep does)
      return real(...args);
    };
    w.server.addConnector(ALICE, "dev-pod", [["codex", "codex", "Codex"]]);
    w.server.onCommand = new AskingAgent(CODEX_OPTIONS).hook;
    await w.say("/agent new codex /home/me/repo");
    const sid = w.test.store.remoteState.attachedRemote(AAD)?.sessionId ?? "";
    await w.send("add a line to the README");
    await w.until(() => tries === 1);
    await w.until(() => perm(w, sid) === null); // forgotten, not left as shown
    assert.equal(w.permissionCards().length, 0);
    await w.server.ask(sid, "act-1", "Edit README.md", CODEX_OPTIONS, { input: { path: "README.md" } }); // the connector resends
    await w.until(() => w.permissionCards().length > 0);
    assert.equal(w.permissionCards().length, 1);
  }));

/** The request on screen made a terminal's question (a connector's approval hooks): its row keeps the whole ask. */
function asTerminalQuestion(w: RemoteWorld, sid: string, whole = true, lang?: "zh" | "en"): void {
  const row = perm(w, sid);
  assert.ok(row !== null);
  w.test.store.remotePermissions.forgetRemotePermission(sid, "act-1");
  w.test.store.remotePermissions.saveRemotePermission({
    userId: row.userId,
    sessionId: sid,
    actionId: "act-1",
    tool: row.tool,
    options: row.options,
    expiresAt: row.expiresAt,
    ...(lang ? { lang } : {}),
    ask: {
      action_id: "act-1",
      origin: "terminal",
      kind: "edit",
      input: { file_path: "README.md" },
      ...(whole ? { clawy_shown_whole: true } : {}),
    },
  });
}

test("a terminal's question Claw says is answered was answered at the terminal, and a click after that is told so", async () => {
  await remoteWorld(async (w) => {
    const { sid, card } = await asked(w, CODEX_OPTIONS);
    asTerminalQuestion(w, sid);
    w.server.failOn("POST", "/decisions", 409);
    await w.click(button(card, "allow_once"));
    assert.equal(w.last(), "This request was answered in the terminal.");
    assert.equal(perm(w, sid)?.state, "expired");
  });
  await remoteWorld(async (w) => {
    const { sid, card } = await asked(w, CODEX_OPTIONS);
    asTerminalQuestion(w, sid);
    w.test.store.remotePermissions.closeRemotePermission(sid, "act-1", "terminal");
    await w.click(button(card, "allow_once"));
    assert.equal(w.last(), "This request was answered in the terminal.");
    assert.equal(w.server.commandsOf("decision").length, 0);
  });
});

test("a click on a terminal's card is answered in the language the card was shown in, not the person's unset one", async () => {
  // (Claw's push drew the card in Chinese from its own words; the person never chose a language, so theirs reads as English)
  await remoteWorld(async (w) => {
    const { sid, card } = await asked(w, CODEX_OPTIONS);
    asTerminalQuestion(w, sid, true, "zh");
    w.test.store.remotePermissions.closeRemotePermission(sid, "act-1", "terminal");
    await w.click(button(card, "allow_once"));
    assert.equal(w.last(), "这个请求已在终端里回答。");
  });
  await remoteWorld(async (w) => {
    const { sid, card } = await asked(w, CODEX_OPTIONS);
    asTerminalQuestion(w, sid, true, "zh");
    w.server.failOn("POST", "/decisions", 409);
    await w.click(button(card, "allow_once"));
    assert.equal(w.last(), "这个请求已在终端里回答。");
  });
  await remoteWorld(async (w) => {
    const { sid, card } = await asked(w, CODEX_OPTIONS);
    asTerminalQuestion(w, sid, true, "zh");
    w.test.store.remotePermissions.closeRemotePermission(sid, "act-1", "decided");
    await w.click(button(card, "allow_once"));
    assert.equal(w.last(), "这个审批已经答复过，或者已经过期了。");
  });
});

test("a terminal's question its card did not show whole is never approved here, and a failed click brings back only the turn-down options", () =>
  remoteWorld(async (w) => {
    const { sid, card } = await asked(w, CLAUDE_OPTIONS, "claude");
    asTerminalQuestion(w, sid, false);
    // An allow button (an older card, or one built by hand) is refused here, and nothing reaches Claw.
    await w.click(button(card, "allow-once"));
    assert.equal(w.last(), APPROVAL_INACTIVE);
    assert.equal(w.server.calls.filter(([, p]) => p.includes("decisions")).length, 0);
    // A turn-down that does not go through comes back with turn-down options only.
    w.server.failOn("POST", "/decisions", 500);
    await w.click(button(card, "reject"));
    const restored = w.cards().at(-1) ?? {};
    assert.deepEqual(
      actionsOf(restored).map((a) => dataOf(a)["option_id"]),
      ["reject"],
    );
    assert.equal(perm(w, sid)?.state, "pending");
  }));

test("a terminal's question shown whole still loses its allow options when a failed click brings the card back without its content", () =>
  remoteWorld(async (w) => {
    const { sid, card } = await asked(w, CLAUDE_OPTIONS, "claude");
    asTerminalQuestion(w, sid);
    w.server.failOn("POST", "/decisions", 500);
    await w.click(button(card, "allow-once"));
    const restored = w.cards().at(-1) ?? {};
    assert.deepEqual(
      actionsOf(restored).map((a) => dataOf(a)["option_id"]),
      ["reject"],
    );
  }));

test("the terminal answers while a click is on its way and the click fails: the card says so instead of coming back", () =>
  remoteWorld(async (w) => {
    const { sid, card } = await asked(w, CLAUDE_OPTIONS, "claude");
    asTerminalQuestion(w, sid);
    const perms = w.test.store.remotePermissions;
    const close = perms.closeRemotePermission.bind(perms);
    // (the resolved notice lands just after the click took the request: as the proactive side records it)
    perms.closeRemotePermission = (s, a, state, options) => {
      const done = close(s, a, state, options);
      if (done && state === "sending") close(s, a, "terminal", { onlyIfState: "sending" });
      return done;
    };
    w.server.failOn("POST", "/decisions", 500);
    const before = w.permissionCards().length;
    await w.click(button(card, "allow-once"));
    assert.equal(w.last(), "This request was answered in the terminal.");
    assert.equal(w.permissionCards().length, before);
    assert.equal(perm(w, sid)?.state, "terminal");
  }));

test("a chat attached to the session that carries a terminal's questions draws no card for them", () =>
  remoteWorld(async (w) => {
    const { sid } = await asked(w, CLAUDE_OPTIONS, "claude");
    const cards = w.permissionCards().length;
    await w.server.emit(sid, "permissionRequest", {
      actionId: "act-term",
      tool: "Run: ls",
      kind: "execute",
      input: { command: "ls" },
      options: CLAUDE_OPTIONS,
      origin: "terminal_hook",
    });
    // (as Claw's push names the same origin: not drawn either)
    await w.server.emit(sid, "permissionRequest", {
      actionId: "act-term2",
      tool: "Run: ls",
      kind: "execute",
      input: { command: "ls" },
      options: CLAUDE_OPTIONS,
      origin: "terminal",
    });
    // (a second request of the same session is shown: the one before it has been read)
    await w.server.emit(sid, "permissionRequest", {
      actionId: "act-after",
      tool: "Edit b.md",
      kind: "edit",
      input: { path: "b.md" },
      options: CLAUDE_OPTIONS,
    });
    await w.until(() => w.permissionCards().length === cards + 1);
    assert.ok(!JSON.stringify(w.permissionCards()).includes("act-term"));
    assert.equal(w.test.store.remotePermissions.getRemotePermission(sid, "act-term"), null);
    assert.ok(!JSON.stringify(w.permissionCards()).includes("act-term2"));
    assert.equal(w.test.store.remotePermissions.getRemotePermission(sid, "act-term2"), null);
  }));
