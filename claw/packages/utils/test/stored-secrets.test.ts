// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import { redactStoredText, redactStoredValue } from "../src/security/stored-secrets.js";

// Credential fixtures are assembled from pieces so no scanner reads this file as holding one.
const body = (n: number, seed = "A1b2C3d4E5") => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
const SAFE_KEY = `ak-${body(38)}-Zq7x`;
const OPENAI_KEY = `sk-proj-${body(48)}`;
const ANTHROPIC_KEY = `sk-ant-api03-${body(90)}`;
const GITHUB_CLASSIC = `gh${"p"}_${body(36)}`;
const GITHUB_FINE = `github${"_pat_"}${body(82)}`;
const JWT = `eyJ${body(20)}.eyJ${body(30)}.${body(43)}`;
const PRIVATE_KEY = ["-----BEGIN RSA PRIVATE KEY-----", body(64), body(64), "-----END RSA PRIVATE KEY-----"].join("\n");

function masked(input: string, secret: string): string {
  const r = redactStoredText(input);
  assert.equal(r.text.includes(secret), false, `${JSON.stringify(secret)} survived in ${JSON.stringify(r.text)}`);
  assert.ok(r.hits >= 1, `no hit counted for ${JSON.stringify(input)}`);
  return r.text;
}

test("every credential class is masked, the text around it is kept", () => {
  assert.equal(masked(`use ${SAFE_KEY} for SaFE`, SAFE_KEY), "use <redacted> for SaFE");
  // The dash-separated tail is part of the key: nothing of it is left behind.
  assert.equal(masked(`key=${SAFE_KEY}.`, "Zq7x").includes("Zq7x"), false);
  masked(`OPENAI_API_KEY is ${OPENAI_KEY}`, OPENAI_KEY);
  masked(`claude key ${ANTHROPIC_KEY} here`, ANTHROPIC_KEY);
  masked(`git clone with ${GITHUB_CLASSIC}`, GITHUB_CLASSIC);
  masked(`token ${GITHUB_FINE}`, GITHUB_FINE);
  assert.match(masked(`Authorization: Bearer ${body(40)}`, body(40)), /^(?:Authorization: )?Bearer <redacted>$/);
  // Shorter than the 20 characters the transcript pass asks of a bearer token, but with a digit no English word has.
  assert.equal(masked("curl -H 'X-Auth: Bearer abc123def456'", "abc123def456"), "curl -H 'X-Auth: Bearer <redacted>'");
  masked(`id_token: ${JWT}`, JWT);
  assert.equal(masked(`here:\n${PRIVATE_KEY}\nthanks`, body(64)), "here:\n<redacted private key>\nthanks");
  // Cut off before its END line: masked to the end, never left half-open.
  assert.equal(masked(`k: ${PRIVATE_KEY.split("\n").slice(0, 2).join("\n")}`, body(64)), "k: <redacted private key>");
  assert.equal(masked("DATABASE_URL=postgres://app:Pa55word@db:5432/claw", "Pa55word"), "DATABASE_URL=postgres://<redacted>@db:5432/claw");
  assert.equal(masked("redis://:s3cr3t@cache:6379", "s3cr3t"), "redis://<redacted>@cache:6379");
});

test("a value written after a credential's name is masked", () => {
  assert.equal(masked("login with password=hunter2 please", "hunter2"), "login with password=<redacted> please");
  assert.equal(masked("DB_PASSWORD=XkjQmzPl", "XkjQmzPl"), "DB_PASSWORD=<redacted>");
  assert.equal(masked(`{"password": "s3cr3t!x"}`, "s3cr3t!x"), `{"password": "<redacted>"}`);
  assert.equal(masked("db:\n  password: hunter2\n", "hunter2"), "db:\n  password: <redacted>\n");
  assert.equal(masked("https://ci.example.com/hook?token=abc123def&x=1", "abc123def"), "https://ci.example.com/hook?token=<redacted>&x=1");
  assert.equal(masked("client_secret = 'Zx9-qq_77'", "Zx9-qq_77"), "client_secret = '<redacted>'");
  assert.equal(masked("export API_KEY=q8w7e6r5t4", "q8w7e6r5t4"), "export API_KEY=<redacted>");
});

test("ordinary text, code and placeholders are left exactly as they are", () => {
  const untouched = [
    "the task-management-system and sk-internationalization-settings",
    "use a Bearer token, or Bearer authentication",
    "reset your password at the portal, then ask for a new token",
    "const password = getPassword();",
    "password: string;",
    "def login(password: str = None):",
    "token = config.token",
    "password = os.environ[\"DB_PASSWORD\"]",
    "password=${DB_PASSWORD} and token: $GITHUB_TOKEN and api_key: ${{ secrets.API_KEY }}",
    "password: required",
    "token: false",
    "\"password\": \"Enter your password\"",
    "max_tokens=4096, token_count: 12, input_tokens=5, token: 3",
    "the ak-47 and sk-1 are not keys",
    "commit 9f2c4e1a7b3d5f6e8a0b1c2d3e4f5a6b7c8d9e0f, see https://github.com/AMD-AGI/PrimusClaw/pull/325",
    "请帮我看一下 #325，密码策略已经更新。",
    "postgres://db:5432/claw and https://example.com/path?q=1",
    "secret: my-secret-name",
  ];
  for (const text of untouched) {
    const r = redactStoredText(text);
    assert.equal(r.text, text, `rewrote ${JSON.stringify(text)}`);
    assert.equal(r.hits, 0, `counted a hit in ${JSON.stringify(text)}`);
  }
  assert.deepEqual(redactStoredText(""), { text: "", hits: 0 });
});

test("a stored event is masked as a copy: routing fields, types and the original are kept", () => {
  const event = {
    type: "UserMessage", message_id: "m-1", seq: 7, role: "user",
    data: { content: [{ type: "text", text: `here is my key ${SAFE_KEY}` }] },
    input: { api_key: "q8w7e6r5", token: false, tokens: 12, password: "" },
    at: new Date(0),
  };
  const before = JSON.stringify(event);
  const out = redactStoredValue(event);
  assert.equal(JSON.stringify(event), before, "the input was modified");
  assert.equal(out.type, "UserMessage");
  assert.equal(out.message_id, "m-1");
  assert.equal(out.seq, 7);
  assert.equal(out.data.content[0].text, "here is my key <redacted>");
  assert.equal(out.input.api_key, "<redacted>");
  assert.equal(out.input.token, false);
  assert.equal(out.input.tokens, 12);
  assert.equal(out.input.password, "");
  assert.ok(out.at instanceof Date);
  assert.equal(redactStoredValue(null), null);
  assert.equal(redactStoredValue(3), 3);
});

test("a long line with no credential is scanned in linear time", () => {
  const long = `${"a_".repeat(50_000)}password ${"x".repeat(100_000)} token`;
  const started = Date.now();
  redactStoredText(long);
  assert.ok(Date.now() - started < 2_000, "scan took too long");
});
