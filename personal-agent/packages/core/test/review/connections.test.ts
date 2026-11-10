// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What /whoami says the person is connected to (`test_github_connect`'s whoami tests, read at `connections_text`): each connection,
 * what connects a missing one, and "could not be read just now" rather than "not connected" when a service cannot answer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { GithubConnection, GithubState } from "../../src/index.js";
import { connectionsText, UNKNOWN, type ConnectionsInput } from "../../src/review/connect/connections.js";

const state = (fields: Partial<GithubState> = {}): GithubState => ({
  userId: "u-alice",
  bound: false,
  login: "",
  scopes: [],
  expiresAt: "",
  expired: false,
  delegation: false,
  lastUsedAt: "",
  ...fields,
});
const BOUND = state({ bound: true, login: "alice-gh", scopes: ["repo"] });
const conn = (fields: Partial<GithubConnection> = {}): GithubConnection => ({
  readsWith: "",
  login: "",
  missing: "none",
  bindingReads: true,
  ...fields,
});

/** A deployment's line (`integrations.CONNECTION_LINES`), for a fictional fleet service that reads the account type. */
const FLEET = (kind: string, zh: boolean) => (zh ? `- FleetPilot：${kind}` : `- FleetPilot: ${kind}`);

function whoami(fields: Partial<ConnectionsInput>): string {
  return connectionsText({
    safe: { name: "Alice Safe" },
    githubState: state(),
    connection: conn(),
    connectionKnown: true,
    githubPart: true,
    memory: [true, true],
    memoryPage: "https://claw.test/settings?memory=1",
    zh: false,
    extraLines: [FLEET("default", false)],
    ...fields,
  });
}

const githubLine = (text: string) => text.split("\n").find((l) => l.startsWith("- GitHub")) ?? "";

test("whoami lists each connection and what connects the missing ones", () => {
  const text = whoami({ memory: [false, true] });
  assert.ok(text.startsWith("Connections:\n- SaFE: connected (Alice Safe)"), text);
  assert.ok(text.includes("- GitHub: not connected; send `/github bind` to connect it"));
  assert.ok(text.split("- FleetPilot: default")[0]?.includes("- GitHub: not connected"));
  assert.match(text, /^- Memory: off; turn it on at https:\/\/claw\.test\/settings\?memory=1$/m);
});

test("whoami when everything is connected", () => {
  const text = whoami({ githubState: BOUND, connection: conn({ readsWith: "binding", login: "alice-gh" }) });
  assert.ok(text.includes("- GitHub: connected `alice-gh`; Clawy reads your GitHub with it, as you"), text);
  assert.ok(text.includes("- FleetPilot: default") && text.includes("- Memory: on"));
});

test("whoami says unknown rather than not connected when a service cannot answer", () => {
  const text = whoami({ safe: null, githubState: UNKNOWN, connection: null, connectionKnown: false, memory: UNKNOWN });
  assert.ok(
    text.includes("- SaFE: could not be read just now") && text.includes("- GitHub: could not be read just now"),
  );
  assert.ok(text.includes("- Memory: could not be read just now") && !text.includes("not connected"), text);
});

test("whoami with an older claw does not claim what it reads github with", () => {
  for (const bound of [false, true]) {
    const line = githubLine(whoami({ githubState: bound ? BOUND : state(), connection: null }));
    assert.ok(
      line.includes("PrimusClaw does not say what it reads your GitHub with") && !line.includes("not connected;"),
    );
    assert.ok(
      bound
        ? line.includes("connected `alice-gh` with `/github bind`")
        : line.includes("not connected with `/github bind`"),
      line,
    );
  }
});

test("each github line, in both languages", () => {
  const expired = state({ bound: true, expired: true, login: "alice-gh" });
  const cases: [Partial<ConnectionsInput>, string, string][] = [
    [
      { connection: conn({ readsWith: "env" }) },
      "connected; Clawy reads your GitHub with the GH_TOKEN in your PrimusClaw settings",
      "已连接，Clawy 用你在 PrimusClaw 设置里保存的 GH_TOKEN 读 GitHub",
    ],
    [
      { connection: conn({ readsWith: "binding" }), githubState: BOUND },
      "connected `alice-gh`; Clawy reads your GitHub with it, as you (pull requests, CI, issues)",
      "已连接 `alice-gh`，Clawy 用它以你的身份读 GitHub（PR、CI、issue）",
    ],
    [
      { githubState: expired },
      "the authorization has expired; send `/github bind` to connect it again",
      "授权已过期，发 `/github bind` 重新连接",
    ],
    [
      { githubState: BOUND },
      "connected `alice-gh`, but PrimusClaw cannot read GitHub with it just now",
      "已连接 `alice-gh`，但 PrimusClaw 暂时用不了它读 GitHub",
    ],
    [
      { githubState: BOUND, connection: conn({ bindingReads: false }) },
      "connected `alice-gh` (for reviews only; for Clawy to read your GitHub, keep a GH_TOKEN in your PrimusClaw settings)",
      "已连接 `alice-gh`（只用于代审；要让 Clawy 读你的 GitHub，在 PrimusClaw 设置里保存一个 GH_TOKEN）",
    ],
    [
      { connection: conn({ bindingReads: false }) },
      "not connected; keep a GH_TOKEN in your PrimusClaw settings",
      "未连接，可以在 PrimusClaw 设置里保存一个 GH_TOKEN",
    ],
    [
      { githubPart: false, githubState: null },
      "not connected; keep a GH_TOKEN in your PrimusClaw settings",
      "未连接，可以在 PrimusClaw 设置里保存一个 GH_TOKEN",
    ],
    [
      { connection: null, githubState: expired },
      "the `/github bind` authorization has expired (PrimusClaw does not say what it reads your GitHub with)",
      "`/github bind` 的授权已过期（PrimusClaw 没有告诉我它用什么读你的 GitHub）",
    ],
    [
      { connection: null, connectionKnown: false, githubState: BOUND },
      "connected `alice-gh` with `/github bind` (PrimusClaw could not be asked what it reads your GitHub with)",
      "已用 `/github bind` 连接 `alice-gh`（暂时问不到 PrimusClaw 用什么读你的 GitHub）",
    ],
    [
      { connection: null, githubState: null, githubPart: false },
      "PrimusClaw does not say what it reads your GitHub with",
      "PrimusClaw 没有告诉我它用什么读你的 GitHub",
    ],
    [
      { connection: null, githubState: state() },
      "not connected with `/github bind` (PrimusClaw does not say what it reads your GitHub with)",
      "没有用 `/github bind` 连接（PrimusClaw 没有告诉我它用什么读你的 GitHub）",
    ],
  ];
  for (const [fields, en, zh] of cases) {
    assert.equal(githubLine(whoami(fields)), `- GitHub: ${en}`, JSON.stringify(fields));
    assert.equal(githubLine(whoami({ ...fields, zh: true })), `- GitHub：${zh}`, JSON.stringify(fields));
  }
});

test("memory and safe lines, in both languages", () => {
  const zh = (fields: Partial<ConnectionsInput>) => whoami({ ...fields, zh: true, extraLines: [] }).split("\n");
  assert.deepEqual(zh({ memory: [false, false] }).at(-1), "- 记忆：这个部署没有");
  assert.deepEqual(zh({ memory: [false, true] }).at(-1), "- 记忆：关，在这里打开：https://claw.test/settings?memory=1");
  assert.deepEqual(zh({ memory: UNKNOWN, safe: null }).slice(0, 2), ["连接状态：", "- SaFE：暂时读不到"]);
  assert.equal(zh({ memory: UNKNOWN }).at(-1), "- 记忆：暂时读不到");
  assert.equal(
    whoami({ memory: [false, false] })
      .split("\n")
      .at(-1),
    "- Memory: not on this deployment",
  );
});
