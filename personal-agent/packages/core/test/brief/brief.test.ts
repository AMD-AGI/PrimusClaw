// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Port of the /brief tests of tests/test_proactive_ux.py and tests/test_assistant_proactive.py. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ClawError,
  DAILY_BRIEF,
  DailyBrief,
  type CommandRoute,
  type JsonObject,
  type Lang,
  type TriggerInput,
  type UserRef,
} from "@primusclaw/personal-agent";

import { FakeSurface, openTestStore } from "../../../../test-support/index.js";
import { RecordingLogger } from "../feedback/world.js";

const USER_A: UserRef = { id: "aad-a", channelUserId: "29:a", name: "Alice", email: "" };
const USER_B: UserRef = { id: "aad-b", channelUserId: "29:b", name: "Bob", email: "" };

class FakeTriggers {
  readonly calls: unknown[][] = [];
  readonly triggers = new Map<string, JsonObject[]>();
  error: number | undefined;
  createError: number | undefined;
  listError: number | undefined;

  list(key: string): Promise<JsonObject[]> {
    if (this.listError ?? this.error) return Promise.reject(new ClawError(this.listError ?? this.error ?? 0));
    return Promise.resolve(this.triggers.get(key) ?? []);
  }
  create(key: string, t: TriggerInput): Promise<JsonObject> {
    this.calls.push(["create_trigger", key, t.name, t.prompt, t.schedule, t.timezone, ...(t.action ? [t.action] : [])]);
    if (this.createError ?? this.error) return Promise.reject(new ClawError(this.createError ?? this.error ?? 0));
    const made = {
      trigger_id: `trg-${key}`,
      name: t.name,
      schedule: t.schedule,
      timezone: t.timezone,
      action: t.action ?? "run",
    };
    this.triggers.set(key, [
      ...(this.triggers.get(key) ?? []).filter((x) => x["trigger_id"] !== made.trigger_id),
      made,
    ]);
    return Promise.resolve(made);
  }
  update(key: string, id: string, t: TriggerInput): Promise<JsonObject> {
    this.calls.push(["update_trigger", key, id, t.schedule, t.timezone]);
    return Promise.resolve({ trigger_id: id });
  }
  delete(key: string, id: string): Promise<void> {
    this.calls.push(["delete_trigger", key, id]);
    this.triggers.set(
      key,
      (this.triggers.get(key) ?? []).filter((x) => x["trigger_id"] !== id),
    );
    return Promise.resolve();
  }
}

function world(options: { enabled?: boolean; assistant?: boolean } = {}) {
  const { store } = openTestStore();
  for (const [user, key] of [
    [USER_A, "ak-alice"],
    [USER_B, "ak-bob"],
  ] as const) {
    store.links.redeemPending(user.id, user.name, store.links.stashPending(key));
    store.prefs.setTimezone(user.id, "Asia/Shanghai");
  }
  const triggers = new FakeTriggers();
  const briefs: unknown[][] = [];
  let briefAnswer: JsonObject | Error = { text: "BRIEF" };
  const surface = new FakeSurface();
  const brief = new DailyBrief({
    enabled: options.enabled ?? true,
    links: store.links,
    prefs: store.prefs,
    triggers,
    assistant: {
      brief: (key, lang, timezone) => {
        briefs.push([key, lang, timezone]);
        return briefAnswer instanceof Error ? Promise.reject(briefAnswer) : Promise.resolve(briefAnswer);
      },
    },
    assistantOn: (userId) => (options.assistant ?? false) && userId === USER_A.id,
    briefMarkdown: (b) => `每日简报 ${typeof b["text"] === "string" ? b["text"] : ""}`,
    log: new RecordingLogger(),
  });
  const said = (): string[] =>
    surface.outbox.flatMap((r) =>
      r.op === "send"
        ? [
            r.message.body.type === "text"
              ? r.message.body.text
              : r.message.body.type === "rich"
                ? r.message.body.markdown
                : "",
          ]
        : [],
    );
  const run = (args: string, user = USER_A, lang: Lang = "en"): Promise<boolean> => {
    const route: CommandRoute = {
      sender: user,
      conversation: surface.conversation({ id: `conv-${user.id}`, kind: "personal", tenantId: "t", wire: {} }),
      scope: "",
      lang: () => lang,
      credential: store.links.getKey(user.id) ?? "",
      message: undefined,
    };
    return brief.run(route, args);
  };
  return {
    store,
    triggers,
    briefs,
    said,
    run,
    answerBrief: (a: JsonObject | Error) => {
      briefAnswer = a;
    },
  };
}

test("brief says it is not available yet while the trigger api is off", async () => {
  const w = world({ enabled: false });
  for (const args of ["on 08:30", "off", ""]) {
    assert.equal(await w.run(args), true);
    assert.ok(w.said().at(-1)?.includes("not available yet"));
  }
  await w.run("", USER_A, "zh");
  assert.equal(w.said().at(-1), "每日简报还用不了：它需要 PrimusClaw 的定时触发器，这里还没部署。能打开时我会告诉你。");
  assert.deepEqual(w.triggers.calls, []);
});

test("brief on creates a weekday trigger in the users zone with the users key", async () => {
  const w = world();
  await w.run("on 8:30");
  const [create] = w.triggers.calls;
  assert.deepEqual(create, [
    "create_trigger",
    "ak-alice",
    "Daily brief",
    DAILY_BRIEF.prompt,
    "30 8 * * 1-5",
    "Asia/Shanghai",
  ]);
  assert.ok(w.said().at(-1)?.includes("weekdays at 08:30 (Asia/Shanghai)"));
  assert.equal(w.store.prefs.getPrefs(USER_A.id).briefTriggerId, "trg-ak-alice");
});

test("brief on again updates instead of creating a second trigger", async () => {
  const w = world();
  w.store.prefs.setTimezone(USER_A.id, "America/Los_Angeles");
  await w.run("on 08:30");
  await w.run("on 09:15");
  assert.equal(w.triggers.calls.filter((c) => c[0] === "create_trigger").length, 1);
  assert.deepEqual(w.triggers.calls.at(-1), [
    "update_trigger",
    "ak-alice",
    "trg-ak-alice",
    "15 9 * * 1-5",
    "America/Los_Angeles",
  ]);
});

test("brief without a time uses the template default and bob does not touch alices trigger", async () => {
  const w = world();
  await w.run("on");
  await w.run("on 07:00", USER_B);
  assert.deepEqual(
    w.triggers.calls.filter((c) => c[0] === "create_trigger").map((c) => [c[1], c[4]]),
    [
      ["ak-alice", "30 8 * * 1-5"],
      ["ak-bob", "0 7 * * 1-5"],
    ],
  );
});

test("brief off deletes the trigger and forgets it", async () => {
  const w = world();
  await w.run("on 08:30");
  await w.run("off");
  assert.deepEqual(w.triggers.calls.at(-1), ["delete_trigger", "ak-alice", "trg-ak-alice"]);
  assert.equal(w.store.prefs.getPrefs(USER_A.id).briefTriggerId, null);
  assert.equal(w.said().at(-1), "Daily brief off.");
  await w.run("off");
  assert.equal(w.said().at(-1), "The daily brief was not on.");
});

test("brief with a bad argument creates nothing", async () => {
  for (const bad of ["on 25:00", "on 8", "on noon", "on 08:30 extra", "sometimes"]) {
    const w = world();
    await w.run(bad);
    assert.deepEqual(w.triggers.calls, [], bad);
  }
});

test("brief when claw has no trigger routes explains instead of failing", async () => {
  const w = world();
  w.triggers.error = 404;
  await w.run("on 08:30");
  assert.ok(w.said().at(-1)?.includes("not available yet"));
  w.triggers.error = 409;
  await w.run("on 08:30");
  assert.ok(w.said().at(-1)?.includes("maximum"));
  w.triggers.error = 500;
  await w.run("on 08:30");
  assert.equal(w.said().at(-1), "PrimusClaw did not accept that (error 500).");
});

test("brief needs the linked key not an exchanged token", async () => {
  const w = world();
  w.store.links.unlink(USER_A.id);
  await w.run("on 08:30");
  assert.ok(w.said().at(-1)?.includes("linked API key"));
  assert.deepEqual(w.triggers.calls, []);
});

test("brief with the assistant shows the brief now", async () => {
  const w = world({ assistant: true });
  await w.run("");
  assert.deepEqual(w.briefs, [["ak-alice", "en", "Asia/Shanghai"]]);
  const said = w.said();
  assert.equal(said.length, 1);
  assert.equal(said[0], "每日简报 BRIEF\n\nThe daily brief is off. Turn it on with `/brief on 08:30`."); // and its state, in one message
});

test("brief now is the brief alone in one message", async () => {
  const w = world({ assistant: true });
  await w.run("now", USER_A, "zh");
  assert.deepEqual(w.said(), ["每日简报 BRIEF"]);
  assert.deepEqual(w.briefs, [["ak-alice", "zh", "Asia/Shanghai"]]);
});

test("brief whose schedule cannot be read is still shown once", async () => {
  const w = world({ assistant: true });
  w.triggers.listError = 503;
  await w.run("");
  assert.deepEqual(w.said(), ["每日简报 BRIEF"]);
});

test("brief without the assistant only says its state", async () => {
  const w = world({ assistant: true });
  await w.run("", USER_B);
  assert.deepEqual(w.briefs, []);
  assert.equal(w.said().at(-1), "The daily brief is off. Turn it on with `/brief on 08:30`.");
  await w.run("on 08:30", USER_B, "zh");
  await w.run("", USER_B, "zh");
  assert.equal(w.said().at(-1), "每日简报已开：30 8 * * 1-5（Asia/Shanghai）。");
});

test("brief that cannot be read says so", async () => {
  const w = world({ assistant: true });
  w.answerBrief(new ClawError(503));
  await w.run("now");
  assert.ok(w.said().some((t) => t.includes("could not be read")));
});

test("brief on with the assistant is claws own brief and replaces one of the other kind", async () => {
  const w = world({ assistant: true });
  w.triggers.triggers.set("ak-alice", [
    { trigger_id: "old", name: "Daily brief", schedule: "30 8 * * 1-5", timezone: "Asia/Shanghai" },
  ]);
  await w.run("on 09:00");
  const kinds = w.triggers.calls.map((c) => c[0]);
  assert.deepEqual(kinds, ["create_trigger", "delete_trigger"]); // the old one goes only once the new one exists
  assert.deepEqual(w.triggers.calls[0]?.slice(4), ["0 9 * * 1-5", "Asia/Shanghai", "brief"]);
  assert.deepEqual(w.triggers.calls[1], ["delete_trigger", "ak-alice", "old"]);
  assert.ok(w.said().at(-1)?.includes("Send `/brief` for one now"));
  await w.run("on 10:00"); // the same kind: changed in place
  assert.equal(w.triggers.calls.filter((c) => c[0] === "create_trigger").length, 1);
  assert.deepEqual(w.triggers.calls.at(-1), [
    "update_trigger",
    "ak-alice",
    "trg-ak-alice",
    "0 10 * * 1-5",
    "Asia/Shanghai",
  ]);
  await w.run("on 08:00", USER_B); // without the assistant: a run, as before
  const bob = w.triggers.calls.find((c) => c[0] === "create_trigger" && c[1] === "ak-bob");
  assert.equal(bob?.length, 6);
});

test("a refused conversion keeps the old brief", async () => {
  const w = world({ assistant: true });
  w.triggers.triggers.set("ak-alice", [
    { trigger_id: "old", name: "Daily brief", schedule: "30 8 * * 1-5", timezone: "Asia/Shanghai" },
  ]);
  w.triggers.createError = 400; // Claw: brief_needs_assistant
  await w.run("on 09:00");
  assert.ok(!w.triggers.calls.some((c) => c[0] === "delete_trigger"));
  assert.ok(w.said().at(-1)?.includes("did not accept"));
});

test("the daily brief template agrees with the python one", () => {
  assert.equal(DAILY_BRIEF.defaultTime, "08:30");
  assert.equal(DAILY_BRIEF.days, "1-5");
  assert.ok(DAILY_BRIEF.prompt.includes("daily-brief") && DAILY_BRIEF.prompt.includes("write"));
  assert.equal(
    DAILY_BRIEF.prompt,
    "Use the daily-brief skill and give me my daily brief. Read only: do not change anything and do not call any tool that writes.",
  );
});

test("usage names what the chat can do", async () => {
  const w = world({ assistant: true });
  await w.run("sometimes");
  assert.equal(
    w.said().at(-1),
    "Use `/brief on 08:30` (24-hour time, weekdays), `/brief off`, or `/brief` for today's brief and its schedule.",
  );
  await w.run("sometimes", USER_B);
  assert.equal(
    w.said().at(-1),
    "Use `/brief on 08:30` (24-hour time, weekdays), `/brief off`, or `/brief` for status.",
  );
  await w.run("on 8");
  assert.equal(w.said().at(-1), "Use a 24-hour time, for example `/brief on 08:30`.");
});
