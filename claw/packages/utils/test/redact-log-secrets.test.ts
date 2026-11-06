// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * redactLogSecrets: what a log read returned, before a model sees it. Everything redactSecrets masks, and what a log carries that
 * a transcript pass leaves alone: a value written after a credential's name, plain or inside a JSON string, and an armored private
 * key. Names that are not credentials, and switches and placeholders after one that is, stay as they were.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactLogSecrets, redactSecrets } from "../src/security/redact-secrets.js";

// Fake values, made up here: none is a credential anywhere.
const PW = "Hunter2-not-real-pw";
const GH = "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1234";

test("L1 a value after a credential's name is masked, in the shapes a job prints it", () => {
  for (const line of [
    `export DB_PASSWORD=${PW}`,
    `password: ${PW}`,
    `"api_key": "${PW}"`,
    `MYSQL_PWD='${PW}'`,
    `client_secret = ${PW}`,
    `Authorization: Basic ${PW}`,
  ]) {
    const r = redactLogSecrets(`step 3\n${line}\nstep 4`);
    assert.equal(r.text.includes(PW), false, line);
    assert.ok(r.hits >= 1, line);
    assert.match(r.text, /<redacted>/, line);
    assert.match(r.text, /^step 3\n.*\nstep 4$/, `${line}: the rest of the log is kept`);
  }
});

test("L2 inside a JSON string, as a log tool returns its lines", () => {
  const json = JSON.stringify({ lines: [{ message: `config {"token": "${PW}", "user": "alice"}` }, { message: `env GH_TOKEN=${PW}` }] });
  const r = redactLogSecrets(json);
  assert.equal(r.text.includes(PW), false, r.text);
  assert.ok(r.text.includes("alice"), "a value under a name that is not a credential's stays");
  assert.doesNotThrow(() => JSON.parse(r.text), "still JSON");
});

test("L3 an armored private key goes whole, with real line ends or a JSON string's", () => {
  const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAfakefakefake\nZm9vYmFy\n-----END RSA PRIVATE KEY-----`;
  for (const text of [`key:\n${pem}\ndone`, JSON.stringify({ log: `key:\n${pem}\ndone` })]) {
    const r = redactLogSecrets(text);
    assert.equal(r.text.includes("MIIEowIBAAKCAQEAfakefakefake"), false);
    assert.match(r.text, /<redacted private key>/);
    assert.match(r.text, /done/);
  }
});

test("L4 what redactSecrets masks by shape is masked too", () => {
  const r = redactLogSecrets(`cloning with ${GH} from https://bob:${PW}@git.example/r.git`);
  assert.equal(r.text.includes(GH), false);
  assert.equal(r.text.includes(PW), false);
});

test("L5 names that are not credentials, and switches after ones that are, stay", () => {
  for (const line of [
    "max_tokens=4096", "username=alice", "auth: enabled", "password: required", "token=****", "TOKEN_LIMIT_REACHED at step 9",
    "epoch=3 loss=0.42 lr=0.0001", "image=registry.example/team/app:v1.2",
  ]) {
    assert.equal(redactLogSecrets(line).text, line, line);
  }
});

test("L6 the name pass is the log pass's own: redactSecrets leaves a named value in free text alone", () => {
  assert.equal(redactSecrets(`password: ${PW}`).text, `password: ${PW}`);
  assert.equal(redactLogSecrets(`password: ${PW}`).text, "password: <redacted>");
});

test("L7 a name right after a JSON string's escaped line end is a name; one inside another word is not", () => {
  const json = JSON.stringify({ logs: `step 1\ntoken: ${"Hunter2-not-real-pw"}\n\tpassword=${"Hunter2-not-real-pw"}\nmytoken: keep-this-value` });
  const r = redactLogSecrets(json);
  assert.equal(r.text.includes("Hunter2-not-real-pw"), false, r.text);
  assert.ok(r.text.includes("mytoken: keep-this-value"), "a name that only ends in a credential word is judged whole");
});

test("L8 a value with spaces goes whole: quoted to its closing quote, unquoted to its line's end", () => {
  const phrase = "correct horse battery staple";
  for (const [text, want] of [
    [`{"password":"${phrase}"}`, `{"password":"<redacted>"}`],
    [`password: '${phrase}' (from vault)`, `password: '<redacted>' (from vault)`],
    [`export DB_PASSWORD=${phrase}\nnext`, "export DB_PASSWORD=<redacted>\nnext"],
    [`"api_key": "a \\"quoted\\" ${phrase}", "user": "alice"`, `"api_key": "<redacted>", "user": "alice"`],
    [`token: "password=${phrase}" then`, `token: "<redacted>" then`],
  ] as const) {
    assert.equal(redactLogSecrets(text).text, want, text);
  }
  const json = JSON.stringify({ lines: [`config {"token": "${phrase}"}`, `password: ${phrase}`] });
  const r = redactLogSecrets(json);
  for (const word of phrase.split(" ")) assert.equal(r.text.includes(word), false, `${word}: ${r.text}`);
  assert.doesNotThrow(() => JSON.parse(r.text), "still JSON");
});

test("L9 a log of unclosed quotes after credential names costs its length", () => {
  const text = 'password: "x '.repeat(20_000);
  const t0 = performance.now();
  const r = redactLogSecrets(text);
  assert.ok(performance.now() - t0 < 2000, "linear, not quadratic");
  assert.equal(r.text.includes(" x "), false);
});

test("L10 a quote escaped inside a value is part of it, at the top level and inside a JSON string", () => {
  const inner = JSON.stringify({ password: 'part "inside" tail', user: "alice" });
  for (const text of [inner, JSON.stringify({ logs: inner }), JSON.stringify({ lines: [`config ${inner}`] })]) {
    const r = redactLogSecrets(text);
    for (const word of ["part", "inside", "tail"]) assert.equal(r.text.includes(word), false, `${word}: ${r.text}`);
    assert.ok(r.text.includes("alice"), r.text);
    assert.doesNotThrow(() => JSON.parse(r.text), "still JSON");
  }
  // A value that ends in a backslash: its escaped backslash does not escape the closing quote.
  const r = redactLogSecrets(JSON.stringify({ password: "ends in \\", user: "alice" }));
  assert.equal(r.text, '{"password":"<redacted>","user":"alice"}');
});

test("L11 a private key cut before its END line is masked to the end; unmatched BEGIN lines cost the text's length", () => {
  const r = redactLogSecrets("ok\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAfakefakefake\nZm9vYmFy");
  assert.equal(r.text, "ok\n<redacted private key>");
  for (const text of [
    "-----BEGIN RSA PRIVATE KEY-----".repeat(16_000),
    `${"-----BEGIN RSA PRIVATE KEY-----x".repeat(8_000)}-----END EC PRIVATE KEY-----`,
    'password: \\"a\\\\\\" '.repeat(20_000),
    `${'"token": "'}${"\\\\".repeat(100_000)}`,
    "password=no, ".repeat(20_000),
  ]) {
    const t0 = performance.now();
    redactLogSecrets(text);
    assert.ok(performance.now() - t0 < 1500, `${text.slice(0, 40)}: ${Math.round(performance.now() - t0)} ms`);
  }
});

test("L12 a command line's option, a short value and a quoted value after an auth scheme are masked", () => {
  for (const [text, want] of [
    // An unquoted value runs to its line's end: what follows it on the line goes with it.
    ["run --password=Abc123!xyz --epochs 3", "run --password=<redacted>"],
    ["run --api-key=Abc123!xyz", "run --api-key=<redacted>"],
    ["mysql -u root --db-password s3cr3t", "mysql -u root --db-password <redacted>"],
    ["password=abc", "password=<redacted>"],
    ["token: 123", "token: <redacted>"],
    ['Authorization: Bearer "sample-value" sent', 'Authorization: Bearer "<redacted>" sent'],
    ["Authorization: Basic Zm9vOmJhcg==", "Authorization: Basic <redacted>"],
  ] as const) {
    assert.equal(redactLogSecrets(text).text, want, text);
  }
  // An option whose name is not a credential's keeps its value.
  for (const line of ["--epochs 3 --lr 0.1", "--max-tokens 4096", "--tokenizer fast"]) assert.equal(redactLogSecrets(line).text, line, line);
});
