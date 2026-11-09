// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The commands that connect a machine and upgrade its connector (`remote/connector/setup.ts`).
import assert from "node:assert/strict";
import { test } from "node:test";

import { Setup, connectMarkdown, pairCommand, setupFrom, versionNote } from "../../src/remote/connector/setup.js";

const BASE = "https://claw.example.com/claw-api";

const same = (a: Setup, b: Setup): boolean => a.server === b.server && a.identityUrl === b.identityUrl;

test("setup comes from claw else from the address claw is reached at", () => {
  const told = setupFrom(
    {
      server: "https://claw.example.com/v2/claw-api/",
      identity_url: "https://claw.example.com/id",
    },
    BASE,
  );
  assert.equal(
    told.login(),
    "claw-connector login --server https://claw.example.com/v2/claw-api --identity-url https://claw.example.com/id",
  );
  const made = setupFrom(null, BASE);
  assert.equal(
    made.login(),
    "claw-connector login --server https://claw.example.com/claw-api --identity-url https://claw.example.com",
  );
  // Nothing a shell would read as more than one word, and never another host to sign in at.
  for (const bad of [
    { server: "javascript:alert(1)" },
    { server: "https://x y" },
    { server: 5 },
    "nope",
    { server: "https://claw.example.com;touch${IFS}/tmp/pwned" },
    { server: "https://claw.example.com/a$(id)" },
    { server: "https://claw.example.com/a`id`" },
    { server: "https://claw.example.com/a&&id" },
    { server: "https://elsewhere.example.com/claw-api" },
    { server: "https://user@claw.example.com/claw-api" },
    { server: "http://claw.example.com/claw-api" },
  ]) {
    assert.ok(same(setupFrom(bad, BASE), made), JSON.stringify(bad));
  }
  assert.equal(
    setupFrom({ server: BASE, identity_url: "https://phish.example.com" }, BASE).identityUrl,
    "https://claw.example.com",
  );
  assert.equal(
    setupFrom({ server: BASE, identity_url: "https://claw.example.com/x;rm -rf ~" }, BASE).identityUrl,
    "https://claw.example.com",
  );
  assert.equal(
    setupFrom({ server: BASE, identity_url: "http://claw.example.com" }, BASE).identityUrl,
    "https://claw.example.com",
  );
});

test("the connector commands come from the configured claw address", () => {
  const login =
    "claw-connector login --server https://claw.example.org/claw-api --identity-url https://claw.example.org";
  assert.equal(setupFrom(null, "https://claw.example.org/claw-api").login(), login);
  // Not configured: no address to give, and nothing Claw says is taken (there is nothing to check it against).
  assert.equal(setupFrom(null, "").login(), "claw-connector login");
  assert.ok(same(setupFrom({ server: "https://x.example/claw-api" }, ""), new Setup("", null)));
});

test("the connect steps are one block of commands to copy", () => {
  const text = connectMarkdown(setupFrom(null, BASE), "en");
  assert.ok(
    text.includes(
      "```\nnpm install -g @primusclaw/connector\nclaw-connector init\n" +
        "claw-connector login --server https://claw.example.com/claw-api --identity-url https://claw.example.com\n" +
        "claw-connector service install\n```",
    ),
  );
  assert.ok(text.includes("WSL") && text.includes("loginctl enable-linger") && text.includes("EACCES"));
  assert.ok(!/(?<!claw-)connector (login|run)/u.test(text));
});

test("a pairing command is rebuilt from a code and a server of the expected shape only", () => {
  const good = {
    code: "ABCD-EFGH-0001",
    server: "https://claw.example.com/claw-api",
  };
  assert.equal(
    pairCommand(good, BASE),
    "npm install -g --no-update-notifier @primusclaw/connector@latest && claw-connector pair ABCD-EFGH-0001 --server " +
      "https://claw.example.com/claw-api",
  );
  for (const bad of [
    { ...good, code: "abcd-efgh-0001" },
    { ...good, code: "ABCD-EFGH-0001; rm -rf ~" },
    { ...good, code: "ABCD-EFGH-000I" }, // (no I in Crockford base32)
    { ...good, server: "https://elsewhere.example.com/claw-api" },
    { ...good, server: "http://claw.example.com/claw-api" },
    { code: good.code },
    "ABCD-EFGH-0001",
    null,
  ]) {
    assert.equal(pairCommand(bad, BASE), null, JSON.stringify(bad));
  }
  assert.equal(pairCommand(good, ""), null); // (not configured: no host to check the server against)
});

test("a version note names the upgrade command and only a version's own characters", () => {
  assert.equal(versionNote({ version: "0.1.4", version_status: "current" }), null);
  assert.equal(versionNote({ version_status: "unknown" }), null);
  assert.ok(
    versionNote({
      version: "0.1.2",
      version_status: "unsupported",
    })?.startsWith("Its connector (0.1.2) is too old"),
  );
  assert.ok(
    versionNote({
      version: "0.1.3`$(id)`",
      version_status: "outdated",
    })?.startsWith("Its connector (0.1.3id) is out of date."),
  );
  assert.ok(versionNote({ version_status: "outdated" }, "zh")?.startsWith("连接器版本 ? 较旧"));
});
