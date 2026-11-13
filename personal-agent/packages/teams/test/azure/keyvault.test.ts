// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Secrets from Azure Key Vault (SECRETS_SOURCE=keyvault) as the worker's own identity. A fake Entra token endpoint and a
 * fake Key Vault behind one injected fetch; waits between tries are recorded, not waited.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SecretsUnavailable, type SecretName, own } from "@primusclaw/personal-agent";
import { ATTEMPTS, KeyVaultSecretSource, keyVaultSourceFromEnv, vaultErrorCode } from "../../src/azure/keyvault.js";
import {
  KEYVAULT_API_VERSION,
  KEYVAULT_SCOPE,
  LEGACY_VAULT_NAMES,
  VAULT_NAMES,
  vaultUrl,
  wanted,
  type Env,
} from "../../src/azure/keyvault-config.js";
import { FederatedCredential, type WorkerIdentity } from "../../src/azure/workload-identity.js";
import { FakeClock } from "../../../../test-support/clock.js";
import { RecordingLogger } from "../../../../test-support/recording-logger.js";
import { settle } from "../connector/fakes.js";

const TENANT = "00000000-0000-0000-0000-0000000000b2";
const ISSUER = "https://oidc.example.com/prod";
const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const SUBJECT = "claw-teams-agent-kv";
const VAULT = "https://personal-agent-test.vault.azure.net";

const pkcs8 = (): string =>
  generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" });
const KEY_PEM = pkcs8();
const APP_KEY_PEM = pkcs8();

// Distinctive values, so a leak into a log line is found by a plain substring search.
const VAULT_VALUES: Readonly<Record<string, string>> = {
  "personal-agent-encryption-keys":
    "VAULTKEY1-fernet-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=,VAULTKEY2-fernet-bbbbbbbbbbbbbbbbbbbb=",
  "personal-agent-exchange-client-secret": "VAULT-exchange-secret-cccccccccccccccc",
  "personal-agent-feedback-github-app-key": APP_KEY_PEM,
};
const ACCESS_TOKEN = "kv-access-token-dddddddddddddddd";

/** One scripted answer: a response (made fresh each time), a network error, or undefined for the normal answer. */
type Answer = (() => Response) | Error | undefined;

const reply =
  (status: number, body?: unknown): (() => Response) =>
  () =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

/** Entra's token endpoint and one Key Vault. Scripts are used in turn, the last repeats. */
class FakeAzure {
  readonly tokenRequests: string[] = [];
  readonly reads: string[] = [];
  readonly authHeaders = new Set<string>();
  entra: Answer[] = [undefined];
  readonly vault = new Map<string, Answer[]>();

  readonly fetch = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "login.microsoftonline.com") {
      this.tokenRequests.push(typeof init?.body === "string" ? init.body : "");
      return FakeAzure.answer(this.entra, this.tokenRequests.length, reply(200, ok()));
    }
    assert.equal(url.hostname, "personal-agent-test.vault.azure.net");
    assert.equal(url.searchParams.get("api-version"), KEYVAULT_API_VERSION);
    const name = url.pathname.replace(/^\/secrets\//, "");
    this.reads.push(name);
    this.authHeaders.add(new Headers(init?.headers).get("authorization") ?? "");
    const stored = own(VAULT_VALUES, name);
    const normal =
      stored === undefined
        ? reply(404, { error: { code: "SecretNotFound", message: `A secret with (name/id) ${name} was not found` } })
        : reply(200, { value: stored, id: `${VAULT}/secrets/${name}/v1` });
    return FakeAzure.answer(this.vault.get(name) ?? [undefined], this.reads.filter((r) => r === name).length, normal);
  }) as typeof fetch;

  private static answer(script: Answer[], n: number, normal: () => Response): Promise<Response> {
    const answer = script[Math.min(n, script.length) - 1];
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve((answer ?? normal)());
  }

  form(i = 0): Record<string, string> {
    return Object.fromEntries(new URLSearchParams(this.tokenRequests[i]));
  }
}

function ok(): unknown {
  return { token_type: "Bearer", expires_in: 3599, access_token: ACCESS_TOKEN };
}

const identity: WorkerIdentity = {
  clientId: CLIENT_ID,
  tenantId: TENANT,
  issuer: ISSUER,
  subject: SUBJECT,
  keyFile: "",
};

function vaultEnv(extra: Env = {}): Env {
  return {
    SECRETS_SOURCE: "keyvault",
    KEYVAULT_URL: VAULT,
    TEAMS_EXCHANGE_ENABLED: "true",
    FEEDBACK_GITHUB_APP_ID: "5504878",
    FEEDBACK_GITHUB_INSTALLATION_ID: "176038282",
    ...extra,
  };
}

interface LoadOptions {
  readonly sleeps?: number[];
  readonly logger?: RecordingLogger;
  readonly clock?: FakeClock;
  readonly deadlineMs?: number;
  /** Wait on the fake clock instead of recording the waits. */
  readonly realSleep?: boolean;
}

function source(fake: FakeAzure, env: Env, options: LoadOptions = {}): KeyVaultSecretSource {
  const clock = options.clock ?? new FakeClock();
  const logger = options.logger ?? new RecordingLogger();
  const sleeps = options.sleeps ?? [];
  const credential = new FederatedCredential(identity, KEY_PEM, { clock, fetch: fake.fetch, logger });
  return new KeyVaultSecretSource(vaultUrl(env), credential, {
    clock,
    fetch: fake.fetch,
    logger,
    env,
    ...(options.realSleep
      ? {}
      : {
          sleep: (ms: number) => {
            sleeps.push(ms / 1000);
            return Promise.resolve();
          },
        }),
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
  });
}

function load(fake: FakeAzure, env: Env, options: LoadOptions = {}): Promise<ReadonlyMap<SecretName, string>> {
  return source(fake, env, options).load(wanted(env));
}

function unavailable(pattern: RegExp | string): (e: unknown) => boolean {
  return (e: unknown) =>
    e instanceof SecretsUnavailable && (typeof pattern === "string" ? e.message === pattern : pattern.test(e.message));
}

// --- reading -----------------------------------------------------------------------------------------------------------

test("keyvault reads every secret the configuration needs with one token for the worker identity", async () => {
  const fake = new FakeAzure();
  const values = await load(fake, vaultEnv());
  assert.deepEqual(
    values,
    new Map([
      ["TEAMS_ENCRYPTION_KEYS", VAULT_VALUES["personal-agent-encryption-keys"]],
      ["TEAMS_EXCHANGE_CLIENT_SECRET", VAULT_VALUES["personal-agent-exchange-client-secret"]],
      ["FEEDBACK_GITHUB_APP_KEY", APP_KEY_PEM.trim()],
    ]),
  );
  assert.deepEqual([...fake.reads].sort(), Object.values(VAULT_NAMES).sort());
  assert.deepEqual(fake.authHeaders, new Set([`Bearer ${ACCESS_TOKEN}`]));
  assert.equal(fake.tokenRequests.length, 1);
  const form = fake.form();
  assert.equal(form["client_id"], CLIENT_ID);
  assert.equal(form["scope"], KEYVAULT_SCOPE);
  assert.equal(form["client_assertion_type"], "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
});

test("only the secrets the configuration uses are read", async () => {
  let fake = new FakeAzure();
  const values = await load(fake, { SECRETS_SOURCE: "keyvault", KEYVAULT_URL: VAULT });
  assert.deepEqual([...values.keys()], ["TEAMS_ENCRYPTION_KEYS"]);
  assert.deepEqual(fake.reads, ["personal-agent-encryption-keys"]);
  fake = new FakeAzure();
  await load(fake, vaultEnv({ FEEDBACK_GITHUB_INSTALLATION_ID: "" })); // the App is not configured: its key is not wanted
  assert.ok(!fake.reads.includes("personal-agent-feedback-github-app-key"));
});

test("an environment value the vault replaces is named in a warning without its value", async () => {
  const logger = new RecordingLogger();
  await load(
    new FakeAzure(),
    vaultEnv({ TEAMS_ENCRYPTION_KEYS: "STALE-env-key", FEEDBACK_GITHUB_KEY_FILE: "/etc/claw-feedback/k.pem" }),
    { logger },
  );
  const warnings = logger.lines.filter((l) => l.level === "warn").map((l) => l.message);
  assert.deepEqual(warnings, [
    "secrets: SECRETS_SOURCE=keyvault, so TEAMS_ENCRYPTION_KEYS, FEEDBACK_GITHUB_KEY_FILE from the environment are ignored",
  ]);
  assert.ok(!logger.dump().includes("STALE"));
  const one = new RecordingLogger();
  await load(new FakeAzure(), vaultEnv({ TEAMS_EXCHANGE_CLIENT_SECRET: "STALE" }), { logger: one });
  assert.deepEqual(
    one.lines.filter((l) => l.level === "warn").map((l) => l.message),
    ["secrets: SECRETS_SOURCE=keyvault, so TEAMS_EXCHANGE_CLIENT_SECRET from the environment is ignored"],
  );
});

// --- failing closed ----------------------------------------------------------------------------------------------------

test("a refused read fails at once naming the secret and the vaults code", async () => {
  const fake = new FakeAzure();
  fake.vault.set("personal-agent-exchange-client-secret", [
    reply(403, {
      error: {
        code: "Forbidden",
        message: "The user, group or application does not have secrets get permission",
        innererror: { code: "AccessDenied" },
      },
    }),
  ]);
  const sleeps: number[] = [];
  await assert.rejects(
    load(fake, vaultEnv(), { sleeps }),
    unavailable(
      "Key Vault secret personal-agent-exchange-client-secret: Key Vault answered 403 (Forbidden: AccessDenied)",
    ),
  );
  assert.equal(fake.reads.filter((r) => r === "personal-agent-exchange-client-secret").length, 1);
  assert.deepEqual(sleeps, []);
});

test("a missing secret fails", async () => {
  // (under its name and under its deprecated name)
  const fake = new FakeAzure();
  fake.vault.set("personal-agent-encryption-keys", [reply(404, { error: { code: "SecretNotFound" } })]);
  await assert.rejects(
    load(fake, vaultEnv()),
    unavailable(
      "Key Vault secret personal-agent-encryption-keys: Key Vault answered 404 (SecretNotFound) " +
        "(nor under its deprecated name clawy-encryption-keys)",
    ),
  );
  assert.deepEqual(fake.reads, ["personal-agent-encryption-keys", "clawy-encryption-keys"]);
});

// --- the names of an earlier release -------------------------------------------------------------------------------------

test("a secret stored under its deprecated name alone is read, with one warning that names both names", async () => {
  const fake = new FakeAzure();
  const old = "VAULT-old-name-eeeeeeeeeeeeeeee";
  fake.vault.set("personal-agent-encryption-keys", [reply(404, { error: { code: "SecretNotFound" } })]);
  fake.vault.set("clawy-encryption-keys", [reply(200, { value: old })]);
  fake.vault.set("personal-agent-exchange-client-secret", [reply(404, { error: { code: "SecretNotFound" } })]);
  fake.vault.set("clawy-exchange-client-secret", [reply(200, { value: old })]);
  const logger = new RecordingLogger();
  const values = await load(fake, vaultEnv(), { logger });
  assert.equal(values.get("TEAMS_ENCRYPTION_KEYS"), old);
  assert.equal(values.get("TEAMS_EXCHANGE_CLIENT_SECRET"), old);
  assert.equal(values.get("FEEDBACK_GITHUB_APP_KEY"), APP_KEY_PEM.trim());
  const warnings = logger.lines.filter((l) => l.level === "warn").map((l) => l.message);
  assert.deepEqual(warnings, [
    "secrets: deprecated Key Vault secret names: clawy-encryption-keys (now personal-agent-encryption-keys), " +
      "clawy-exchange-client-secret (now personal-agent-exchange-client-secret); they are still read when the new name " +
      "is missing; store the secrets under the new names",
  ]);
  assert.ok(!logger.dump().includes(old));
  assert.ok(
    logger
      .dump()
      .includes("(clawy-encryption-keys, clawy-exchange-client-secret, personal-agent-feedback-github-app-key)"),
  );
});

test("the new name wins: the deprecated one is not read when the new one is there", async () => {
  const fake = new FakeAzure();
  fake.vault.set("clawy-encryption-keys", [reply(200, { value: "VAULT-old-name-ffffffffffffffff" })]);
  const logger = new RecordingLogger();
  const values = await load(fake, { SECRETS_SOURCE: "keyvault", KEYVAULT_URL: VAULT }, { logger });
  assert.equal(values.get("TEAMS_ENCRYPTION_KEYS"), VAULT_VALUES["personal-agent-encryption-keys"]);
  assert.deepEqual(fake.reads, ["personal-agent-encryption-keys"]);
  assert.deepEqual(
    logger.lines.filter((l) => l.level === "warn"),
    [],
  );
});

test("only a missing secret falls back: a refused one under the new name stops the start", async () => {
  const fake = new FakeAzure();
  fake.vault.set("personal-agent-encryption-keys", [reply(403, { error: { code: "Forbidden" } })]);
  fake.vault.set("clawy-encryption-keys", [reply(200, { value: "VAULT-old-name-gggggggggggggggg" })]);
  await assert.rejects(
    load(fake, { SECRETS_SOURCE: "keyvault", KEYVAULT_URL: VAULT }),
    unavailable("Key Vault secret personal-agent-encryption-keys: Key Vault answered 403 (Forbidden)"),
  );
  assert.deepEqual(fake.reads, ["personal-agent-encryption-keys"]);
});

test("every secret has a new name and the deprecated name it replaces", () => {
  for (const [name, vault] of Object.entries(VAULT_NAMES)) {
    assert.match(vault, /^personal-agent-[a-z-]+$/);
    assert.equal(own(LEGACY_VAULT_NAMES, name), vault.replace(/^personal-agent-/, "clawy-"));
  }
});

test("an empty secret fails", async () => {
  const fake = new FakeAzure();
  fake.vault.set("personal-agent-encryption-keys", [reply(200, { value: "  " })]);
  await assert.rejects(load(fake, vaultEnv()), unavailable(/personal-agent-encryption-keys is empty/));
});

test("a transient failure is tried again with backoff and then succeeds", async () => {
  const fake = new FakeAzure();
  fake.vault.set("personal-agent-encryption-keys", [reply(503), new TypeError("fetch failed"), reply(429), undefined]);
  const sleeps: number[] = [];
  const values = await load(fake, vaultEnv(), { sleeps });
  assert.equal(values.get("TEAMS_ENCRYPTION_KEYS"), VAULT_VALUES["personal-agent-encryption-keys"]);
  assert.deepEqual(sleeps, [2, 4, 8]);
});

test("a vault that stays down fails after the last try", async () => {
  const fake = new FakeAzure();
  fake.vault.set("personal-agent-encryption-keys", [reply(500)]);
  const sleeps: number[] = [];
  await assert.rejects(
    load(fake, vaultEnv(), { sleeps }),
    unavailable(/personal-agent-encryption-keys: Key Vault answered 500/),
  );
  assert.equal(fake.reads.filter((r) => r === "personal-agent-encryption-keys").length, ATTEMPTS);
  assert.deepEqual(sleeps, [2, 4, 8, 16]);
});

test("a read that runs past the deadline fails", async () => {
  const fake = new FakeAzure();
  fake.vault.set("personal-agent-encryption-keys", [reply(503)]);
  const clock = new FakeClock();
  const work = load(fake, vaultEnv(), { clock, deadlineMs: 50, realSleep: true });
  await assert.rejects(
    settle(clock, work, 10),
    unavailable(/personal-agent-test\.vault\.azure\.net: the secrets were not read within 0\.05s/),
  );
  assert.equal(clock.pending, 0); // no timer or wait is left behind
});

test("entra refusing the identity fails without retrying and reads nothing", async () => {
  const fake = new FakeAzure();
  fake.entra = [reply(400, { error: "invalid_client", error_codes: [70021] })];
  const sleeps: number[] = [];
  await assert.rejects(
    load(fake, vaultEnv(), { sleeps }),
    unavailable(new RegExp(`^no Key Vault token for the worker identity ${CLIENT_ID}: .*AADSTS70021`)),
  );
  assert.deepEqual(fake.reads, []);
  assert.deepEqual(sleeps, []);
  assert.equal(fake.tokenRequests.length, 1);
});

test("entra unreachable is tried again", async () => {
  const fake = new FakeAzure();
  fake.entra = [new TypeError("fetch failed"), reply(503), undefined];
  const sleeps: number[] = [];
  assert.ok((await load(fake, vaultEnv(), { sleeps })).has("TEAMS_ENCRYPTION_KEYS"));
  assert.deepEqual(sleeps, [2, 4]);
});

test("entra that stays unreachable fails after the last try", async () => {
  const fake = new FakeAzure();
  fake.entra = [reply(503)];
  const sleeps: number[] = [];
  await assert.rejects(
    load(fake, vaultEnv(), { sleeps }),
    unavailable(new RegExp(`^no Key Vault token for the worker identity ${CLIENT_ID}: Entra ID answered 503`)),
  );
  assert.equal(fake.tokenRequests.length, ATTEMPTS);
  assert.deepEqual(sleeps, [2, 4, 8, 16]);
});

const CANNOT_WORK: readonly [string, Env, string][] = [
  ["no KEYVAULT_URL", { SECRETS_SOURCE: "keyvault" }, "needs KEYVAULT_URL"],
  ["http", { SECRETS_SOURCE: "keyvault", KEYVAULT_URL: "http://personal-agent.vault.azure.net" }, "needs KEYVAULT_URL"],
  ["not a vault", { SECRETS_SOURCE: "keyvault", KEYVAULT_URL: "https://example.com" }, "needs KEYVAULT_URL"],
  [
    "no worker identity",
    { SECRETS_SOURCE: "keyvault", KEYVAULT_URL: VAULT },
    "needs the worker identity: set WORKER_IDENTITY_CLIENT_ID",
  ],
];

for (const [label, env, message] of CANNOT_WORK) {
  test(`a configuration that cannot work fails: ${label}`, () => {
    assert.throws(() => keyVaultSourceFromEnv(env, { clock: new FakeClock() }), unavailable(new RegExp(message)));
  });
}

test("an unreadable signing key fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "kv-"));
  try {
    const env: Env = {
      SECRETS_SOURCE: "keyvault",
      KEYVAULT_URL: VAULT,
      WORKER_IDENTITY_CLIENT_ID: CLIENT_ID,
      WORKER_IDENTITY_SUBJECT: SUBJECT,
      BOT_TENANT_ID: TENANT,
      BOT_ASSERTION_ISSUER: ISSUER,
      BOT_ASSERTION_KEY_FILE: join(dir, "absent.pem"),
    };
    const clock = new FakeClock();
    assert.throws(() => keyVaultSourceFromEnv(env, { clock }), unavailable(/BOT_ASSERTION_KEY_FILE cannot be read/));
    writeFileSync(join(dir, "bad.pem"), "not a key");
    assert.throws(
      () => keyVaultSourceFromEnv({ ...env, BOT_ASSERTION_KEY_FILE: join(dir, "bad.pem") }, { clock }),
      unavailable(/BOT_ASSERTION_KEY_FILE: the assertion key is not/),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the source from the environment reads as the worker identity with the key from its file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kv-"));
  try {
    writeFileSync(join(dir, "key.pem"), KEY_PEM);
    const fake = new FakeAzure();
    const env = vaultEnv({
      KEYVAULT_URL: `${VAULT}/`,
      WORKER_IDENTITY_CLIENT_ID: CLIENT_ID,
      WORKER_IDENTITY_SUBJECT: SUBJECT,
      BOT_TENANT_ID: TENANT,
      BOT_ASSERTION_ISSUER: `${ISSUER}/`,
      BOT_ASSERTION_KEY_FILE: join(dir, "key.pem"),
    });
    const kv = keyVaultSourceFromEnv(env, { clock: new FakeClock(), fetch: fake.fetch, logger: new RecordingLogger() });
    assert.equal(kv.name, "keyvault");
    assert.equal(kv.url, VAULT);
    assert.equal((await kv.load(["TEAMS_ENCRYPTION_KEYS"])).size, 1);
    assert.equal(fake.form()["client_id"], CLIENT_ID);
    const elsewhere = new FakeAzure();
    const other = keyVaultSourceFromEnv(env, {
      clock: new FakeClock(),
      fetch: elsewhere.fetch,
      tokenUrl: "https://login.microsoftonline.com/elsewhere/token",
    });
    await other.load([]);
    assert.equal(elsewhere.tokenRequests.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- nothing secret in the log -----------------------------------------------------------------------------------------

test("no secret value token or assertion reaches any log line", async () => {
  const logger = new RecordingLogger();
  const first = new FakeAzure();
  first.vault.set("personal-agent-exchange-client-secret", [reply(503), undefined]);
  await load(first, vaultEnv(), { logger });
  const second = new FakeAzure();
  second.vault.set("personal-agent-feedback-github-app-key", [reply(403, { error: { code: "Forbidden" } })]);
  await assert.rejects(load(second, vaultEnv(), { logger }), SecretsUnavailable);
  const assertions = [first, second].flatMap((f) => f.tokenRequests.map((_, i) => f.form(i)["client_assertion"] ?? ""));
  assert.equal(assertions.length, 2);
  const text = logger.dump();
  for (const secret of [...Object.values(VAULT_VALUES), ACCESS_TOKEN, ...assertions, "BEGIN PRIVATE KEY"]) {
    assert.ok(secret && !text.includes(secret));
  }
  assert.ok(text.includes("secrets: 3 read from Key Vault personal-agent-test.vault.azure.net"));
  assert.ok(text.includes("attempt 1 of 5 failed (Key Vault answered 503); trying again"));
});

// --- the parts ---------------------------------------------------------------------------------------------------------

test("the vault's error code is shown only from the expected shape", () => {
  assert.equal(
    vaultErrorCode('{"error": {"code": "Forbidden", "innererror": {"code": "AccessDenied"}}}'),
    " (Forbidden: AccessDenied)",
  );
  assert.equal(vaultErrorCode('{"error": {"innererror": {"code": 7}}}'), " (7)");
  assert.equal(vaultErrorCode(JSON.stringify({ error: { code: "x".repeat(70) } })), ` (${"x".repeat(60)})`);
  for (const text of [
    "",
    "not json",
    "[1]",
    '{"error": "denied"}',
    '{"error": [1]}',
    '{"error": {"innererror": "x"}}',
  ]) {
    assert.equal(vaultErrorCode(text), "", text);
  }
  assert.equal(vaultErrorCode('{"error": null}'), "");
  assert.equal(vaultErrorCode('{"error": {"code": "", "innererror": {}}}'), "");
});

test("an answer that is not json or has no string value is an empty secret", async () => {
  for (const answer of [() => new Response("not json", { status: 200 }), reply(200, { value: 5 }), reply(200, [])]) {
    const fake = new FakeAzure();
    fake.vault.set("personal-agent-encryption-keys", [answer]);
    await assert.rejects(
      load(fake, { SECRETS_SOURCE: "keyvault", KEYVAULT_URL: VAULT }),
      unavailable("Key Vault secret personal-agent-encryption-keys is empty or has no value"),
    );
  }
});

test("a redirect is a refusal, not followed and not retried", async () => {
  const fake = new FakeAzure();
  fake.vault.set("personal-agent-encryption-keys", [
    () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }),
  ]);
  const sleeps: number[] = [];
  await assert.rejects(
    load(fake, { SECRETS_SOURCE: "keyvault", KEYVAULT_URL: VAULT }, { sleeps }),
    unavailable("Key Vault secret personal-agent-encryption-keys: Key Vault answered 302"),
  );
  assert.deepEqual(sleeps, []);
});

test("a credential failure that is not a token error passes through", async () => {
  const kv = new KeyVaultSecretSource(
    VAULT,
    { clientId: CLIENT_ID, token: () => Promise.reject(new RangeError("bug")) },
    { clock: new FakeClock() },
  );
  await assert.rejects(kv.load(["TEAMS_ENCRYPTION_KEYS"]), RangeError);
});

test("the vault address must be https on a vault host with nothing after the host", () => {
  assert.equal(vaultUrl({ KEYVAULT_URL: " https://a.vault.azure.net/ " }), "https://a.vault.azure.net");
  assert.equal(vaultUrl({ KEYVAULT_URL: "HTTPS://A.Vault.Azure.NET:443" }), "HTTPS://A.Vault.Azure.NET:443");
  for (const bad of [
    "https://a.vault.azure.net/secrets",
    "https://a.vault.azure.net?x=1",
    "https://a.vault.azure.net.example.com",
    "https://user@[::1]",
    "a.vault.azure.net",
    "",
  ]) {
    assert.throws(() => vaultUrl({ KEYVAULT_URL: bad }), unavailable(/needs KEYVAULT_URL/), bad);
  }
});

test("the wanted secrets follow the exchange switch and the feedback app", () => {
  assert.deepEqual(wanted({}), ["TEAMS_ENCRYPTION_KEYS"]);
  assert.deepEqual(wanted({ TEAMS_EXCHANGE_ENABLED: " ON ", FEEDBACK_GITHUB_APP_ID: "1" }), [
    "TEAMS_ENCRYPTION_KEYS",
    "TEAMS_EXCHANGE_CLIENT_SECRET",
  ]);
  assert.deepEqual(
    wanted({ TEAMS_EXCHANGE_ENABLED: "off", FEEDBACK_GITHUB_APP_ID: "1", FEEDBACK_GITHUB_INSTALLATION_ID: "2" }),
    ["TEAMS_ENCRYPTION_KEYS", "FEEDBACK_GITHUB_APP_KEY"],
  );
});

test("the exchange switch is read under its PA_ name first, its TEAMS_ name still read", () => {
  assert.deepEqual(wanted({ PA_EXCHANGE_ENABLED: "1" }), ["TEAMS_ENCRYPTION_KEYS", "TEAMS_EXCHANGE_CLIENT_SECRET"]);
  assert.deepEqual(wanted({ PA_EXCHANGE_ENABLED: "off", TEAMS_EXCHANGE_ENABLED: "on" }), ["TEAMS_ENCRYPTION_KEYS"]);
  assert.deepEqual(wanted({ PA_EXCHANGE_ENABLED: " ", TEAMS_EXCHANGE_ENABLED: "on" }), [
    "TEAMS_ENCRYPTION_KEYS",
    "TEAMS_EXCHANGE_CLIENT_SECRET",
  ]);
});

test("with keyvault an environment secret under either name is said to be ignored", async () => {
  const logger = new RecordingLogger();
  await load(new FakeAzure(), vaultEnv({ PA_ENCRYPTION_KEYS: "STALE-a", TEAMS_ENCRYPTION_KEYS: "STALE-b" }), {
    logger,
  });
  assert.deepEqual(
    logger.lines.filter((l) => l.level === "warn").map((l) => l.message),
    ["secrets: SECRETS_SOURCE=keyvault, so PA_ENCRYPTION_KEYS, TEAMS_ENCRYPTION_KEYS from the environment are ignored"],
  );
  assert.ok(!logger.dump().includes("STALE"));
});
