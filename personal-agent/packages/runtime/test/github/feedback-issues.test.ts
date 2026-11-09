// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Port of tests/test_feedback.py's GitHub half: the label, the credential (App installation token, token file, the
 * fallback), and the configuration, against an in-memory GitHub that checks the App's JWT with the App's public key.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConfigError, silentLogger, type FeedbackSink } from "@primusclaw/personal-agent";

import type { FetchLike } from "../../src/github/api.js";
import {
  feedbackConfigFromEnv,
  feedbackConfigured,
  feedbackSink,
  type FeedbackConfig,
} from "../../src/github/feedback-config.js";

const REPO = "example-org/example-repo";
const APP_ID = "12345";
const FILE_TOKEN = "ghp_" + "F".repeat(36);

function b64d(part: string): Buffer {
  return Buffer.from(part, "base64url");
}

/** GitHub, in memory: the App's token endpoint, labels, issues and comments of one repository. */
class FakeGitHub {
  readonly issues: { number: number; title: string; body: string; labels: string[] }[] = [];
  readonly comments: [number, string][] = [];
  readonly labels = new Set<string>();
  readonly mints: unknown[] = [];
  readonly validTokens = new Set([FILE_TOKEN]);
  readonly calls: string[] = [];
  labelCreations = 0;
  labelCreateStatus = 201;
  mintStatus = 201;
  rejectNextApiCall = false;
  now = 1_000_000;

  constructor(private readonly publicKey: string) {}

  everything(): string {
    return JSON.stringify({ issues: this.issues, comments: this.comments });
  }

  readonly fetch: FetchLike = (url, init) => Promise.resolve(this.handle(new URL(url), init));

  private handle(url: URL, init: RequestInit | undefined): Response {
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    this.calls.push(`${method} ${url.pathname}`);
    if (url.pathname.endsWith("/access_tokens")) return this.mint(auth, body);
    const token = auth.replace(/^Bearer /, "");
    if (this.rejectNextApiCall) {
      this.rejectNextApiCall = false;
      this.validTokens.delete(token);
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    if (!this.validTokens.has(token)) return Response.json({ message: "Bad credentials" }, { status: 401 });
    return this.api(method, url.pathname, body);
  }

  private api(method: string, path: string, body: Record<string, unknown>): Response {
    const base = `/repos/${REPO}`;
    if (method === "GET" && path === `${base}/labels/clawy-feedback`) {
      return Response.json({}, { status: this.labels.has("clawy-feedback") ? 200 : 404 });
    }
    if (method === "POST" && path === `${base}/labels`) {
      this.labelCreations += 1;
      if (this.labelCreateStatus === 201) this.labels.add(String(body["name"]));
      return Response.json({}, { status: this.labelCreateStatus });
    }
    if (method === "POST" && path === `${base}/issues`) {
      const number = this.issues.length + 1;
      this.issues.push({
        number,
        title: String(body["title"]),
        body: String(body["body"]),
        labels: body["labels"] as string[],
      });
      return Response.json(
        { number, html_url: `https://github.test/${REPO}/issues/${String(number)}` },
        { status: 201 },
      );
    }
    return Response.json({ message: `unexpected ${method} ${path}` }, { status: 500 });
  }

  private mint(auth: string, body: unknown): Response {
    const [head = "", claims = "", signature = ""] = auth.replace(/^Bearer /, "").split(".");
    if (!verify("RSA-SHA256", Buffer.from(`${head}.${claims}`), this.publicKey, b64d(signature))) {
      return Response.json({ message: "bad jwt" }, { status: 401 });
    }
    const c = JSON.parse(b64d(claims).toString()) as { iss: string; iat: number; exp: number };
    assert.deepEqual(JSON.parse(b64d(head).toString()), { alg: "RS256", typ: "JWT" });
    assert.ok(c.iss === APP_ID && c.exp - c.iat <= 600 && c.exp > this.now); // GitHub's own limits
    this.mints.push(body);
    if (this.mintStatus !== 201) return Response.json({ message: "no" }, { status: this.mintStatus });
    const token = `ghs_${String(this.mints.length).padStart(4, "0")}${"T".repeat(30)}`;
    this.validTokens.add(token);
    return Response.json(
      { token, expires_at: new Date((this.now + 3600) * 1000).toISOString().replace(".000Z", "Z") },
      { status: 201 },
    );
  }
}

function keyPair(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privatePem: privateKey.export({ type: "pkcs1", format: "pem" }),
    publicPem: publicKey.export({ type: "spki", format: "pem" }),
  };
}

const KEYS = keyPair();

interface Rig {
  readonly gh: FakeGitHub;
  readonly sink: FeedbackSink;
  readonly dir: string;
  readonly config: FeedbackConfig;
}

function rig(mode: "app" | "token" | "both", privatePem = KEYS.privatePem): Rig {
  const dir = mkdtempSync(join(tmpdir(), "pa-feedback-"));
  writeFileSync(join(dir, "app.pem"), privatePem);
  writeFileSync(join(dir, "token"), `${FILE_TOKEN}\n`);
  const gh = new FakeGitHub(KEYS.publicPem);
  const app = mode !== "token";
  const config: FeedbackConfig = {
    repo: REPO,
    appId: app ? APP_ID : "",
    installationId: app ? "777" : "",
    keyFile: app ? join(dir, "app.pem") : "",
    keyPem: "",
    tokenFile: mode !== "app" ? join(dir, "token") : "",
    apiUrl: "https://api.github.test",
  };
  const sink = feedbackSink(config, { fetch: gh.fetch, clock: () => gh.now, log: silentLogger });
  assert.ok(sink);
  return { gh, sink, dir, config };
}

async function file(sink: FeedbackSink, title = "t"): Promise<string> {
  const filed = await sink.createIssue(title, "body", ["clawy-feedback"]);
  return filed.ok
    ? `#${String(filed.value.number)}`
    : filed.error.kind === "sink_failed"
      ? filed.error.code
      : filed.error.kind;
}

test("the label is created once when missing and a label failure does not stop the report", async () => {
  const { gh, sink, dir } = rig("app");
  assert.equal(await file(sink), "#1");
  assert.equal(await file(sink), "#2");
  assert.equal(gh.labelCreations, 1);
  const other = rig("app");
  other.gh.labelCreateStatus = 403;
  assert.equal(await file(other.sink), "#1");
  assert.deepEqual(other.gh.issues[0]?.labels, ["clawy-feedback"]);
  rmSync(dir, { recursive: true, force: true });
  rmSync(other.dir, { recursive: true, force: true });
});

test("the installation token is minted with a signed jwt scoped to one repo and cached until it expires", async () => {
  const { gh, sink, dir } = rig("app");
  for (let i = 0; i < 3; i += 1) {
    assert.equal(await file(sink), `#${String(i + 1)}`);
    gh.now += 700;
  }
  assert.equal(gh.mints.length, 1);
  assert.deepEqual(gh.mints[0], { repositories: ["example-repo"], permissions: { issues: "write" } });
  gh.now += 3600; // the token has expired
  assert.equal(await file(sink), "#4");
  assert.equal(gh.mints.length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("a token github no longer accepts is replaced once and the call goes through", async () => {
  const { gh, sink, dir } = rig("app");
  await file(sink);
  gh.rejectNextApiCall = true;
  assert.equal(await file(sink), "#2");
  assert.equal(gh.mints.length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("a wrong key is refused by github and the report is kept", async () => {
  const { gh, sink, dir } = rig("app", keyPair().privatePem);
  assert.equal(await file(sink), "mint_401");
  assert.deepEqual(gh.issues, []);
  rmSync(dir, { recursive: true, force: true });
});

test("the token file is used when there is no app and as the fallback when the app fails", async () => {
  const onlyFile = rig("token");
  assert.equal(await file(onlyFile.sink), "#1");
  assert.deepEqual(onlyFile.gh.mints, []);
  const both = rig("both");
  both.gh.mintStatus = 500;
  assert.equal(await file(both.sink), "#1");
  assert.equal(both.gh.mints.length, 1); // the App was tried first
  rmSync(onlyFile.dir, { recursive: true, force: true });
  rmSync(both.dir, { recursive: true, force: true });
});

test("an unreadable key file is a stored report not a crash", async () => {
  const { sink, dir } = rig("app");
  rmSync(join(dir, "app.pem"));
  assert.equal(await file(sink), "key_file_unreadable");
  rmSync(dir, { recursive: true, force: true });
});

test("configuration comes from the environment", () => {
  const cases: readonly (readonly [Record<string, string>, boolean])[] = [
    [{}, false],
    [{ FEEDBACK_GITHUB_APP_ID: "1", FEEDBACK_GITHUB_INSTALLATION_ID: "2", FEEDBACK_REPO: REPO }, false], // no key
    [
      {
        FEEDBACK_GITHUB_APP_ID: "1",
        FEEDBACK_GITHUB_INSTALLATION_ID: "2",
        FEEDBACK_GITHUB_KEY_FILE: "/k",
        FEEDBACK_REPO: REPO,
      },
      true,
    ],
    [{ FEEDBACK_GITHUB_TOKEN_FILE: "/t", FEEDBACK_REPO: REPO }, true],
    [{ FEEDBACK_GITHUB_TOKEN_FILE: "/t", FEEDBACK_REPO: "not a repo" }, false],
  ];
  for (const [env, configured] of cases) {
    const config = feedbackConfigFromEnv(env);
    assert.equal(feedbackConfigured(config), configured, JSON.stringify(env));
    assert.equal(config.repo, env["FEEDBACK_REPO"] ?? "");
  }
  const fromVault = feedbackConfigFromEnv(
    {
      FEEDBACK_GITHUB_APP_ID: "1",
      FEEDBACK_GITHUB_INSTALLATION_ID: "2",
      FEEDBACK_GITHUB_KEY_FILE: "/k",
      FEEDBACK_REPO: REPO,
    },
    "PEM",
  );
  assert.deepEqual([fromVault.keyFile, fromVault.keyPem, feedbackConfigured(fromVault)], ["", "PEM", true]);
  assert.equal(feedbackSink(feedbackConfigFromEnv({}), { log: silentLogger }), undefined);
});

test("a credential with no repository stops the start", () => {
  for (const env of [
    { FEEDBACK_GITHUB_TOKEN_FILE: "/t" },
    { FEEDBACK_GITHUB_APP_ID: "1", FEEDBACK_GITHUB_INSTALLATION_ID: "2" },
  ]) {
    assert.throws(
      () => feedbackConfigFromEnv(env),
      (e: unknown) => e instanceof ConfigError && e.message.includes("FEEDBACK_REPO"),
    );
  }
});

test("the secrets never reach what is filed", async () => {
  const { gh, sink, dir } = rig("both");
  await file(sink, "it broke");
  const written = gh.everything();
  for (const token of gh.validTokens) assert.ok(!written.includes(token));
  assert.ok(!written.includes("BEGIN"));
  rmSync(dir, { recursive: true, force: true });
});
