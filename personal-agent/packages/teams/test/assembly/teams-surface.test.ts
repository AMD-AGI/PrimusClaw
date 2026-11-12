// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the worker reads of Teams besides its port (`teamsShape`): the reply style by conversation kind, stored references
 * read back, the fields a followed review keeps, and the adapter's name. Each reads exactly what the worker read of
 * Teams before the worker became its own package.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { followWire, refOf, replyStyle, teamsShape, teamsSurface } from "../../src/assembly/worker.js";
import { teamsSettingsFromEnv } from "../../src/config/env.js";
import { DEFAULT_STYLE } from "../../src/config/style.js";

const REFERENCE = {
  serviceUrl: "https://smba.trafficmanager.net/amer/",
  conversation: { id: "dm-a", conversationType: "personal", tenantId: "t1" },
  bot: { id: "28:bot", name: "Clawy" },
  user: { id: "29:aad-a", aadObjectId: "aad-a", name: "Alice" },
};

test("a turn streams in the kinds of chat TEAMS_STREAMING names, and never in a channel", () => {
  const all = replyStyle(DEFAULT_STYLE);
  assert.deepEqual(
    (["personal", "group", "channel"] as const).map((kind) => all.streamsIn(kind)),
    [true, true, false],
  );
  const personal = replyStyle({ ...DEFAULT_STYLE, streaming: new Set(["personal"]) });
  assert.deepEqual(
    (["personal", "group", "channel"] as const).map((kind) => personal.streamsIn(kind)),
    [true, false, false],
  );
  const off = replyStyle(teamsSettingsFromEnv({ TEAMS_STREAMING: "off" }, { queues: false }).style);
  assert.equal(off.streamsIn("personal"), false);
});

test("the reply style's switches are the Teams settings' own", () => {
  const style = teamsSettingsFromEnv(
    { TEAMS_STREAM_TEXT: "on", TEAMS_ASSISTANT_RECEIPT: "off", TEAMS_CITATIONS: "on", TEAMS_OWN_THUMBS_MOBILE: "off" },
    { queues: false },
  ).style;
  const read = replyStyle(style);
  assert.deepEqual(
    {
      streamText: read.streamText,
      assistantReceipt: read.assistantReceipt,
      assistantProgress: read.assistantProgress,
      assistantStreamSay: read.assistantStreamSay,
      ownThumbsMobile: read.ownThumbsMobile,
      suggestedReplies: read.suggestedReplies,
      citations: read.citations,
    },
    {
      streamText: true,
      assistantReceipt: false,
      assistantProgress: true,
      assistantStreamSay: true,
      ownThumbsMobile: false,
      suggestedReplies: true,
      citations: true,
    },
  );
});

test("a followed review keeps the Teams fields of the chat it was asked in, and empty ones where there are none", () => {
  const asked = refOf(REFERENCE);
  assert.deepEqual(followWire(asked), {
    service_url: "https://smba.trafficmanager.net/amer/",
    tenant: "t1",
    bot_id: "28:bot",
  });
  assert.deepEqual(followWire({ id: "x", kind: "personal", tenantId: "", wire: { bot: ["28:bot"] } }), {
    service_url: "",
    tenant: "",
    bot_id: "",
  });
});

test("a stored reference is read back as it was stored, and one that names no conversation still gets one", () => {
  const shape = teamsShape(teamsSettingsFromEnv({}, { queues: false }));
  assert.deepEqual(shape.restoreRef(REFERENCE), { id: "dm-a", kind: "personal", tenantId: "t1", wire: REFERENCE });
  assert.equal(shape.restoreRef({ conversation: { id: "x" } }), undefined);
  const group = { conversation: { conversationType: "groupChat" } };
  assert.deepEqual(shape.refOf(group), { id: "", kind: "group", tenantId: "", wire: group });
  assert.deepEqual(shape.refOf({}), { id: "", kind: "personal", tenantId: "", wire: {} });
});

test("Teams is named as people know it, with the teams package's version, and the worker logs as teams_agent", () => {
  const shape = teamsShape(
    teamsSettingsFromEnv({ TEAMS_INSTALL_HINT_URL: "https://teams.example/app" }, { queues: false }),
  );
  assert.equal(shape.channelName, "Teams");
  assert.equal(shape.installHintUrl, "https://teams.example/app");
  assert.match(shape.version, /^\d+\.\d+\.\d+$/);
  assert.equal(teamsSurface().name, "teams");
});
