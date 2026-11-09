// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Ported from teams/tests/test_capabilities.py: every example sentence help teaches goes through the real routing, in the
 * chat it is typed in, and arrives at the handler of the capability it is the example of (each handler replaced by a
 * recorder, as the Python test does). Reviews go to the review service, which is not part of this line: an example that
 * reaches it is checked to arrive at the review service's own entry (a group interceptor or a command handler).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { byKey, CAPABILITIES, type Capability } from "../../src/capabilities/registry.js";
import type { GithubChat } from "../../src/routing/features.js";
import { AccountCommands } from "../../src/routing/commands-account.js";
import { SessionCommands } from "../../src/routing/commands-session.js";
import { SettingsCommands } from "../../src/routing/commands-settings.js";
import { LinkCommands } from "../../src/routing/link-commands.js";
import { TurnStarter } from "../../src/routing/turn-start.js";
import { pySplit } from "../../src/text/py-text.js";
import { ALICE } from "./fixtures.js";
import { link, message, said, world } from "./world.js";

type Seen = [string, string | null];

function spy(seen: Seen[]): () => void {
  const restore: (() => void)[] = [];
  const patch = <T extends object>(proto: T, name: keyof T & string, record: (args: unknown[]) => Seen): void => {
    const original = proto[name];
    (proto as Record<string, unknown>)[name] = (...args: unknown[]) => {
      seen.push(record(args));
      return Promise.resolve(true);
    };
    restore.push(() => {
      (proto as Record<string, unknown>)[name] = original;
    });
  };
  const second =
    (name: string) =>
    (args: unknown[]): Seen => [name, String(args[1])];
  const none = (name: string) => (): Seen => [name, null];
  patch(SettingsCommands.prototype, "quiet", second("quiet"));
  patch(SettingsCommands.prototype, "pause", second("pause"));
  patch(SettingsCommands.prototype, "timezone", second("timezone"));
  patch(SettingsCommands.prototype, "resume", none("resume"));
  patch(SessionCommands.prototype, "repo", second("repo"));
  patch(SessionCommands.prototype, "new", none("new"));
  patch(SessionCommands.prototype, "stop", none("stop"));
  patch(SessionCommands.prototype, "sessions", none("sessions"));
  patch(AccountCommands.prototype, "lang", second("lang"));
  patch(AccountCommands.prototype, "whoami", none("whoami"));
  patch(AccountCommands.prototype, "memory", none("memory"));
  patch(AccountCommands.prototype, "memorySwitch", (args) => ["memory", String(args[2])]);
  patch(AccountCommands.prototype, "help", none("help"));
  patch(LinkCommands.prototype, "link", second("link"));
  patch(TurnStarter.prototype, "start", none("turn"));
  return () => {
    for (const undo of restore) undo();
  };
}

function expected(c: Capability): Seen {
  if (["turn", "unlink_ask", "help"].includes(c.reaches)) return [c.reaches, null];
  const [name = "", ...rest] = pySplit(c.reaches);
  return [name, rest.length > 0 ? rest.join(" ") : null];
}

function routeWorld(c: Capability, seen: Seen[]) {
  const assistant = c.mode === "assistant" || c.mode === "understanding";
  const attached = c.key === "agent_detach";
  const w = world({
    config: { briefEnabled: true },
    assistant: assistant
      ? {
          on: () => true,
          understands: () => c.mode === "understanding",
          board: () => (seen.push(["board", null]), Promise.resolve()),
          route: () => (seen.push(["turn", null]), Promise.resolve(true)),
          understand: () => (seen.push(["assistant", null]), Promise.resolve(true)),
        }
      : {},
    remote: {
      enabled: true,
      attached: () => attached,
      agents: () => (seen.push(["agents", null]), Promise.resolve()),
      agent: (command) => (seen.push(["agent", command.args]), Promise.resolve()),
      prompt: () => (seen.push(["remote_prompt", null]), Promise.resolve()),
    },
    handlers: {
      commands: [
        { name: "brief", run: (_r, args) => (seen.push(["brief", args]), Promise.resolve(true)) },
        {
          name: "github",
          beforeCredential: true,
          run: (_r, args) => (seen.push(["github", args]), Promise.resolve(true)),
        },
        {
          name: "feedback",
          beforeCredential: true,
          run: (_r, args) => (seen.push(["feedback", args]), Promise.resolve(true)),
        },
      ],
      groupInterceptors: [
        {
          name: "feedback",
          intercept: (r) => Promise.resolve(r.text.startsWith("/feedback") && seen.push(["feedback", null]) > 0),
        },
      ],
    },
  });
  const github: GithubChat = {
    remember: () => undefined,
    helpValues: () => Promise.resolve({}),
    offerConnect: () => Promise.resolve(),
    pendingConfirmations: () => [],
    connectionState: () => Promise.resolve(undefined),
  };
  Object.assign(w.deps, { github });
  link(w, ALICE.id, "ak");
  return w;
}

const SERVICE = new Set(["group_review", "review_mode", "assistant", "review_stop"]); // (the review service's, or the assistant's reading)

for (const c of CAPABILITIES.filter((x) => x.sayZh !== "" && !SERVICE.has(expected(x)[0]))) {
  for (const lang of ["zh", "en"] as const) {
    const say = lang === "zh" ? c.sayZh : c.sayEn;
    const groups = c.typedIn === "group" ? [true] : c.where === "both" && c.key !== "whoami" ? [false, true] : [false];
    for (const group of groups) {
      test(`test_each_example_reaches_its_capability ${c.key}-${lang}-${group ? "group" : "dm"}`, async () => {
        const seen: Seen[] = [];
        const w = routeWorld(c, seen);
        const restore = spy(seen);
        try {
          await w.router.handle(message(say, group ? { kind: "group", conversation: "g-1" } : {}));
        } finally {
          restore();
        }
        const [name, arg] = expected(c);
        if (name === "unlink_ask")
          assert.ok(
            said(w)
              .at(-1)
              ?.startsWith(lang === "zh" ? "`unlink` 会断开" : "`unlink` would"),
          );
        else if (group && name === "help")
          assert.ok(/^\*\*(Clawy 能帮你做什么|What Clawy can do for you)\*\*/u.test(said(w).at(-1) ?? ""));
        else if (arg === null)
          assert.deepEqual(
            seen.map((s) => s[0]),
            [name],
            `${say}: ${JSON.stringify(seen)}`,
          );
        else assert.deepEqual(seen, [[name, arg]], say);
      });
    }
  }
}

test("test_which_account_in_a_group_is_answered_there", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  for (const [say, connected] of [
    [byKey("whoami").sayZh, "已连接"],
    [byKey("whoami").sayEn, "connected"],
  ] as const) {
    await w.router.handle(message(say, { kind: "group", conversation: "g-1" }));
    assert.ok(said(w).at(-1)?.includes(connected), say);
  }
});

test("test_without_the_assistant_my_tasks_goes_to_claw_as_the_words", async () => {
  const w = world();
  link(w, ALICE.id, "ak-alice-linked");
  await w.router.handle(message("看看我的任务"));
  await w.router.settled();
  assert.deepEqual(w.turns.calls, [["create", "ak-alice-linked", "看看我的任务"]]);
});

test("test_without_the_brief_a_brief_sentence_is_words_for_claw", async () => {
  const w = world();
  link(w, ALICE.id, "ak-alice-linked");
  await w.router.handle(message("每天早上 9 点给我发简报"));
  await w.router.settled();
  assert.deepEqual(w.turns.calls, [["create", "ak-alice-linked", "每天早上 9 点给我发简报"]]);
});

const REMOTE_WORDS: Readonly<Record<string, string>> = {
  "回到 Clawy": "agent detach",
  回来吧: "agent detach",
  "断开 agent": "agent detach",
  "不跟 agent 说了": "agent detach",
  "back to Clawy": "agent detach",
  "come back to Clawy": "agent detach",
  "detach the agent": "agent detach",
  "看看我电脑上的 agent": "agents",
  "看看我的远程 agent": "agents",
  "show my agents": "agents",
  "我的 agent 会话": "agent sessions",
  "my agent sessions": "agent sessions",
};
const STATES: Readonly<Record<string, readonly [boolean, boolean]>> = {
  "remote agents off": [false, false],
  "on, nothing attached": [true, false],
  "on, an agent attached": [true, true],
};

for (const [say, asks] of Object.entries(REMOTE_WORDS)) {
  for (const [state, [enabled, attached]] of Object.entries(STATES)) {
    test(`test_a_remote_agent_sentence_is_a_command_only_while_it_applies ${say} / ${state}`, async () => {
      const seen: Seen[] = [];
      const w = world({
        remote: {
          enabled,
          attached: () => attached,
          agents: () => (seen.push(["agents", null]), Promise.resolve()),
          agent: (command) => (seen.push(["agent", command.args]), Promise.resolve()),
          prompt: () => (seen.push(["remote_prompt", null]), Promise.resolve()),
        },
      });
      link(w, ALICE.id, "ak");
      const restore = spy(seen);
      try {
        await w.router.handle(message(say));
      } finally {
        restore();
      }
      const applies = enabled && (attached || asks !== "agent detach");
      const want: Seen[] = !applies
        ? [[attached ? "remote_prompt" : "turn", null]]
        : asks === "agents"
          ? [["agents", null]]
          : [["agent", asks.split(" ")[1] ?? ""]];
      assert.deepEqual(seen, want);
    });
  }
}
