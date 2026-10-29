// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import { ConfigError, PRESETS, parseConfig } from "../src/config.js";
import { checkCwd, relativeInside } from "../src/roots.js";
import { globMatches } from "../src/glob.js";
import { redactDeep, redactText } from "../src/redact.js";
import { SseParser } from "../src/sse.js";
import { backoffMs, secureUrl, truncateBytes, UrlError } from "../src/util.js";

const PEM = (what: string) => "-----" + what + " PRIVATE" + " KEY-----";
const tmp = (prefix = "cc-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

describe("agents.toml", () => {
  const root = tmp();
  const base = (extra: string) => `[[agents]]\nid = "a"\npreset = "claude"\nroots = [${JSON.stringify(root)}]\n${extra}`;

  const refused: Array<[string, string, RegExp]> = [
    ["not toml", "this is = = not toml", /not valid TOML/],
    ["no roots", `[[agents]]\nid = "a"\npreset = "claude"\n`, /roots is required/],
    ["empty roots", `[[agents]]\nid = "a"\npreset = "claude"\nroots = []\n`, /roots is required/],
    ["a root that does not exist", `[[agents]]\nid = "a"\npreset = "claude"\nroots = ["/no/such/dir/here"]\n`, /does not exist/],
    ["the filesystem root", `[[agents]]\nid = "a"\npreset = "claude"\nroots = ["/"]\n`, /filesystem root/],
    ["unknown preset", `[[agents]]\nid = "a"\npreset = "nope"\nroots = ["${root}"]\n`, /unknown preset/],
    ["no preset and no command", `[[agents]]\nid = "a"\nroots = ["${root}"]\n`, /needs a preset or a command/],
    ["custom agent without ask_mode", `[[agents]]\nid = "a"\ncommand = "x"\nroots = ["${root}"]\n`, /ask_mode is required/],
    ["duplicate id", base("") + base(""), /used twice/],
    ["bad id", `[[agents]]\nid = "a b"\npreset = "claude"\nroots = ["${root}"]\n`, /agents\[0\]\.id/],
    ["a flag that turns approvals off", base(`args = ["acp", "--force"]\n`), /turns the tool's own approvals off/],
    ["yolo", base(`args = ["--yolo"]\n`), /turns the tool's own approvals off/],
    ["auto_allow without a glob", base(`auto_allow = [{ kind = "edit" }]\n`), /needs a kind and a path_glob/],
    ["auto_allow glob that escapes", base(`auto_allow = [{ kind = "edit", path_glob = "../x/**" }]\n`), /may not contain \.\./],
    ["auto_allow absolute glob", base(`auto_allow = [{ kind = "edit", path_glob = "/etc/**" }]\n`), /relative/],
    ["allow_unsafe_modes not a boolean", `allow_unsafe_modes = "yes"\n`, /true or false/],
  ];
  for (const [name, text, re] of refused) {
    test(`refused: ${name}`, () => {
      assert.throws(() => parseConfig(text), (e) => e instanceof ConfigError && re.test(e.message), name);
    });
  }

  test("a bypass flag is accepted only when the owner allows unsafe modes", () => {
    const cfg = parseConfig(`allow_unsafe_modes = true\n` + base(`args = ["acp", "--force"]\n`));
    assert.equal(cfg.allowUnsafeModes, true);
    assert.deepEqual(cfg.agents[0]!.args, ["acp", "--force"]);
  });

  test("presets give the pinned adapter, the ask mode and the safe modes; roots are canonical-able", () => {
    const cfg = parseConfig(
      ["claude", "codex", "cursor"].map((p) => `[[agents]]\nid = "${p}"\npreset = "${p}"\nroots = ["${root}"]\n`).join("\n"),
      { hostname: "box" },
    );
    assert.equal(cfg.name, "box");
    assert.deepEqual(cfg.agents.map((a) => [a.id, a.kind, a.askMode, a.safeModes]), [
      ["claude", "claude", "default", ["default", "plan"]],
      ["codex", "codex", "read-only", ["read-only"]],
      ["cursor", "cursor", "ask", ["ask", "plan"]],
    ]);
    assert.match(cfg.agents[0]!.args.join(" "), /claude-agent-acp@\d/);
    assert.match(cfg.agents[1]!.args.join(" "), /codex-acp@\d/);
    assert.deepEqual([cfg.agents[2]!.command, cfg.agents[2]!.args], ["agent", ["acp"]]);
    // No preset's own list is shared with a parsed agent: editing one must not change the next parse.
    cfg.agents[0]!.safeModes.push("bypassPermissions");
    assert.deepEqual(PRESETS.claude!.safeModes, ["default", "plan"]);
  });

  test("the ask mode is always among the safe modes, and a custom agent defines its own", () => {
    const cfg = parseConfig(`[[agents]]\nid = "x"\nkind = "mine"\ncommand = "my-agent"\nask_mode = "careful"\nsafe_modes = ["plan"]\nroots = ["${root}"]\n`);
    assert.deepEqual(cfg.agents[0]!.safeModes, ["plan", "careful"]);
    assert.equal(cfg.agents[0]!.kind, "mine");
  });

  // approval = "never": what each preset turns into, measured on the pinned adapters (see the comment on PRESETS).
  const approvals: Array<[string, string, string, string[] | null, string[], boolean]> = [
    // [preset, setting, ask mode, args (null: the preset's own), safe modes, unattended]
    ["claude", `approval = "never"\n`, "bypassPermissions", null, ["default", "plan"], true],
    ["codex", `approval = "never"\n`, "agent-full-access", null, ["read-only"], true],
    ["cursor", `approval = "never"\n`, "agent", ["--force", "acp"], ["ask", "plan"], true],
    ["claude", `approval = "ask"\n`, "default", null, ["default", "plan"], false],
    ["codex", `approval = "ask"\n`, "read-only", null, ["read-only"], false],
    ["cursor", `approval = "ask"\n`, "ask", null, ["ask", "plan"], false],
    ["cursor", ``, "ask", null, ["ask", "plan"], false],
  ];
  for (const [preset, setting, ask, args, safe, unattended] of approvals) {
    test(`${preset} ${setting.trim() || "with no approval setting"}: starts in ${ask}, ${unattended ? "does not ask" : "asks"}`, () => {
      const cfg = parseConfig(`[[agents]]\nid = "a"\npreset = "${preset}"\nroots = [${JSON.stringify(root)}]\n${setting}`);
      const a = cfg.agents[0]!;
      assert.deepEqual([a.askMode, a.safeModes, a.unattended, a.allowUnsafeModes], [ask, safe, unattended, unattended]);
      assert.deepEqual(a.args, args ?? PRESETS[preset]!.args);
      assert.equal(cfg.allowUnsafeModes, false, "the file-level switch is not touched by a per-agent setting");
    });
  }

  test("approval is per agent: one agent can run unattended while the next still asks, and the file-level switch is only a default", () => {
    const two = (top: string, a: string, b: string) => parseConfig(
      `${top}[[agents]]\nid = "a"\npreset = "claude"\nroots = [${JSON.stringify(root)}]\n${a}\n[[agents]]\nid = "b"\npreset = "cursor"\nroots = [${JSON.stringify(root)}]\n${b}\n`);
    const row = (c: ReturnType<typeof parseConfig>) => c.agents.map((x) => [x.id, x.allowUnsafeModes, x.unattended]);
    assert.deepEqual(row(two("", `approval = "never"`, "")), [["a", true, true], ["b", false, false]]);
    assert.deepEqual(row(two("allow_unsafe_modes = true\n", "", "")), [["a", true, false], ["b", true, false]], "allowed, still starting in the asking mode");
    assert.deepEqual(row(two("allow_unsafe_modes = true\n", "", `approval = "ask"`)), [["a", true, false], ["b", false, false]], "an agent's own setting beats the default");
    assert.deepEqual(row(two("", `approval = "never"`, `approval = "never"`)), [["a", true, true], ["b", true, true]]);
  });

  test("an explicit ask_mode and args win over what approval = never would pick", () => {
    const cfg = parseConfig(`[[agents]]\nid = "a"\npreset = "cursor"\napproval = "never"\nargs = ["acp"]\nask_mode = "plan2"\nroots = [${JSON.stringify(root)}]\n`);
    assert.deepEqual([cfg.agents[0]!.askMode, cfg.agents[0]!.args, cfg.agents[0]!.unattended], ["plan2", ["acp"], true]);
  });

  test("a custom agent can opt out of approval, by naming the mode in which it does not ask", () => {
    const cfg = parseConfig(`[[agents]]\nid = "x"\ncommand = "my-agent"\napproval = "never"\nask_mode = "yolo"\nsafe_modes = ["careful"]\nroots = [${JSON.stringify(root)}]\n`);
    assert.deepEqual([cfg.agents[0]!.askMode, cfg.agents[0]!.safeModes, cfg.agents[0]!.unattended], ["yolo", ["careful"], true]);
  });

  const badApproval: Array<[string, string, RegExp]> = [
    ["not ask or never", base(`approval = "sometimes"\n`), /approval must be "ask" or "never"/],
    ["a boolean", base(`approval = true\n`), /approval must be "ask" or "never"/],
    ["a custom agent with no mode to name", `[[agents]]\nid = "x"\ncommand = "my-agent"\napproval = "never"\nroots = ["${root}"]\n`, /approval = "never" needs ask_mode/],
    ["never next to a mode that asks", base(`approval = "never"\nask_mode = "default"\n`), /but ask_mode default is a mode that asks/],
    ["ask next to a mode that does not", base(`approval = "ask"\nask_mode = "bypassPermissions"\n`), /not a mode that asks before every step/],
    ["a no-approval flag with approval = ask", base(`approval = "ask"\nargs = ["--force", "acp"]\n`), /turns the tool's own approvals off/],
  ];
  for (const [name, text, re] of badApproval) {
    test(`refused: ${name}`, () => {
      assert.throws(() => parseConfig(text), (e) => e instanceof ConfigError && re.test(e.message), name);
    });
  }

  test("an ask_mode the preset does not list as asking needs the owner's opt-in (it used to pass silently), and then is unattended", () => {
    const text = base(`ask_mode = "bypassPermissions"\n`);
    assert.throws(() => parseConfig(text), (e) => e instanceof ConfigError && /approval = "never" \(or allow_unsafe_modes = true\)/.test(e.message));
    const cfg = parseConfig(`allow_unsafe_modes = true\n` + text);
    assert.deepEqual([cfg.agents[0]!.askMode, cfg.agents[0]!.safeModes, cfg.agents[0]!.unattended], ["bypassPermissions", ["default", "plan"], true]);
  });

  test("a no-approval flag is accepted for an agent with approval = never, and for none other", () => {
    const cfg = parseConfig(base(`approval = "never"\nargs = ["acp", "--force"]\n`));
    assert.deepEqual(cfg.agents[0]!.args, ["acp", "--force"]);
    assert.throws(() => parseConfig(base(`args = ["acp", "--force"]\n`)), (e) => e instanceof ConfigError);
  });

  test("auto_allow rules of the file and of the agent are both kept; env is carried", () => {
    const cfg = parseConfig(`auto_allow = [{ kind = "edit", path_glob = "docs/**" }]\n` + base(`auto_allow = [{ kind = "read", path_glob = "**" }]\n[agents.env]\nANTHROPIC_MODEL = "opus"\n`));
    assert.deepEqual(cfg.agents[0]!.autoAllow, [{ kind: "edit", pathGlob: "docs/**" }, { kind: "read", pathGlob: "**" }]);
    assert.deepEqual(cfg.agents[0]!.env, { ANTHROPIC_MODEL: "opus" });
  });
});

describe("the directory whitelist", () => {
  const top = fs.realpathSync(tmp());
  const root = path.join(top, "work");
  const inside = path.join(root, "repo");
  const sibling = path.join(top, "work-evil");
  const outside = path.join(top, "elsewhere");
  for (const d of [inside, sibling, outside]) fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync(outside, path.join(root, "link-out"));
  fs.symlinkSync(inside, path.join(top, "link-in"));
  fs.writeFileSync(path.join(root, "file.txt"), "x");

  const cases: Array<[string, string, boolean, string?]> = [
    ["the root itself", root, true],
    ["a directory inside", inside, true],
    ["a symlink from outside that lands inside", path.join(top, "link-in"), true],
    ["a symlink inside that escapes", path.join(root, "link-out"), false, "cwd_outside_roots"],
    ["a .. that escapes", path.join(root, "..", "elsewhere"), false, "cwd_outside_roots"],
    ["a sibling sharing the name prefix", sibling, false, "cwd_outside_roots"],
    ["a plain outside directory", outside, false, "cwd_outside_roots"],
    ["a relative path", "work/repo", false, "cwd_not_absolute"],
    ["a missing directory", path.join(root, "nope"), false, "cwd_not_found"],
    ["a file", path.join(root, "file.txt"), false, "cwd_not_directory"],
    ["empty", "", false, "invalid_cwd"],
    ["a NUL byte", root + "\0x", false, "invalid_cwd"],
  ];
  for (const [name, cwd, ok, reason] of cases) {
    test(name, () => {
      const v = checkCwd(cwd, [root]);
      assert.equal(v.ok, ok, JSON.stringify(v));
      if (!v.ok) assert.equal(v.reason, reason);
      // What is returned is the canonical path the agent is started in.
      if (v.ok) assert.equal(v.real, fs.realpathSync(cwd));
    });
  }
  test("several roots: any one is enough, and a missing root grants nothing", () => {
    assert.equal(checkCwd(outside, [root, outside]).ok, true);
    assert.equal(checkCwd(outside, [path.join(top, "gone")]).ok, false);
  });
  test("relativeInside: a path to be created resolves through its parent; an escape is null", () => {
    assert.equal(relativeInside("new.txt", inside), "new.txt");
    assert.equal(relativeInside(path.join(inside, "a", "b.txt"), inside), null); // parent does not exist
    assert.equal(relativeInside("../x", inside), null);
    assert.equal(relativeInside(path.join(root, "link-out", "f"), root), null);
  });
});

describe("glob", () => {
  const cases: Array<[string, string, boolean]> = [
    ["docs/**", "docs/a.md", true], ["docs/**", "docs/x/y/a.md", true], ["docs/**", "docsx/a.md", false], ["docs/**", "other/docs/a.md", false],
    ["*.md", "a.md", true], ["*.md", "d/a.md", false], ["**/*.md", "d/e/a.md", true], ["**/*.md", "a.md", true], ["src/?.ts", "src/a.ts", true], ["src/?.ts", "src/ab.ts", false],
    ["a.b", "axb", false], ["**", "anything/at/all", true],
  ];
  for (const [g, p, want] of cases) test(`${g} vs ${p}`, () => assert.equal(globMatches(g, p), want));
});

describe("redaction", () => {
  const secrets: Array<[string, string]> = [
    ["a SaFE key", "use ak-0123456789abcdefABCDEF here"],
    ["a GitHub token", "token ghp_0123456789abcdefghijklmnopqrstuvwxyz"],
    ["a fine-grained token", "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz"],
    ["a bearer header", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123"],
    ["an sk key", "sk-abcdefghijklmnopqrstuvwxyz012345"],
    // Built at run time: a PEM header in the source would trip every secret scanner, this file's own included.
    ["a PEM block", `${PEM("BEGIN RSA")}\nMIIBOgIBAAJBAK\n${PEM("END RSA")}`],
    ["a PEM block cut short", `${PEM("BEGIN")}\nMIIBOgIBAAJBAK`],
    ["a JWT", "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl"],
    ["an AWS key id", "AKIAABCDEFGHIJKLMNOP"],
    ["a named value", "API_KEY=Zm9vYmFyYmF6cXV4MDEyMzQ1Njc4OWFiY2RlZmdoaWo"],
  ];
  for (const [name, text] of secrets) {
    test(`masks ${name}`, () => {
      const r = redactText(text);
      assert.equal(r.masked, true);
      assert.match(r.text, /\[hidden\]/);
      assert.doesNotMatch(r.text, /0123456789abcdef|MIIBOg|c2lnbmF0dXJl|ABCDEFGHIJKLMNOP|Zm9vYmFy/);
    });
  }
  test("leaves ordinary text, uuids and paths alone", () => {
    const text = "edit /home/u/work/main.ts at 2f1c4d3e-8a2b-4c5d-9e1f-0a1b2c3d4e5f, optionId allow-once";
    assert.deepEqual(redactText(text), { text, masked: false });
  });
  test("redactDeep reaches nested strings and keeps keys and non-strings", () => {
    const out = redactDeep({ a: ["x", { b: "Bearer abcdefghijklmnopqrstuvwxyz0123" }], n: 3, k: null });
    assert.deepEqual(out, { a: ["x", { b: "[hidden]" }], n: 3, k: null });
  });
});

describe("server-sent events parser", () => {
  const stream = "id: 1\nevent: command\ndata: {\"a\":1}\n\n: keepalive\n\nevent: ping\ndata: {}\n\nid: 2\r\nevent: command\r\ndata: x\r\ndata: y\r\n\r\n";
  const expected = [
    { id: "1", event: "command", data: '{"a":1}' }, { comment: true }, { event: "ping", data: "{}" }, { id: "2", event: "command", data: "x\ny" },
  ];
  test("whole", () => assert.deepEqual(new SseParser().push(stream), expected));
  test("split at every byte boundary", () => {
    for (let i = 1; i < stream.length; i++) {
      const p = new SseParser();
      assert.deepEqual([...p.push(stream.slice(0, i)), ...p.push(stream.slice(i))], expected, `split at ${i}`);
    }
  });
  test("an incomplete frame waits", () => assert.deepEqual(new SseParser().push("event: x\ndata: 1"), []));
});

describe("URLs credentials may be sent to", () => {
  const ok: Array<[string, string]> = [
    ["https://claw.example.com/claw-api/", "https://claw.example.com/claw-api"], ["https://claw.example.com", "https://claw.example.com"],
    ["http://localhost:8080/api", "http://localhost:8080/api"], ["http://127.0.0.1:3000", "http://127.0.0.1:3000"], ["http://[::1]:3000/x", "http://[::1]:3000/x"], ["http://127.1.2.3", "http://127.1.2.3"],
  ];
  for (const [input, want] of ok) test(`accepts ${input}`, () => assert.equal(secureUrl(input, "u"), want));
  const bad = ["http://claw.example.com", "http://10.0.0.5:8080", "http://127.0.0.1.evil.example", "http://localhost.evil.example", "ftp://claw.example.com", "claw.example.com", "", "javascript:alert(1)"];
  for (const input of bad) test(`refuses ${JSON.stringify(input)}`, () => assert.throws(() => secureUrl(input, "the url"), UrlError));
});

describe("small helpers", () => {
  test("truncateBytes cuts on a character boundary and says how much", () => {
    const r = truncateBytes("é".repeat(100), 51);
    assert.equal(r.truncated, true);
    assert.match(r.text, /truncated, 200 bytes in all/);
    assert.doesNotMatch(r.text, /�/);
    assert.deepEqual(truncateBytes("short", 100), { text: "short", truncated: false, bytes: 5 });
  });
  test("backoff doubles from 1 s to the 60 s cap, with jitter between half and all of it", () => {
    const at = (n: number, r: number) => backoffMs(n, 1000, 60000, () => r);
    assert.deepEqual([0, 1, 2, 3, 6, 7, 20].map((n) => at(n, 1)), [1000, 2000, 4000, 8000, 60000, 60000, 60000]);
    assert.equal(at(3, 0), 4000);
  });
});
