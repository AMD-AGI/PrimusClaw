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

test("L13 a private key whose BEGIN line the tail cut off is masked from its first base64 line to its END line", () => {
  const body = ["MIIEowIBAAKCAQEAfakefakefakefakefakefakefakefakefakefakefakefake1", "MIIEowIBAAKCAQEAfakefakefakefakefakefakefakefakefakefakefakefake2"];
  const tail = `${body.join("\n")}\n-----END RSA PRIVATE KEY-----\nok`;
  assert.equal(redactLogSecrets(tail).text, "<redacted private key>\nok");
  // Inside a JSON answer: what stands before the key on its line is kept, and the answer is still JSON.
  const json = redactLogSecrets(JSON.stringify({ logs: tail })).text;
  assert.equal(json, JSON.stringify({ logs: "<redacted private key>\nok" }));
  // Lines a log prefixes (a timestamp), a short last line, an OpenPGP key's armor; what is above the key stays.
  const stamped = [
    "2026-11-06T16:00:00Z starting job", ...body.map((l) => `2026-11-06T16:00:01Z ${l}`), "2026-11-06T16:00:01Z Zm9v=",
    "2026-11-06T16:00:01Z -----END OPENSSH PRIVATE KEY-----", "2026-11-06T16:00:02Z done",
  ].join("\n");
  const r = redactLogSecrets(stamped).text;
  for (const l of [...body, "Zm9v="]) assert.equal(r.includes(l), false, `${l}: ${r}`);
  assert.ok(r.startsWith("2026-11-06T16:00:00Z starting job\n2026-11-06T16:00:01Z <redacted private key>"), r);
  assert.ok(r.endsWith("\n2026-11-06T16:00:02Z done"), r);
  const pgp = redactLogSecrets(`lQOYBGfakefakefakefakefakefakefake\n=AbCd\n-----END PGP PRIVATE KEY BLOCK-----\nok`).text;
  assert.equal(pgp, "<redacted private key>\nok");
  // An END line with nothing that reads as a key above it: nothing before it is kept, rather than a key's body.
  assert.equal(redactLogSecrets("a line, then: !\n-----END EC PRIVATE KEY-----\nok").text, "<redacted private key>\nok");
  // A whole key after one cut at its start: each is masked, and what is between them stays.
  const both = redactLogSecrets(`${body[0]}\n-----END RSA PRIVATE KEY-----\nbetween\n-----BEGIN EC PRIVATE KEY-----\nZm9vYmFy\n-----END EC PRIVATE KEY-----\nafter`).text;
  assert.equal(both, "<redacted private key>\nbetween\n<redacted private key>\nafter");
  // Many END lines and long lines before them still cost the text's length.
  for (const text of ["-----END RSA PRIVATE KEY-----".repeat(16_000), `${"a ".repeat(100_000)}\n-----END RSA PRIVATE KEY-----`, `${"x".repeat(200_000)}-----END RSA PRIVATE KEY-----`]) {
    const t0 = performance.now();
    redactLogSecrets(text);
    assert.ok(performance.now() - t0 < 1500, `${text.slice(0, 40)}: ${Math.round(performance.now() - t0)} ms`);
  }
});

test("L14 an assignment line's value runs to the line's end, whatever separators the password holds", () => {
  for (const [text, want] of [
    ["export DB_PASSWORD=Xy7&kLm9\nnext", "export DB_PASSWORD=<redacted>\nnext"],
    ["PASSWORD=abc;def&ghi\nnext", "PASSWORD=<redacted>\nnext"],
    ["password=<hunter2>", "password=<redacted>"],
    ["  DB_PASSWORD=a,b)c]d}e'f\"g", "  DB_PASSWORD=<redacted>"],
    ["declare -x API_TOKEN=p&q=r", "declare -x API_TOKEN=<redacted>"],
    ["ENV DB_PASSWORD=x;y", "ENV DB_PASSWORD=<redacted>"],
    ["password: Xy7&kLm9 # from vault", "password: <redacted>"],
  ] as const) {
    assert.equal(redactLogSecrets(text).text, want, text);
  }
  // Inside a JSON string: to the line's end there, or to the string's closing quote; the answer stays JSON.
  const json = JSON.stringify({ logs: 'step 1\nDB_PASSWORD=Xy7&kLm9;"q"\nPASSWORD=last&one' });
  const r = redactLogSecrets(json).text;
  assert.equal(r, JSON.stringify({ logs: "step 1\nDB_PASSWORD=<redacted>\nPASSWORD=<redacted>" }));
  // The first line of a log inside a JSON answer, after the string opens: an assignment line too, to the string's closing quote.
  for (const [text, want] of [
    [JSON.stringify({ logs: "export DB_PASSWORD=MyPass&region=secret" }), JSON.stringify({ logs: "export DB_PASSWORD=<redacted>" })],
    [JSON.stringify({ lines: ["DB_PASSWORD=a&b=c;d", "ok"] }), JSON.stringify({ lines: ["DB_PASSWORD=<redacted>", "ok"] })],
    [JSON.stringify({ logs: JSON.stringify({ msg: "DB_PASSWORD=a&b=c" }) }), JSON.stringify({ logs: JSON.stringify({ msg: "DB_PASSWORD=<redacted>" }) })],
    ['config: "PASSWORD=a&b=c" next', 'config: "PASSWORD=<redacted>" next'],
  ] as const) {
    assert.equal(redactLogSecrets(text).text, want, text);
  }
});

test("L15 off an assignment line a separator or a bracket ends a value only where the text makes it one", () => {
  for (const [text, want] of [
    // Another pair follows: a query string, a map's next entry, a cookie's attribute.
    ["GET /cb?code=1&access_token=Xy7&page=2 200", "GET /cb?code=1&access_token=<redacted>&page=2 200"],
    ["config {password=Xy7, user=alice}", "config {password=<redacted>, user=alice}"],
    ["X-Trace: a=1; token=abc; Path=/", "X-Trace: a=1; token=<redacted>; Path=/"],
    // An opener before the name closes after the value.
    ["connect(host=db, password=Xy7&k)", "connect(host=db, password=<redacted>)"],
    // Otherwise they are the value's.
    ["job 3: export DB_PASSWORD=Xy7&kLm9", "job 3: export DB_PASSWORD=<redacted>"],
    ["[pod/a] PASSWORD=abc;def&ghi", "[pod/a] PASSWORD=<redacted>"],
    ["got password=<hunter2> from env", "got password=<redacted>"],
    ["got password=ab)c,d done", "got password=<redacted>"],
  ] as const) {
    assert.equal(redactLogSecrets(text).text, want, text);
  }
  const json = JSON.stringify({ logs: "2026-11-06T16:00:00Z DB_PASSWORD=Xy7&kLm9;x\nok" });
  assert.equal(redactLogSecrets(json).text, JSON.stringify({ logs: "2026-11-06T16:00:00Z DB_PASSWORD=<redacted>\nok" }));
  for (const text of ["a=1&password=x&".repeat(20_000), `password=${"(&".repeat(50_000)}`, `(${"password=x) ".repeat(20_000)}`]) {
    const t0 = performance.now();
    redactLogSecrets(text);
    assert.ok(performance.now() - t0 < 1500, `${text.slice(0, 40)}: ${Math.round(performance.now() - t0)} ms`);
  }
});

test("L16 a Kubernetes environment variable named like a credential, as a spec dump prints it", () => {
  const spec = { env: [{ name: "DB_PASSWORD", value: "Xy7&kLm9 not real" }, { name: "LOG_LEVEL", value: "debug" }] };
  for (const text of [JSON.stringify(spec), JSON.stringify(spec, null, 2), JSON.stringify({ logs: `spec: ${JSON.stringify(spec, null, 2)}` })]) {
    const r = redactLogSecrets(text).text;
    assert.equal(r.includes("Xy7"), false, r);
    assert.ok(r.includes("debug"), r);
    assert.doesNotThrow(() => JSON.parse(r));
  }
  const yaml = "env:\n- name: DB_PASSWORD\n  value: Xy7&kLm9\n- name: LOG_LEVEL\n  value: debug\n  - name: \"API_TOKEN\"\n    value: 'p q r'";
  assert.equal(redactLogSecrets(yaml).text, "env:\n- name: DB_PASSWORD\n  value: <redacted>\n- name: LOG_LEVEL\n  value: debug\n  - name: \"API_TOKEN\"\n    value: '<redacted>'");
  const inJson = redactLogSecrets(JSON.stringify({ logs: yaml })).text;
  assert.equal(inJson.includes("Xy7") || inJson.includes("p q r"), false, inJson);
  assert.doesNotThrow(() => JSON.parse(inJson));
});
