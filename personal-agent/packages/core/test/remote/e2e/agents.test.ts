// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Remote agents from the chat: the commands, where a message goes, the live view and the answer. Every test runs the remote
// agents and the real Claw client against the fake remote-agents server over real HTTP and SSE.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { ClawError } from "../../../src/claw/errors.js";
import { failureText, idempotencyKey } from "../../../src/remote/refusals.js";
import { RECONNECT_RETRY_SECONDS } from "../../../src/remote/sessions.js";
import { type FakeCommand, type FakeRemote } from "../../../../../test-support/remote-fake.js";
import { ALICE, Script, remoteWorld } from "../../../../../test-support/remote-world.js";
import { AAD, BOB, TWO_AGENTS, attached, en, oneTurn, seen } from "./helpers.js";

const OFFLINE = en.offline;
const OUTDATED = en.outdated;
const NOT_ENABLED = en.notEnabled;
const STILL_WORKING = en.stillWorking;

const errors = {
  looksInternal: () => false,
  withhold: () => "0123abcd",
};
const said = (status: number, body: string): string =>
  failureText(new ClawError(status, body), errors, Date.now() / 1000);

// --- off by default, and off on Claw ------------------------------------------------------------------------------------

test("with the flag off the commands say so and nothing is called", () =>
  remoteWorld(
    async (w) => {
      for (const text of ["/agents", "/agent new codex /repo", "/agent sessions", "/agent detach", "/agent"]) {
        await w.say(text);
        assert.equal(w.last(), NOT_ENABLED, text);
      }
      assert.deepEqual(w.server.calls, []);
    },
    { enabled: false },
  ));

test("a claw without remote agents is told apart from a missing session", () =>
  remoteWorld(async (w) => {
    w.server.enabled = false; // every remote-agents route is 404, as on a Claw with the capability off
    for (const text of ["/agents", "/agent new codex /repo", "/agent sessions", "/agent attach 1", "/agent off"]) {
      await w.say(text);
      assert.equal(w.last(), NOT_ENABLED, text);
    }
  }));

// --- /agents ------------------------------------------------------------------------------------------------------------

test("agents lists my machines and nobody elses", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS);
    w.server.addConnector(ALICE, "laptop", [["cursor", "cursor", "Cursor"]], { online: false });
    w.server.addConnector(BOB, "bobs-box", [["codex", "codex", "Codex"]]);
    await w.say("/agents");
    const text = w.last();
    assert.ok(text.includes("**dev-pod** (online)") && text.includes("**laptop** (offline)"), text); // (a card says it in words)
    assert.ok(
      text.includes("Codex") &&
        text.includes("Claude Code") &&
        text.includes("Cursor (offline)") &&
        !text.includes("bobs-box"),
    );
    assert.deepEqual(new Set(w.server.keysSeen), new Set(["ak-alice"]));
    assert.deepEqual(new Set(w.server.clientLabels), new Set(["clawy"])); // Claw's audit trail names this client
  }));

test("agents with no machine says how to connect one", () =>
  remoteWorld(async (w) => {
    // A Claw from before GET .../setup: the commands are made from the address the agent reaches Claw at.
    await w.say("/agents");
    const login = `claw-connector login --server ${w.server.url} --identity-url ${w.server.url}`;
    assert.ok(
      w
        .last()
        .includes(
          `<pre>npm install -g @primusclaw/connector<br>claw-connector init<br>${login}<br>claw-connector service install</pre>`,
        ),
      w.last(),
    );
    // Claw says what to run here.
    w.server.setup = { server: `${w.server.url}/claw-api`, identity_url: `${w.server.url}/identity` };
    await w.say("/agents");
    assert.ok(
      w
        .last()
        .includes(`claw-connector login --server ${w.server.url}/claw-api --identity-url ${w.server.url}/identity<br>`),
    );
    assert.ok(w.server.calls.some(([m, p, u]) => m === "GET" && p === "/v1/remote-agents/setup" && u === ALICE));
  }));

test("a new session on a connector too old says how to upgrade it", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { version: "0.1.2", versionStatus: "unsupported" });
    await w.say("/agents");
    assert.ok(w.last().includes("Its connector (0.1.2) is too old for a new session."), w.last());
    await w.say("/agent new claude /home/me/repo");
    assert.equal(w.last(), OUTDATED);
    assert.ok(
      OUTDATED.includes(
        "npm install -g @primusclaw/connector@latest && claw-connector stop && claw-connector service install",
      ),
    );
    assert.equal(w.server.commandsOf("session.new").length, 0);
  }));

test("agents with no machine gives the one line that pairs one", () =>
  remoteWorld(async (w) => {
    w.server.pairing = true;
    await w.say("/agents");
    const text = w.last();
    assert.ok(text.includes("You have no machine connected yet."), text);
    // (a rich message: the code block is one a person copies whole)
    assert.ok(
      text.includes(
        `<pre>npm install -g --no-update-notifier @primusclaw/connector@latest &amp;&amp; claw-connector pair ABCD-EFGH-0001 --server ${w.server.url}</pre>`,
      ),
      text,
    );
    assert.ok(text.includes("within 10 minutes") && !text.includes("connector login"));
    assert.deepEqual(w.server.pairings, [ALICE]); // a code of the person who asked, and nobody else's
    // `/agent pair` gives a new one whenever asked, machines or not.
    w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS);
    await w.say("/agent pair");
    assert.ok(w.last().includes("claw-connector pair ABCD-EFGH-0002"));
    assert.deepEqual(w.server.pairings, [ALICE, ALICE]);
  }));

test("pairing a claw cannot give falls back to signing in on the machine", () =>
  remoteWorld(async (w) => {
    w.server.pairing = true;
    w.server.failOn("POST", "/pairings", [503, "pairing_unavailable"]);
    await w.say("/agents");
    assert.ok(w.last().includes("claw-connector login") && !w.last().includes("claw-connector pair"));
    await w.say("/agent pair");
    assert.ok(w.last().includes("claw-connector login") && !w.last().includes("claw-connector pair"));
  }));

test("a pairing answer of an unexpected shape never reaches a shell", () =>
  remoteWorld(async (w) => {
    w.server.pairing = true;
    for (const [code, server] of [
      ["ABCD-EFGH-JKMN; rm -rf ~", null],
      ["ABCD-EFGH-JKMN", "https://evil.example/claw-api"],
      ["ABCD-EFGH-JKMN", `${w.server.url}/x$(id)`],
      ["abcd-efgh-jkmn", null],
    ] as const) {
      w.server.pairAnswer = { code, ...(server ? { server } : {}) };
      await w.say("/agent pair");
      assert.ok(!w.last().includes("claw-connector pair") && w.last().includes("claw-connector login"), code);
    }
  }));

test("a revoked machine is not listed", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "old-box", TWO_AGENTS);
    w.server.connector(cid).revoked = true;
    await w.say("/agents");
    assert.ok(!w.last().includes("old-box") && w.last().includes("You have no machine connected."), w.last());
  }));

// --- /agent usage and /agent new ----------------------------------------------------------------------------------------

test("an unknown subcommand gets the usage and calls nothing", () =>
  remoteWorld(async (w) => {
    for (const text of ["/agent frobnicate", "/agent HELP"]) {
      await w.say(text);
      assert.ok(w.last().includes("`/agent new AGENT PATH`") && w.last().includes("`/agent off`"), text);
    }
    assert.deepEqual(w.server.calls, []);
  }));

test("new starts a session attaches the chat and says when the agent is ready", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS);
    w.server.onCommand = new Script().hook;
    await w.say("/agent new codex /home/me/repo with spaces");
    const [cmd, ...more] = w.server.commandsOf("session.new");
    assert.ok(cmd && more.length === 0);
    assert.equal(cmd.user, ALICE);
    assert.deepEqual(cmd.body, { connector_id: cid, agent_id: "codex", cwd: "/home/me/repo with spaces" });
    const state = w.test.store.remoteState.attachedRemote(AAD);
    assert.ok(state);
    assert.deepEqual([state.sessionId, state.connectorId, state.agentId], [cmd.session_id, cid, "codex"]);
    assert.deepEqual([state.agentLabel, state.host, state.cwd], ["⬛ Codex", "dev-pod", "/home/me/repo with spaces"]);
    // One status card, sent once: starting, then (in place) ready with its mode. Nothing else is said.
    const cards = w.statusCards();
    assert.equal(cards.length, 1);
    const card = JSON.stringify(cards[0]);
    assert.ok(card.includes("Connected to dev-pod · ⬛ Codex") && card.includes("Status: starting"), card);
    assert.deepEqual(
      w.said().filter((m) => m.includes("Codex")),
      [w.said().at(-1)],
    );
    assert.ok(w.said().at(-1)?.includes("Status: starting"));
    const edit = w.statusEdits().at(-1)?.[1] ?? "";
    assert.ok(edit.includes("Status: idle") && edit.includes("mode default"), edit);
    const now = w.test.store.remoteState.attachedRemote(AAD);
    assert.deepEqual([now?.mode, now?.modes], ["default", ["default", "plan", "acceptEdits"]]);
  }));

test("new that cannot start says why and creates nothing", async () => {
  for (const [label, text, setup, expected] of [
    ["no path", "/agent new codex", null, "Use `/agent new AGENT PATH`"],
    ["nothing", "/agent new", null, "Use `/agent new AGENT PATH`"],
    ["unknown agent", "/agent new gemini /repo", null, "I could not find an agent called `gemini`"],
    ["offline machine", "/agent new codex /repo", "offline", "dev-pod is offline"],
    ["another machine's agent", "/agent new codex /repo", "bobs", "I could not find an agent called `codex`"],
  ] as const) {
    await remoteWorld(async (w) => {
      if (setup === "bobs") w.server.addConnector(BOB, "bobs-box", TWO_AGENTS);
      else w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { online: setup !== "offline" });
      await w.say(text);
      assert.ok(w.last().includes(expected), `${label}: ${w.last()}`);
      assert.equal(w.server.sessions.size, 0);
      assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
    });
  }
});

test("an agent id on two online machines must be named with its machine", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS);
    const laptop = w.server.addConnector(ALICE, "laptop", TWO_AGENTS);
    await w.say("/agent new codex /repo");
    assert.ok(
      w.last().includes("Name one: `dev-pod/codex`, `laptop/codex`.") && w.server.sessions.size === 0,
      w.last(),
    );
    w.server.onCommand = new Script().hook;
    await w.say("/agent new LAPTOP/Codex /repo");
    assert.equal(w.server.commandsOf("session.new")[0]?.body["connector_id"], laptop);
  }));

test("one online machine wins over an offline one with the same agent", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "old-box", TWO_AGENTS, { online: false });
    const live = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS);
    w.server.onCommand = new Script().hook;
    await w.say("/agent new codex /repo");
    assert.equal(w.server.commandsOf("session.new")[0]?.body["connector_id"], live);
  }));

test("the session limit and the machine going offline between the list and the create are told", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS);
    for (let i = 0; i < 10; i += 1) w.server.addSession(ALICE, cid, "codex");
    await w.say("/agent new codex /repo");
    assert.equal(w.last(), said(409, '{"ok":false,"error":"session_limit_reached"}'));
    assert.ok(w.last().includes("/agent close"));
    for (const s of w.server.sessions.values()) s.status = "closed";
    w.server.failOn("POST", "/v1/remote-agents/sessions", 429);
    await w.say("/agent new codex /repo");
    assert.ok(
      w.last().includes("limiting remote agent requests") && w.test.store.remoteState.attachedRemote(AAD) === null,
    );
  }));

test("a machine that goes offline between the list and the create is told so", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS);
    w.server.failOn("POST", "/v1/remote-agents/sessions", [409, "connector_offline"]);
    await w.say("/agent new codex /repo");
    assert.equal(w.last(), OFFLINE);
    assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
  }));

test("a machine reconnecting as the session is asked for gets it once it is back", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { online: false, lastSeenAt: seen(5) });
    w.server.onCommand = new Script().hook;
    w.virtual.onSleep = (seconds) => {
      if (seconds === RECONNECT_RETRY_SECONDS) w.server.connector(cid).online = true;
    };
    await w.say("/agent new dev-pod/codex /repo");
    assert.ok(w.virtual.waited.includes(RECONNECT_RETRY_SECONDS));
    const [cmd] = w.server.commandsOf("session.new");
    assert.equal(cmd?.body["connector_id"], cid);
    assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.sessionId, cmd.session_id);
    assert.ok(!w.said().some((m) => m.includes("restart") || m.includes("Start its connector")));
  }));

test("a session refused as offline says reconnecting only for a machine heard from moments ago", async () => {
  for (const [ago, retried, expected] of [
    [5, true, "is most likely reconnecting by itself"],
    [3600, false, OFFLINE],
    [null, false, OFFLINE],
  ] as const) {
    await remoteWorld(async (w) => {
      w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { lastSeenAt: ago === null ? null : seen(ago) });
      w.server.failOn("POST", "/v1/remote-agents/sessions", [409, "connector_offline"]); // (listed online, refused at the create)
      await w.say("/agent new dev-pod/codex /repo");
      assert.ok(w.last().includes(expected) && w.test.store.remoteState.attachedRemote(AAD) === null, w.last());
      assert.deepEqual(
        w.virtual.waited.filter((s) => s === RECONNECT_RETRY_SECONDS),
        retried ? [RECONNECT_RETRY_SECONDS] : [],
      );
      const posts = w.server.calls.filter(([m, p]) => m === "POST" && p.endsWith("/sessions"));
      assert.equal(posts.length, retried ? 2 : 1);
      if (retried) assert.ok(w.last().includes("no need to restart its connector"));
    });
  }
});

test("a message claw ended for its machine ends the turn and says how", async () => {
  for (const [error, expected] of [
    ["not_delivered", "The turn did not complete: The machine never got it, so nothing ran"],
    [
      "delivery_unconfirmed",
      "The turn did not complete: The machine went just as this was sent and did not confirm it got it",
    ],
  ] as const) {
    await remoteWorld(async (w) => {
      const { sid } = await attached(w);
      w.server.onCommand = async (srv, cmd) => {
        if (cmd.type === "prompt")
          await srv.emit(sid, "turn_end", { stopReason: "error", error, cmd_seq: 2, by: "claw" });
      };
      await w.say("run the tests");
      await w.idle();
      assert.ok(
        w.last().includes(expected) && !w.last().includes(error) && !w.last().includes("no text output"),
        w.last(),
      );
    });
  }
});

test("a session closed under a running turn is not said as done", async () => {
  for (const [reason, expected] of [
    ["connector_revoked", "The session ended: That machine's connector was signed out"],
    ["machine_reconnected", "The session ended: That machine registered again"],
    ["adapter_gone", "The session ended: The agent program on that machine has exited."],
  ] as const) {
    await remoteWorld(async (w) => {
      const { sid } = await attached(w);
      w.server.onCommand = async (srv, cmd) => {
        if (cmd.type === "prompt") await srv.emit(sid, "session_closed", { reason, by: "claw" });
      };
      await w.say("run the tests");
      await w.idle();
      const last = w.last();
      assert.ok(
        last.startsWith(expected) &&
          !last.includes("Done.") &&
          !last.includes("no text output") &&
          !last.includes(reason),
        last,
      );
      assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
    });
  }
});

test("a session that cannot open says why and the chat goes back to claw", () =>
  remoteWorld(async (w) => {
    class Refusing extends Script {
      protected override async handle(srv: FakeRemote, cmd: FakeCommand): Promise<void> {
        if (cmd.type === "session.new")
          await srv.emit(cmd.session_id, "session_closed", { reason: "cwd is outside the allowed roots" });
      }
    }
    w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS);
    w.server.onCommand = new Refusing().hook;
    await w.say("/agent new codex /etc");
    assert.equal(
      w.last(),
      "The session could not start: cwd is outside the allowed roots. Your messages go to PrimusClaw again.",
    );
    assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
  }));

// --- where a message goes -----------------------------------------------------------------------------------------------

test("a turn shows the work as it happens then the answer and nothing stays open", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    let proceed = (): void => undefined;
    const go = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const work = async (srv: FakeRemote, sid: string): Promise<void> => {
      await srv.think(sid, "I should look at the README first");
      await srv.say(sid, "Looking at it. ");
      await srv.tool(sid, "t1", "Read README.md");
      await srv.acp(sid, "plan", {
        entries: [
          { content: "read it", status: "in_progress" },
          { content: "edit it", status: "pending" },
        ],
      });
      await go;
      await srv.tool(sid, "t1", "Read README.md", "completed");
      await srv.say(sid, "The README now has the line.");
      await srv.end(sid);
    };
    script.onPrompt = (srv, sid) => {
      void work(srv, sid); // the connector answers the command at once and goes on working
      return Promise.resolve();
    };
    const { sid } = await attached(w, script);
    await w.send("add a line");
    await w.until(() => w.progressTexts().some((t) => t.includes("⏳ Read README.md")));
    const live =
      w
        .progressTexts()
        .filter((t) => t.includes("⏳ Read README.md"))
        .at(-1) ?? "";
    assert.ok(live.startsWith("Working on it (⬛ Codex on dev-pod)..."), live);
    assert.ok(live.includes("_\u{1f4ad} I should look at the README first_") && live.includes("Looking at it."), live);
    assert.ok(live.includes("\u{1f4cb} Plan: 0 of 2 done, now: read it"), live);
    assert.ok(w.test.store.remoteState.attachedRemote(AAD)?.turnOpen);
    proceed();
    await w.idle();
    assert.equal(w.answer(), "The README now has the line.");
    const state = w.test.store.remoteState.attachedRemote(AAD);
    assert.ok(state && !state.turnOpen);
    assert.equal(state.cursor, String(w.server.events.get(sid)?.at(-1)?.id));
    assert.equal(w.remote.busyChats().length, 0);
  }));

test("a message while the agent is working is not sent on", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    script.onPrompt = async (srv, sid) => {
      await srv.say(sid, "working..."); // no turn end: the turn stays open
    };
    const { sid } = await attached(w, script);
    await w.send("first");
    await w.until(() => w.progressTexts().some((t) => t.includes("working...")));
    await w.send("second");
    assert.equal(w.last(), STILL_WORKING);
    assert.deepEqual(
      w.server.commandsOf("prompt").map((c) => c.body["text"]),
      ["first"],
    );
    await w.server.end(sid);
    await w.idle();
    script.onPrompt = oneTurn;
    await w.say("third");
    assert.deepEqual(
      w.server.commandsOf("prompt").map((c) => c.body["text"]),
      ["first", "third"],
    );
  }));

test("a prompt to an offline machine says so and starts no turn", () =>
  remoteWorld(async (w) => {
    const { cid } = await attached(w);
    w.server.connector(cid).online = false;
    await w.say("hello?");
    assert.equal(w.last(), OFFLINE);
    assert.ok(w.server.commandsOf("prompt").length === 0 && w.progressTexts().length === 0);
    const state = w.test.store.remoteState.attachedRemote(AAD);
    assert.ok(state && !state.turnOpen);
  }));

test("a prompt to a session that has ended says so", () =>
  remoteWorld(async (w) => {
    const { sid } = await attached(w);
    w.server.session(sid).status = "closed";
    await w.say("hello?");
    assert.ok(w.last().includes("That session has ended") && w.progressTexts().length === 0, w.last());
  }));

test("a message sent twice with one key queues one prompt", () =>
  remoteWorld(async (w) => {
    const { sid } = await attached(w);
    const keys = { sha1Hex: (t: string) => createHash("sha1").update(t).digest("hex"), hexId: () => "x" };
    const key = idempotencyKey(keys, "aad-a", "act-dup");
    await w.claw.command("ak-alice", sid, { type: "prompt", text: "once" }, key);
    const out = await w.claw.command("ak-alice", sid, { type: "prompt", text: "once" }, key);
    assert.equal(out["duplicate"], true);
    assert.equal(w.server.commandsOf("prompt").length, 1);
  }));

test("a dropped stream is picked up where it left off with nothing lost or repeated", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    script.onPrompt = async (srv, sid) => {
      for (let n = 0; n < 6; n += 1) await srv.say(sid, `part${String(n)} `);
      await srv.end(sid);
    };
    const { sid } = await attached(w, script);
    w.server.dropStreamAfter = 3;
    w.server.streamOpens.length = 0;
    await w.say("go");
    assert.equal(w.answer(), "part0 part1 part2 part3 part4 part5");
    const [first, second] = w.server.streamOpens;
    const rows = w.server.events.get(sid) ?? [];
    const ids = rows.map((e) => e.id);
    const promptStart = ids.indexOf(rows.find((e) => e.type === "agent_message_chunk")?.id ?? -1) - 1;
    assert.ok(first && second);
    assert.ok(
      second.after === ids[promptStart + 3] && second.after > first.after,
      JSON.stringify([first, second, ids]),
    );
  }));

test("events the agent replayed are not shown as new", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    script.onPrompt = async (srv, sid) => {
      await srv.emit(sid, "agent_message_chunk", { replay: true, text: "OLD MESSAGE" });
      await srv.emit(sid, "turn_end", { replay: true, stopReason: "end_turn" });
      await srv.say(sid, "new message");
      await srv.end(sid);
    };
    await attached(w, script);
    await w.say("go");
    assert.equal(w.answer(), "new message");
    assert.ok(!w.said().some((t) => t.includes("OLD")));
  }));

test("how a turn ended is told when it was not a plain end", async () => {
  for (const [reason, note] of [
    ["max_tokens", "reached its output limit"],
    ["refusal", "declined to continue"],
    ["max_turn_requests", "limit of steps"],
    ["weird", "The turn ended (error): an internal error (ref "],
  ] as const) {
    await remoteWorld(async (w) => {
      const script = new Script();
      script.onPrompt = async (srv, sid) => {
        await srv.say(sid, "partial answer");
        await srv.end(sid, reason);
      };
      await attached(w, script);
      await w.say("go");
      assert.ok(w.answer().includes("partial answer") && w.answer().includes(note), `${reason}: ${w.answer()}`);
    });
  }
});

test("the agent failing a turn with an error ends it with the reason", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    script.onPrompt = async (srv, sid) => {
      await srv.emit(sid, "turn_end", { stopReason: "error", error: "model gateway returned 502" });
    };
    await attached(w, script);
    await w.say("go");
    assert.ok(w.answer().includes("The turn ended (error): model gateway returned 502"), w.answer());
    assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.turnOpen, false);
  }));

test("a session closed while it works ends the turn and the attachment", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    script.onPrompt = async (srv, sid) => {
      await srv.say(sid, "starting");
      await srv.emit(sid, "session_closed", { reason: "the connector was revoked" });
    };
    await attached(w, script);
    await w.say("go");
    assert.ok(w.answer().includes("The session ended: the connector was revoked."), w.answer());
    assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
  }));

test("a credential the agent prints is masked in progress and in the answer", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    const secret = "sk-EXAMPLE-abcdef0123456789abcdef0123456789";
    script.onPrompt = async (srv, sid) => {
      await srv.say(sid, `your key is ${secret}`);
      await srv.end(sid);
    };
    await attached(w, script);
    await w.say("show it");
    assert.ok(!w.said().join(" ").includes(secret));
  }));
