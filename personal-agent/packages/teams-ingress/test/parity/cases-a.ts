// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The parity cases of the messaging endpoint: activities, bodies, the Authorization header and the token. */
import { APP, CONV, type Kit, SU } from "./kit.js";

export function part1(k: Kit): void {
  // --- activities a valid token carries -------------------------------------------------------------------------
  k.http("message", k.message());
  k.http("message without x-correlation-id", k.message(), k.bearer(k.tok()));
  const last = k.cases.at(-1);
  if (last) last.headers = k.bearer(k.tok());
  k.http("message, bearer in lower case", k.message(), { Authorization: `bearer ${k.tok()}` });
  k.http("message, BEARER in upper case", k.message(), { Authorization: `BEARER ${k.tok()}` });
  k.http("conversationUpdate without a conversation", { type: "conversationUpdate", serviceUrl: SU });
  k.http("installationUpdate", { type: "installationUpdate", serviceUrl: SU, conversation: CONV, id: "i9" });
  k.http("messageReaction", { type: "messageReaction", serviceUrl: SU, conversation: CONV, id: "r1" });
  k.http("typing", { type: "typing", serviceUrl: SU, conversation: CONV });
  k.http("type missing", { serviceUrl: SU, conversation: CONV, id: "x" });
  k.http("type a number", { type: 5, serviceUrl: SU, conversation: CONV });
  k.http("feedback invoke", {
    type: "invoke",
    name: "message/submitAction",
    id: "f1",
    replyToId: "answer-1",
    serviceUrl: SU,
    conversation: CONV,
    value: { actionName: "feedback", actionValue: { reaction: "like", feedback: '{"feedbackText": ""}' } },
  });
  k.http("card action invoke", {
    type: "invoke",
    name: "adaptiveCard/action",
    id: "c1",
    serviceUrl: SU,
    conversation: CONV,
    value: { action: { verb: "primusclaw.feedback" } },
  });
  for (const name of [
    "composeExtension/query",
    "composeExtension/submitAction",
    "task/fetch",
    "task/submit",
    "message/fetchTask",
    "signin/verifyState",
    "",
  ]) {
    k.http(`other invoke ${name || "(empty name)"}`, {
      type: "invoke",
      name,
      id: "i1",
      serviceUrl: SU,
      conversation: CONV,
    });
  }
  k.http("other invoke with a line break in its name", {
    type: "invoke",
    name: "task/fetch\nINFO forged",
    id: "i1",
    serviceUrl: SU,
    conversation: CONV,
  });
  k.http("invoke without a name", { type: "invoke", id: "i1", serviceUrl: SU, conversation: CONV });
  k.http("invoke name a number", { type: "invoke", name: 7, id: "i1", serviceUrl: SU, conversation: CONV });
}

export function part2(k: Kit): void {
  k.http("invoke name a list (unhashable)", { type: "invoke", name: ["x"], serviceUrl: SU, conversation: CONV });
  k.http("invoke name a dict (unhashable)", { type: "invoke", name: { a: 1 }, serviceUrl: SU, conversation: CONV });
  k.http("invoke name an empty list", { type: "invoke", name: [], serviceUrl: SU, conversation: CONV });
  k.http("message name a list", k.message({ name: ["x"] }));
  k.http("long conversation id", k.message({ conversation: { id: `a:${"x".repeat(160)}` }, id: "m".repeat(200) }));
  k.http("conversation id of 128 characters", k.message({ conversation: { id: "c".repeat(128) } }));
  k.http("conversation id of 129 characters", k.message({ conversation: { id: "c".repeat(129) } }));
  k.http("conversation id of 100 astral characters", k.message({ conversation: { id: "\u{1F600}".repeat(60) } }));
  k.http("conversation id a number", k.message({ conversation: { id: 12345 } }));
  k.http("conversation id a float", k.message({ conversation: { id: 1.5 } }));
  k.http("conversation id true", k.message({ conversation: { id: true } }));
  k.http("conversation id empty", k.message({ conversation: { id: "" } }));
  k.http("conversation id a list", k.message({ conversation: { id: ["a", "b'c"] } }));
  k.http("conversation a string", k.message({ conversation: "19:abc" }));
  k.http("conversation a list", k.message({ conversation: [1] }));
  k.http("conversation empty string", k.message({ conversation: "" }));
  k.http("conversation null", k.message({ conversation: null }));
  k.http("activity id a number", k.message({ id: 42 }));
  k.http("activity id zero", k.message({ id: 0 }));
  k.http("activity id empty", k.message({ id: "" }));
  k.http("activity id false", k.message({ id: false }));
  k.http("activity id null", k.message({ id: null }));
  k.http("unicode text", k.message({ text: 'héllo — 你好 \u{1F600} \u0000 \u007f   "q" \\ /' }));
  k.http("integer-like keys keep document order", k.message({ value: { b: 1, "10": 2, "2": 3, a: { "1": [] } } }));
  k.http(
    "floats and big integers",
    k.message({ value: [1.0, 1.5, 1e16, 1e-7, 0.1, -0.0, Number("12345678901234567890"), Number("1e400"), 2.5e-5] }),
  );
  k.http(
    "body: NaN literal",
    Buffer.from(
      `{"type": "message", "id": "a1", "serviceUrl": "${SU}", "conversation": {"id": "c"}, "v": [NaN, Infinity, -Infinity]}`,
    ),
  );
  k.http(
    "duplicate keys",
    Buffer.from(
      `{"type": "message", "id": "a1", "id": "a2", "serviceUrl": "${SU}", "conversation": {"id": "c"}, "type": "message"}`,
    ),
  );
  k.http(
    "escaped surrogates and escapes",
    Buffer.from(
      `{"type": "message", "serviceUrl": "${SU}", "conversation": {"id": "c"}, "t": "\\ud83d\\ude00 \\ud800 x \\udc00 \\u00e9 \\/ \\b\\f\\n\\r\\t"}`,
    ),
  );
  k.http("whitespace around the document", Buffer.from(` \r\n\t${JSON.stringify(k.message())}\n `));
  k.http(
    "nested 1000 deep",
    Buffer.from(
      `{"type": "message", "serviceUrl": "${SU}", "conversation": {"id": "c"}, "v": ${"[".repeat(1000)}${"]".repeat(1000)}}`,
    ),
  );
  k.http("nested 200000 deep", Buffer.from(`${"[".repeat(200000)}${"]".repeat(200000)}`));
  k.http("a 1 MiB activity", k.message({ text: "x".repeat(1024 * 1024) }));
}

export function part3(k: Kit): void {
  k.http(
    "activity with __proto__ and constructor keys",
    Buffer.from(
      `{"type": "message", "serviceUrl": "${SU}", "conversation": {"id": "c", "__proto__": {"id": "p"}}, "constructor": 1, "__proto__": 2}`,
    ),
  );
  // --- bodies that are not an activity ----------------------------------------------------------------------------
  for (const body of ["", "not json", "[1, 2]", '"text"', "null", "1", "{", "{}x", "[]", "true", '{"a": 1,}', "ÿ"]) {
    k.http(`not an activity, valid token: ${JSON.stringify(body)}`, Buffer.from(body));
    k.http(`not an activity, no token: ${JSON.stringify(body)}`, Buffer.from(body), {});
  }
  k.http("not an activity, bad token", Buffer.from("not json"), k.bearer(k.tok({ aud: "someone-elses-bot" })));
  k.http("not an activity, expired token", Buffer.from("not json"), k.bearer(k.tok({ exp: 1 })));
  k.http("body: invalid UTF-8", Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
  k.http("body: UTF-8 BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(k.message()))]));
  k.http("body: UTF-16", Buffer.from(JSON.stringify(k.message()), "utf16le"));
  k.http("empty dict", {});
  // --- the Authorization header -----------------------------------------------------------------------------------
  for (const [name, header] of [
    ["no header", null],
    ["empty header", ""],
    ["Basic", "Basic abc"],
    ["Bearer alone", "Bearer"],
    ["token alone", "token"],
    ["Bearer, nothing after the space", "Bearer"],
    ["garbage after Bearer", "Bearer not.a.jwt"],
    ["one segment", "Bearer abc"],
    ["four segments", `Bearer ${k.tok()}.x`],
    ["two spaces", `Bearer  ${k.tok()}`],
    ["tab inside", `Bearer\t${k.tok()}`],
  ] as const) {
    k.http(`header: ${name}`, k.message(), header === null ? {} : { Authorization: header });
  }
  k.t("valid", k.tok());
  k.t("another audience", k.tok({ aud: "someone-elses-bot" }));
  k.t("audience a list with ours", k.tok({ aud: ["x", APP] }));
  k.t("audience a list without ours", k.tok({ aud: ["x", "y"] }));
  k.t("audience a list with a number", k.tok({ aud: [APP, 1] }));
  k.t("audience empty", k.tok({ aud: "" }));
  k.t("audience empty list", k.tok({ aud: [] }));
  k.t("audience a number", k.tok({ aud: 5 }));
  for (const issuer of [
    "https://sts.windows.net/tenant/",
    "https://login.microsoftonline.com/t/v2.0",
    "https://api.botframework.com.evil.com",
    "",
    5,
  ]) {
    k.t(`issuer ${JSON.stringify(issuer)}`, k.tok({ iss: issuer }));
  }
  k.t("expired", k.tok({ exp: k.now() - 60 }));
  k.t("exp 1", k.tok({ exp: 1 }));
  k.t("exp a string number", k.tok({ exp: String(k.now() + 600) }));
  k.t("exp a padded string", k.tok({ exp: ` ${String(k.now() + 600)} ` }));
  k.t("exp with underscores", k.tok({ exp: "9_999_999_999" }));
}

export function part4(k: Kit): void {
  k.t("exp a float", k.tok({ exp: k.now() + 600.5 }));
  k.t("exp true", k.tok({ exp: true }));
  k.t("exp a word", k.tok({ exp: "soon" }));
  k.t("exp a list", k.tok({ exp: [1] }));
  k.t("exp a dict", k.tok({ exp: { a: 1 } }));
  k.t("nbf in the future", k.tok({ nbf: k.now() + 3600 }));
  k.t("nbf in the past", k.tok({ nbf: k.now() - 10 }));
  k.t("nbf a word", k.tok({ nbf: "x" }));
  k.t("iat in the future", k.tok({ iat: k.now() + 3600 }));
  k.t("iat a word", k.tok({ iat: "x" }));
  k.t("iat explicitly null", k.jwtWith({ ...k.claims(), iat: null }));
  k.t("sub a number", k.tok({ sub: 5 }));
  k.t("jti a list", k.tok({ jti: [1] }));
  for (const missing of ["exp", "iss", "aud"]) k.t(`missing ${missing}`, k.tok({ [missing]: null }));
  k.t("exp null", k.jwtWith({ ...k.claims(), exp: null }));
  k.t("signed by another key", k.tok({}, { key: k.keys.otherKey }));
  k.t("unsigned (alg none)", k.tok({}, { alg: "none" }));
  k.t("HS256 with the public key as secret", k.tok({}, { alg: "HS256" }));
  k.t("alg RS512", k.jwtWith(k.claims(), { header: { alg: "RS512" } }));
  k.t("alg missing", k.jwtWith(k.claims(), { header: { alg: null } }));
  k.t("alg a list", k.jwtWith(k.claims(), { header: { alg: ["RS256"] } }));
  k.t("kid missing", k.jwtWith(k.claims(), { header: { kid: null } }));
  k.t("kid unknown", k.jwtWith(k.claims(), { header: { kid: "nope" } }));
  k.t("kid a number", k.jwtWith(k.claims(), { header: { kid: 5 } }));
  k.t("crit b64", k.jwtWith(k.claims(), { header: { crit: ["b64"], b64: true } }));
  k.t("crit unknown", k.jwtWith(k.claims(), { header: { crit: ["exp"] } }));
  k.t("crit empty", k.jwtWith(k.claims(), { header: { crit: [] } }));
  k.t("b64 false", k.jwtWith(k.claims(), { header: { crit: ["b64"], b64: false } }));
  k.t("header not JSON", `${k.keys.b64url("nope")}.${k.keys.b64url(JSON.stringify(k.claims()))}.c2ln`);
  k.t("header a list", `${k.keys.b64url("[1]")}.${k.keys.b64url(JSON.stringify(k.claims()))}.c2ln`);
  k.t("payload not JSON (signed)", k.jwtWith("nope"));
  k.t("payload a list (signed)", k.jwtWith("[1, 2]"));
  k.t(
    "header padded with =",
    (() => {
      const token = k.tok();
      const [h, p, s] = token.split(".");
      return `${h ?? ""}${"=".repeat((4 - ((h ?? "").length % 4)) % 4)}.${p ?? ""}.${s ?? ""}`;
    })(),
  );
  k.t("signature with a + (not base64url)", k.tok().replace(/.$/, "+"));
  k.t("signature truncated", k.tok().slice(0, -5));
  k.t("serviceurl claim missing", k.tok({ serviceurl: null }));
  k.t("serviceurl claim empty", k.tok({ serviceurl: "" }));
  k.t("serviceurl claim a number", k.tok({ serviceurl: 42 }));
  k.t("serviceurl claim a list", k.tok({ serviceurl: [SU] }));
  k.t("camel-case serviceUrl claim matching", k.tok({ serviceurl: null, serviceUrl: SU }));
  k.t(
    "camel-case serviceUrl claim not matching",
    k.tok({ serviceurl: null, serviceUrl: "https://other.example.com/" }),
  );
  k.t("claim without the trailing slash", k.tok({ serviceurl: SU.replace(/\/$/, "") }));
  k.t("activity without the trailing slash", k.tok(), undefined, k.message({ serviceUrl: SU.replace(/\/$/, "") }));
  for (const serviceUrl of [null, "", 42, { url: SU }, ["x"]]) {
    k.t(`activity serviceUrl ${JSON.stringify(serviceUrl)}`, k.tok(), undefined, k.message({ serviceUrl }));
  }
  k.t("activity without serviceUrl", k.tok(), undefined, { type: "message", id: "a1", conversation: CONV });
  k.t("claim and activity differ", k.tok({ serviceurl: "https://evil.example.com/" }), undefined, k.message());
}

export function part5(k: Kit): void {
  for (const serviceUrl of [
    "https://attacker.trafficmanager.net/teams/",
    "https://evil.example.com/",
    "https://smba.trafficmanager.net.evil.com/teams/",
    "https://evilbotframework.com/",
    "http://smba.trafficmanager.net/teams/",
    "https://smba.trafficmanager.net:8443/teams/",
    "https://smba.trafficmanager.net:notaport/teams/",
    "https://smba.trafficmanager.net:99999/teams/",
    "https://smba.trafficmanager.net:/teams/",
    "https://smba.trafficmanager.net:443/teams/",
    "https://user:pw@smba.trafficmanager.net/teams/",
    "https://user@smba.trafficmanager.net/teams/",
    "https://@smba.trafficmanager.net/teams/",
    "https://:@smba.trafficmanager.net/teams/",
    "https://smba.trafficmanager.net/emea/",
    "https://webchat.botframework.com/",
    "https://smba.infra.gov.teams.microsoft.us/gcch",
    "https://SMBA.trafficmanager.net/teams/",
    "HTTPS://smba.trafficmanager.net/teams/",
    "https://smba.trafficmanager.net./teams/",
    "https://[v1.x.botframework.com]/",
    "https://[::1]/",
    "https://[1.2.3.4]/",
    "https://[smba.trafficmanager.net]/",
    "https://smba.trafficmanager.net]/",
    "https://smba.trafficmanager.net\t/teams/",
    " https://smba.trafficmanager.net/teams/",
    "https://smba.trafficmanager.net/teams/ ",
    "https://ｓｍｂａ.trafficmanager.net/",
    "https://smba.trafficmanager.net℀x/",
    "//smba.trafficmanager.net/teams/",
    "https:smba.trafficmanager.net/teams/",
    "https://xn--botframework-.botframework.com/",
    "https://a.b.botframework.us/",
    "https://teams.microsoft.com/",
    "https://x.teams.microsoft.com/?q=1#f",
  ]) {
    k.t(
      `serviceUrl ${JSON.stringify(serviceUrl)}`,
      k.tok({ serviceurl: serviceUrl }),
      undefined,
      k.message({ serviceUrl }),
    );
  }
  k.t("metadata unreachable (500)", k.tok(), k.keyEnv("openid500"));
  k.t("metadata without jwks_uri", k.tok(), k.keyEnv("openidNoUri"));
  k.t("JWKS unreachable (500)", k.tok(), k.keyEnv("jwks500"));
  k.t("JWKS redirects", k.tok(), k.keyEnv("jwksRedirect"));
  k.t("JWKS empty", k.tok(), k.keyEnv("jwksEmpty"));
  k.t("JWKS not JSON", k.tok(), k.keyEnv("jwksNotJson"));
  k.t("JWKS key for encryption only", k.tok(), k.keyEnv("jwksEnc"));
  k.t("JWKS with two keys", k.tok(), k.keyEnv("jwksTwo"));
  k.t(
    "JWKS with two keys, token of the other",
    k.jwtWith(k.claims(), { key: k.keys.otherKey, header: { kid: "k2" } }),
    k.keyEnv("jwksTwo"),
  );
  k.t("JWKS of EC and oct keys", k.tok(), k.keyEnv("jwksForeign"));
  k.t(
    "JWKS of EC and oct keys, kid of the oct key",
    k.jwtWith(k.claims(), { header: { kid: "k3" } }),
    k.keyEnv("jwksForeign"),
  );
}

export function part6(k: Kit): void {
  k.t("app id unset", k.tok(), { ...k.httpEnv, PRIMUSCLAW_BOT_APP_ID: "" });
  k.t("issuers widened, token of the second", k.tok({ iss: "https://sts.example.com/" }), {
    ...k.httpEnv,
    BOT_TOKEN_ISSUERS: "https://api.botframework.com; https://sts.example.com/",
  });
  k.t("issuers set empty", k.tok(), { ...k.httpEnv, BOT_TOKEN_ISSUERS: " ; " });
  k.t(
    "suffixes set empty, webchat",
    k.tok({ serviceurl: "https://webchat.botframework.com/" }),
    { ...k.httpEnv, BOT_SERVICE_URL_SUFFIXES: "" },
    k.message({ serviceUrl: "https://webchat.botframework.com/" }),
  );
  k.t("suffixes set empty, smba", k.tok(), { ...k.httpEnv, BOT_SERVICE_URL_SUFFIXES: "" });
  for (const serviceUrl of [
    "https://bots.contoso.example/x",
    "https://a.teams.contoso.example/",
    "https://webchat.botframework.us/",
  ]) {
    k.t(`extended allow-list ${serviceUrl}`, k.tok({ serviceurl: serviceUrl }), k.extended, k.message({ serviceUrl }));
  }
  k.t(
    "malformed allow-list entries",
    k.tok({ serviceurl: "https://evil.net/" }),
    {
      ...k.httpEnv,
      BOT_SERVICE_URL_SUFFIXES: ".net; *; com; .botframework.com",
      BOT_SERVICE_URL_HOSTS: "https://x.example; smba.trafficmanager.net",
    },
    k.message({ serviceUrl: "https://evil.net/" }),
  );
}
