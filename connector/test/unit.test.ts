// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import { ConfigError, PRESETS, parseConfig } from "../src/config.js";
import { checkCwd, relativeInside, resolveCwd, rootProblems } from "../src/roots.js";
import { hintFor } from "../src/hints.js";
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
  test("a root that does not exist (yet) is accepted: reading agents.toml never touches a root, which may be a network mount", () => {
    const cfg = parseConfig(`[[agents]]\nid = "a"\npreset = "claude"\nroots = ["/no/such/dir/here"]\n`);
    assert.deepEqual(cfg.agents[0]!.roots, ["/no/such/dir/here"]);
  });
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
      ["claude-sessions", "attach", "default", ["default", "plan"]],
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
    const row = (c: ReturnType<typeof parseConfig>) => c.agents.filter((x) => !x.attach).map((x) => [x.id, x.allowUnsafeModes, x.unattended]);
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
    ["a preset's safe_modes naming a mode it does not know to ask, with approval = ask", base(`approval = "ask"\nsafe_modes = ["default", "plan", "acceptEdits"]\n`), /safe_modes lists acceptEdits, which preset claude does not know to ask/],
    ["the same with no approval setting", base(`safe_modes = ["default", "bypassPermissions"]\n`), /safe_modes lists bypassPermissions/],
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

  test("the modes a phone may select and the modes known to ask are kept apart: an owner's narrower list does not make the ask mode unsafe", () => {
    const cfg = parseConfig(base(`ask_mode = "plan"\nsafe_modes = ["default"]\n`));
    assert.deepEqual([cfg.agents[0]!.askMode, cfg.agents[0]!.safeModes, cfg.agents[0]!.askingModes, cfg.agents[0]!.unattended], ["plan", ["default", "plan"], ["default", "plan"], false]);
  });

  test("with the opt-in a preset's list may name a mode it does not know to ask, and that mode counts as not asking", () => {
    for (const top of [`allow_unsafe_modes = true\n`, ``]) {
      const cfg = parseConfig(top + base(`${top ? "" : `approval = "never"\n`}safe_modes = ["default", "plan", "acceptEdits"]\n`));
      const a = cfg.agents[0]!;
      assert.ok(a.safeModes.includes("acceptEdits") && !a.askingModes.includes("acceptEdits"), "selectable, but not known to ask: a session in it says unattended");
      assert.deepEqual([...a.askingModes].sort(), ["default", "plan"]);
    }
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
  // The same table through what a phone's folder goes through now: everything absolute behaves the same.
  for (const [name, cwd, ok, reason] of cases) {
    if (!path.isAbsolute(cwd)) continue;
    test(`resolveCwd: ${name}`, async () => {
      const v = await resolveCwd(cwd, [root], { home: top });
      assert.equal(v.ok, ok, JSON.stringify(v));
      if (!v.ok) assert.equal(v.reason, reason);
      if (v.ok) assert.equal(v.real, fs.realpathSync(cwd));
    });
  }

  describe("what people type on a phone", () => {
    const home = path.join(top, "home");
    const work2 = path.join(top, "work2");
    fs.mkdirSync(path.join(home, "proj"), { recursive: true });
    fs.mkdirSync(path.join(work2, "repo"), { recursive: true });
    fs.mkdirSync(path.join(work2, "only-here", "sub"), { recursive: true });
    const roots = [root, work2, home];
    const typed: Array<[string, string, string | null, string?]> = [
      ["~ is the agent's home", "~", home],
      ["~/x is a folder in it", "~/proj", path.join(home, "proj")],
      ["a folder name found under exactly one root", "only-here", path.join(work2, "only-here")],
      ["a relative path under one root", "only-here/sub", path.join(work2, "only-here", "sub")],
      ["a root's own name is that root", "work2", work2],
      ["a name two roots have is ambiguous", "repo", null, "cwd_ambiguous"],
      ["a name no root has", "missing-repo", null, "cwd_not_found"],
      ["a relative path may not climb out", "../elsewhere", null, "cwd_outside_roots"],
      ["~otheruser is not this agent's home", "~root/x", null, "cwd_not_absolute"],
      ["a symlink inside that escapes, by name", "link-out", null, "cwd_not_found"],
      ["a folder under ~ that does not exist", "~/nope", null, "cwd_not_found"],
      ["surrounding spaces are ignored", "  ~/proj ", path.join(home, "proj")],
    ];
    for (const [name, cwd, want, reason] of typed) {
      test(name, async () => {
        const v = await resolveCwd(cwd, roots, { home });
        if (want) assert.deepEqual(v, { ok: true, real: fs.realpathSync(want) });
        else assert.deepEqual(v, { ok: false, reason });
      });
    }
    test("~ outside every root is still refused", async () => {
      assert.deepEqual(await resolveCwd("~", [root], { home }), { ok: false, reason: "cwd_outside_roots" });
    });
    test("a folder under a root that is not there (a mount not mounted yet) is root_unavailable, not a missing folder", async () => {
      assert.deepEqual(await resolveCwd(path.join(top, "mnt", "x"), [path.join(top, "mnt")], { home }), { ok: false, reason: "root_unavailable" });
      assert.deepEqual(await resolveCwd("x", [path.join(top, "mnt")], { home }), { ok: false, reason: "root_unavailable" });
    });
    test("a root on a mount that stops answering: root_unavailable in time, the event loop keeps running, and the next look does not pile up", async () => {
      let calls = 0;
      const hung = { realpath: (p: string) => { calls++; return p.startsWith(path.join(top, "dead")) ? new Promise<string>(() => {}) : fs.promises.realpath(p); }, stat: fs.promises.stat } as unknown as Pick<typeof fs.promises, "realpath" | "stat">;
      let ticks = 0;
      const tick = setInterval(() => ticks++, 10);
      const t0 = Date.now();
      const v = await resolveCwd(path.join(top, "dead", "x"), [path.join(top, "dead")], { home, timeoutMs: 150, fs: hung });
      clearInterval(tick);
      assert.deepEqual(v, { ok: false, reason: "root_unavailable" });
      assert.ok(Date.now() - t0 < 2000);
      assert.ok(ticks >= 5, "timers ran while the look was hanging (heartbeats keep going)");
      const before = calls;
      assert.deepEqual(await resolveCwd(path.join(top, "dead", "x"), [path.join(top, "dead")], { home, timeoutMs: 150, fs: hung }), { ok: false, reason: "root_unavailable" });
      assert.equal(calls, before, "the stalled root is not asked again while its first look hangs");
    });
    test("one stalled or missing root takes out only its own folders: a folder under a healthy root opens, and a deleted one there is cwd_not_found", async () => {
      const dead = path.join(top, "dead2");
      const hung = { realpath: (p: string) => (p.startsWith(dead) ? new Promise<string>(() => {}) : fs.promises.realpath(p)), stat: fs.promises.stat } as unknown as Pick<typeof fs.promises, "realpath" | "stat">;
      const both = [dead, work2];
      assert.deepEqual(await resolveCwd("only-here", both, { home, timeoutMs: 100, fs: hung }), { ok: true, real: fs.realpathSync(path.join(work2, "only-here")) });
      assert.deepEqual(await resolveCwd(path.join(work2, "repo"), both, { home, timeoutMs: 100, fs: hung }), { ok: true, real: fs.realpathSync(path.join(work2, "repo")) });
      assert.deepEqual(await resolveCwd(path.join(dead, "x"), both, { home, timeoutMs: 100, fs: hung }), { ok: false, reason: "root_unavailable" });
      const missing = [path.join(top, "mnt-missing"), work2];
      assert.deepEqual(await resolveCwd(path.join(work2, "deleted"), missing, { home }), { ok: false, reason: "cwd_not_found" });
      assert.deepEqual(await resolveCwd(path.join(top, "mnt-missing", "x"), missing, { home }), { ok: false, reason: "root_unavailable" });
    });
    test("a root that is missing is reported once per agent, not fatal", async () => {
      const ps = await rootProblems([{ id: "a", roots: [root, path.join(top, "mnt")] }]);
      assert.equal(ps.length, 1);
      assert.match(ps[0]!, /a: root .*mnt does not exist \(yet\); its sessions are refused until it does/);
    });
  });

  test("every refusal reason a phone can see has a hint, and a sign-in hint names that agent's own command", () => {
    for (const r of ["cwd_not_absolute", "cwd_not_found", "cwd_outside_roots", "cwd_ambiguous", "root_unavailable", "mode_unavailable", "mode_not_enforced",
      "adapter_start_failed", "too_many_sessions", "unknown_agent", "resume_ref_required", "session_live", "invalid_cwd", "cwd_not_directory",
      "terminal_did_not_exit", "session_live_elsewhere", "takeover_not_permitted", "takeover_failed", "takeover_expired"]) {
      assert.ok(hintFor(r), r);
    }
    assert.match(hintFor("agent_auth_required", { command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp@0.99.0"] })!, /claude.*\/login|ANTHROPIC_API_KEY/);
    assert.match(hintFor("agent_auth_required", { command: "npx", args: ["-y", "@agentclientprotocol/codex-acp@2.3.0"] })!, /codex login/);
    assert.match(hintFor("agent_auth_required", { command: "agent", args: ["acp"] })!, /agent login/);
    assert.equal(hintFor("closed"), null);
  });

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
