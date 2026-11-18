// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The worker's own Azure identity: its settings, its key, and a token credential per scope. */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssertionKeyError } from "../../src/connector/tokens/assertion.js";
import {
  CredentialAuthenticationError,
  FederatedCredential,
  readWorkerKey,
  workerIdentityFromEnv,
  WorkerIdentityError,
  type WorkerIdentity,
} from "../../src/azure/workload-identity.js";
import { FakeClock, flushMicrotasks } from "../../../../test-support/clock.js";
import { FakeTeams, json } from "../connector/fakes.js";

const KEY_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" });
const ENV = {
  WORKER_IDENTITY_CLIENT_ID: "00000000-0000-0000-0000-0000000000c3",
  BOT_TENANT_ID: "00000000-0000-0000-0000-0000000000b2",
  BOT_ASSERTION_ISSUER: "https://oidc.example.com/prod/",
  WORKER_IDENTITY_SUBJECT: "claw-teams-worker",
  BOT_ASSERTION_KEY_FILE: "/etc/claw-bot/private-key.pem",
};

function identity(keyFile = "/unused"): WorkerIdentity {
  return { ...workerIdentityFromEnv(ENV, "KEYVAULT_URL"), keyFile };
}

test("the identity comes from the environment, the issuer without its trailing slash", () => {
  assert.deepEqual(workerIdentityFromEnv({ ...ENV, WORKER_IDENTITY_SUBJECT: " claw-teams-worker " }, "x"), {
    clientId: ENV.WORKER_IDENTITY_CLIENT_ID,
    tenantId: ENV.BOT_TENANT_ID,
    issuer: "https://oidc.example.com/prod",
    subject: "claw-teams-worker",
    keyFile: ENV.BOT_ASSERTION_KEY_FILE,
  });
});

test("a missing setting names what needs it and what is missing, and the issuer must be https", () => {
  assert.throws(
    () =>
      workerIdentityFromEnv({ ...ENV, WORKER_IDENTITY_SUBJECT: "", BOT_TENANT_ID: undefined }, "SERVICEBUS_NAMESPACE"),
    (e: unknown) =>
      e instanceof WorkerIdentityError &&
      e.message === "SERVICEBUS_NAMESPACE needs the worker identity: set BOT_TENANT_ID, WORKER_IDENTITY_SUBJECT",
  );
  assert.throws(() => workerIdentityFromEnv({ ...ENV, BOT_ASSERTION_ISSUER: "http://x" }, "x"), /https issuer URL/);
});

test("the key is read once at start and must be an rsa key", () => {
  const dir = mkdtempSync(join(tmpdir(), "wi-"));
  try {
    const good = join(dir, "key.pem");
    writeFileSync(good, KEY_PEM);
    assert.equal(readWorkerKey(identity(good)).toString(), KEY_PEM);
    assert.throws(
      () => readWorkerKey(identity(join(dir, "absent.pem"))),
      /BOT_ASSERTION_KEY_FILE cannot be read \(ENOENT\)/,
    );
    const bad = join(dir, "bad.pem");
    writeFileSync(bad, "not a key");
    assert.throws(
      () => readWorkerKey(identity(bad)),
      /^WorkerIdentityError: BOT_ASSERTION_KEY_FILE: the assertion key is not/,
    );
    assert.throws(
      () =>
        readWorkerKey(identity(good), () => {
          throw new Error("no code");
        }),
      /cannot be read \(error\)/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the credential gives azure core tokens per scope and a refusal as an authentication error", async () => {
  const fake = new FakeTeams(new FakeClock(1_800_000_000_000));
  fake.expiresIn = 3599;
  const credential = new FederatedCredential(identity(), KEY_PEM, { clock: fake.clock, fetch: fake.fetch });
  const first = await credential.getToken("https://servicebus.azure.net//.default");
  const again = await credential.getToken(["https://servicebus.azure.net//.default"]);
  fake.entra = [json(401, { error: "invalid_client", error_codes: [700213] })];
  await assert.rejects(
    credential.getToken("https://vault.azure.net/.default"),
    (e: unknown) => e instanceof CredentialAuthenticationError && /AADSTS700213/.test(e.message),
  );
  assert.equal(first.token, "fed-token-1");
  assert.deepEqual(first, again);
  assert.ok(first.expiresOnTimestamp > 1_800_000_000_000 && first.expiresOnTimestamp <= (1_800_000_000 + 3599) * 1000);
  assert.equal(fake.form()["scope"], "https://servicebus.azure.net//.default");
  assert.equal(fake.tokenRequests.length, 2);
  assert.equal(fake.form()["client_id"], ENV.WORKER_IDENTITY_CLIENT_ID);
  assert.equal(await credential.token("https://servicebus.azure.net//.default"), "fed-token-1");
  await assert.rejects(credential.getToken([]), /exactly one scope/);
  await assert.rejects(credential.getToken(["a", "b"]), /exactly one scope/);
  assert.equal(credential.clientId, ENV.WORKER_IDENTITY_CLIENT_ID);
  await credential.close();
});

test("a credential with a key that cannot sign is refused at construction, and other errors pass through", async () => {
  assert.throws(() => new FederatedCredential(identity(), "not a key", { clock: new FakeClock() }), AssertionKeyError);
  const clock = new FakeClock();
  const credential = new FederatedCredential(identity(), KEY_PEM, {
    clock,
    fetch: () => Promise.resolve(json(200, { access_token: "t", expires_in: 60 })),
    url: "https://token.example/",
  });
  assert.equal((await credential.getToken("s")).token, "t");
  const waiting = new FederatedCredential(identity(), KEY_PEM, { clock, fetch: fetchNever });
  const before = new AbortController();
  before.abort(new Error("caller gave up"));
  await assert.rejects(waiting.getToken("s", { abortSignal: before.signal }), /caller gave up/);
  const during = new AbortController();
  const pending = assert.rejects(waiting.getToken("s", { abortSignal: during.signal }), /caller gave up later/);
  await flushMicrotasks();
  during.abort(new Error("caller gave up later"));
  await pending;
  const never = assert.rejects(waiting.getToken("t"), (e: unknown) => {
    return e instanceof CredentialAuthenticationError && /unreachable/.test(e.message);
  });
  await flushMicrotasks(); // the request is out
  await clock.advance(10_000); // Entra ID's own timeout
  await never;
});

const fetchNever = ((_: unknown, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new Error("aborted"));
    });
  })) as typeof fetch;
