// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MASK, NOTE, redactActivity, redactLogLine, redactText } from "../../src/index.js";

const HEX = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
// Built from pieces at run time so that no literal in this file looks like a real credential to a secret scanner.
const TAIL = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const CASES: Readonly<Record<string, string>> = {
  "safe ak key": "a" + "k-" + "8Kd93hLmQ2xVn7Pz4RtYw1Bc",
  "github ghp": "gh" + "p_" + TAIL,
  "github gho": "gh" + "o_" + TAIL,
  "github ghu": "gh" + "u_" + TAIL,
  "github ghs": "gh" + "s_" + TAIL,
  "github ghr": "gh" + "r_" + TAIL,
  "github pat": "github" + "_pat_" + "11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUV",
  bearer: "Bear" + "er " + "abcDEF123456.ghiJKL789012-mnoPQR",
  "sk key": "s" + "k-" + "proj-Ab12Cd34Ef56Gh78Ij90Kl12",
  "aws id": "AK" + "IA" + "IOSFODNN7EXAMPLE",
  slack: "xo" + "xb-" + "1234567890-abcdefghijKLMNOP",
  gitlab: "gl" + "pat-" + "AbCdEfGhIjKlMnOpQrSt",
  google: "AI" + "za" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q",
  npm: "np" + "m_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
  stripe: "sk" + "_live_" + "AbCdEfGhIjKlMnOpQrStUv12",
  jwt: [
    "ey" + "JhbGciOiJIUzI1NiJ9",
    "ey" + "JzdWIiOiIxMjM0NTY3ODkwIn0",
    "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  ].join("."),
};

const secret = (name: string): string => CASES[name] ?? assert.fail(name);

describe("redactText", () => {
  it("masks each credential shape", () => {
    for (const [name, value] of Object.entries(CASES)) {
      const out = redactText(`the value is\n${value}\nand more text`);
      assert.ok(out.masked && !out.text.includes(value) && out.text.includes(MASK), name);
    }
  });

  it("masks a PEM private key block, even a truncated one", () => {
    const pem =
      "-----BEGIN RSA PRIV" + "ATE KEY-----\nMIIEowIBAAKCAQEA7xk2\nabcdef\n-----END RSA PRIV" + "ATE KEY-----";
    let out = redactText(`key:\n${pem}\nafter`);
    assert.ok(out.masked && !out.text.includes("MIIEow") && out.text.endsWith("after"));
    out = redactText("-----BEGIN PRIV" + "ATE KEY-----\nMIIEvQIBADANBgkq");
    assert.ok(out.masked && !out.text.includes("MIIEvQ"));
  });

  it("masks a long opaque value next to a secret word, and the word stays", () => {
    for (const text of [
      `API_TOKEN=${HEX}`,
      `"password": "${HEX}"`,
      `the secret is ${HEX}`,
      `export OPENAI_API_KEY='${HEX}'`,
    ]) {
      const out = redactText(text);
      assert.ok(out.masked && !out.text.includes(HEX), text);
    }
    assert.equal(redactText(`API_TOKEN=${HEX}`).text, `API_TOKEN=${MASK}`);
  });

  it("leaves ordinary code and pull request text as it is", () => {
    const out = redactText(DIFF);
    assert.equal(out.text, DIFF);
    assert.equal(out.masked, false);
  });

  it("reads word boundaries as Python does, for every script", () => {
    // Python's `\b` sees a Chinese character as a word character: a key glued to one is not at a boundary.
    const key = secret("safe ak key");
    assert.equal(redactText(`中${key}`).masked, false);
    assert.equal(redactText(`中 ${key}`).text, `中 ${MASK}`);
    assert.equal(redactText(`x${secret("aws id")}`).masked, false);
    assert.equal(redactText(`${secret("aws id")}é`).masked, false);
    assert.equal(redactText(`the secret is\u3000${HEX}`).text, `the secret is\u3000${MASK}`);
  });
});

const DIFF = `Review of https://github.com/example-org/example-repo/pull/111 (head b4b2943e1c0f9a7d6e5b4c3a2918f7e6d5c4b3a2)

\`\`\`diff
diff --git a/teams/teams_agent/store.py b/teams/teams_agent/store.py
@@ -93,7 +94,8 @@ class Store:
-        self._db.executescript(_SCHEMA)
+        self._migrate_sessions()
+        self._db.executescript(_SCHEMA)
     def get_key(self, aad_id: str) -> str | None:
         """The key of exactly this Teams user; there is no fallback to any other key."""
         row = self._run("SELECT key_enc FROM links WHERE aad_id = ?", (aad_id,)).fetchone()
-    token = os.environ["GH_TOKEN"]
+    token = os.environ.get("GH_TOKEN", "")
     path = "teams/teams_agent/very/long/relative/path/to/some/module/file_name.py"
     key = "session_id"
\`\`\`
1. \`get_key\` is fine. See commit 3d3665f8 and the key name \`claw_user_id\`; token handling reads GH_TOKEN.
2. The password reset flow in https://example.com/reset?token=abc is out of scope.
`;

describe("redactActivity", () => {
  it("gives a masked text one note", () => {
    const key = secret("safe ak key");
    const out = redactActivity({ type: "message", text: `use ${key}`, textFormat: "markdown" });
    const text = out["text"];
    assert.ok(typeof text === "string");
    assert.ok(!text.includes(key) && text.endsWith(NOTE) && text.split(NOTE).length === 2);
    const clean = { type: "message", text: "hello" };
    assert.equal(redactActivity(clean), clean);
  });

  it("masks cards, leaves buttons alone and adds the note", () => {
    const ghp = secret("github ghp");
    const actions = [
      {
        type: "Action.Execute",
        title: "Approve",
        verb: "primusclaw.decision",
        data: { primusclaw: "decision", session_id: "sess-" + HEX, tool_use_id: "tu1", action: "allow" },
      },
    ];
    const card = {
      type: "message",
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: { type: "AdaptiveCard", body: [{ type: "TextBlock", text: `Tool: ${ghp}` }], actions },
        },
      ],
    };
    const out = redactActivity(card);
    assert.ok(!JSON.stringify(out).includes(ghp));
    const content = (out.attachments[0] as { content: { body: Array<{ text: string }>; actions: unknown } }).content;
    assert.equal(content.body.at(-1)?.text, NOTE);
    assert.deepEqual(content.actions, actions);
    assert.ok(JSON.stringify(card).includes(ghp)); // the input was not modified in place
  });

  it("passes through what is not text, and an attachment that is not a card", () => {
    const key = secret("safe ak key");
    const out = redactActivity({ type: "message", value: 3, flag: null, attachments: ["x", { content: "y" }], v: key });
    assert.equal(out["value"], 3);
    assert.equal(out["flag"], null);
    assert.deepEqual(out["attachments"], ["x", { content: "y" }]);
    assert.equal(out["v"], MASK);
  });
});

describe("redactLogLine", () => {
  const TEMPAUTH = "v1." + "eyJzaXRlaWQiOiJhYmMiLCJhdWQiOiJ4In0" + ".Zm9vYmFyU2lnbmF0dXJlMTIz";
  const DOWNLOAD_URL =
    "https://contoso-my.sharepoint.com/personal/alice_contoso_com/_layouts/15/download.aspx" +
    `?UniqueId=1b2c3d&Translate=false&tempauth=${TEMPAUTH}&ApiVersion=2.0`;

  it("masks credential query parameters whatever their shape", () => {
    const line = `HTTP Request: GET ${DOWNLOAD_URL} "HTTP/1.1 200 OK"`;
    const sas = "https://acct.blob.core.windows.net/c/b.txt?sv=2024-01-01&se=2026-11-05&sp=r&sig=AbC%2Bdef%3D123";
    const oauth = "https://login.example.test/cb?state=s1&code=0.AXoA-auth-code_value&session_state=x";
    const out = redactLogLine(`${line} | ${sas} | ${oauth}`);
    for (const leaked of [TEMPAUTH, "AbC%2Bdef%3D123", "0.AXoA-auth-code_value"]) assert.ok(!out.includes(leaked));
    assert.ok(out.includes("tempauth=[hidden]&ApiVersion=2.0"));
    assert.ok(out.includes("sig=[hidden]") && out.includes("code=[hidden]&session_state=x"));
    assert.ok(out.includes("UniqueId=1b2c3d") && out.includes("sv=2024-01-01"), "only the credential parameters");
  });

  it("keeps ordinary lines as they are", () => {
    assert.equal(redactLogLine("turn t-1 finished in 2.5s"), "turn t-1 finished in 2.5s");
    assert.equal(redactLogLine(`a library failed for ${secret("safe ak key")}`), "a library failed for [hidden]");
  });
});
