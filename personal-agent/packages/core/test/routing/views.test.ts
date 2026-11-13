// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { CONFIRM_BUTTON, CommandViews, repoButton, showButton } from "../../src/routing/views.js";
import { note } from "./fixtures.js";

test("the router's cards carry what they say, and their buttons what comes back", () => {
  const views = new CommandViews("PrimusClaw Assistant", "https://claw.example.com", note);
  const shapes = [
    views.link("a@example.com", "teams"),
    views.binding("https://id.test/c", "Hello. "),
    views.onboarding({ name: "Ann", channelUserId: "29:x" }, "p1", true),
    views.repo("o/r", "", "zh"),
    views.session({
      sessionId: "s1",
      title: "",
      repo: "",
      branch: "",
      when: "today 12:40",
      current: false,
      lang: "en",
    }),
  ].map((m) => (m.body.type === "view" ? `${m.body.view.name}:${m.body.fallbackText}` : m.body.type));
  assert.deepEqual(shapes, [
    "link:Connect PrimusClaw Assistant",
    "binding:Connect PrimusClaw Assistant",
    "onboarding:Connect PrimusClaw Assistant",
    "repo:o/r",
    "session:s1",
  ]);
  const session = views.session({
    sessionId: "s1",
    title: "t",
    repo: "",
    branch: "",
    when: "",
    current: true,
    lang: "zh",
  });
  assert.ok(session.body.type === "view" && session.body.fallbackText === "t");
  assert.equal(repoButton("o/r", "b", "zh").title, "用这个仓库");
  assert.deepEqual(repoButton("o/r", "b").data, { repo: "o/r", branch: "b" });
  assert.deepEqual(showButton("s1"), { title: "Show here", verb: "show", data: { session_id: "s1" } });
  assert.equal(CONFIRM_BUTTON.style, "positive");
});

test("the link card sends the person to the console's page of their own channel", () => {
  const views = new CommandViews("PrimusClaw Assistant", "https://claw.example.com", note);
  const pageOf = (m: ReturnType<CommandViews["link"]>) =>
    m.body.type === "view" ? (m.body.view.model as { page: string }).page : "";
  assert.equal(pageOf(views.link("a@example.com", "teams")), "https://claw.example.com/primus-claw/teams-link");
  assert.equal(pageOf(views.link("a@example.com", "chatapp")), "https://claw.example.com/primus-claw/chatapp-link");
});
