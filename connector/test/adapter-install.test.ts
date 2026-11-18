// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { afterEach, describe } from "node:test";
import { pathToFileURL } from "node:url";
import { AdapterStore, adaptersDir, pinnedPackage, useAdapterStore } from "../src/adapter-install.js";
import { AdapterProcess } from "../src/adapter.js";
import { ChildRegistry } from "../src/children.js";
import { PRESETS, parseConfig, type AgentConfig } from "../src/config.js";
import { main } from "../src/commands.js";
import { resolveDirs } from "../src/paths.js";
import { ADAPTER, tmpdir } from "./support/harness.js";

const SPEC = "@claw-test/fake-acp@1.0.0";

/** A package whose bin is the stand-in adapter, and an `npm` on PATH that "installs" it into --prefix, logging cwd and args. */
function fixture(): { root: string; bin: string; log: string; pkg: string } {
  const root = tmpdir("ai-");
  const pkg = path.join(root, "pkg");
  fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@claw-test/fake-acp", version: "1.0.0", bin: { "fake-acp": "bin.mjs" } }));
  fs.writeFileSync(path.join(pkg, "bin.mjs"), `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(ADAPTER).href)};\n`);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const log = path.join(root, "npm.log");
  fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh
echo "$PWD|$*" >> "$FAKE_NPM_LOG"
if [ -n "$FAKE_NPM_SLEEP" ]; then sleep "$FAKE_NPM_SLEEP"; fi
if [ -n "$FAKE_NPM_FAIL" ]; then echo "npm error 404 Not Found" >&2; exit 1; fi
prefix=""
while [ $# -gt 0 ]; do case "$1" in --prefix) prefix="$2"; shift 2;; *) shift;; esac; done
d="$prefix/node_modules/@claw-test/fake-acp"
mkdir -p "$d" && cp "$FAKE_PKG"/* "$d"/
`, { mode: 0o755 });
  return { root, bin, log, pkg };
}

const envFor = (f: ReturnType<typeof fixture>, extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: `${f.bin}${path.delimiter}${process.env.PATH ?? ""}`, FAKE_NPM_LOG: f.log, FAKE_PKG: f.pkg, ...extra,
});

function agent(work: string, env: Record<string, string>): AgentConfig {
  const cfg = parseConfig(`[[agents]]\nid = "fake"\ncommand = "npx"\nargs = ["-y", "${SPEC}"]\nask_mode = "default"\nroots = [${JSON.stringify(work)}]\n`);
  const a = cfg.agents[0]!;
  a.env = env;
  return a;
}

const noHooks = {
  onUpdate: () => {}, onNotification: () => {}, onStderr: () => {}, onExit: () => {},
  onPermission: async () => ({ outcome: { outcome: "cancelled" } }), onExtension: async () => ({}),
};

afterEach(() => useAdapterStore(null));

describe("pinned adapters", () => {
  test("only the preset form npx -y <package>@<exact version> is pinned", () => {
    assert.deepEqual(pinnedPackage(PRESETS.claude!), { spec: "@agentclientprotocol/claude-agent-acp@0.99.0", name: "@agentclientprotocol/claude-agent-acp", version: "0.99.0", rest: [] });
    assert.equal(pinnedPackage(PRESETS.codex!)?.name, "@agentclientprotocol/codex-acp");
    assert.equal(pinnedPackage(PRESETS.cursor!), null);
    assert.equal(pinnedPackage({ command: "/usr/bin/npx", args: ["--yes", "plain@2.0.0-rc.1", "--flag"] })?.rest[0], "--flag");
    for (const args of [["@a/b@^1.0.0"], ["-y", "@a/b@latest"], ["-y", "@a/b"], ["-y", "../evil@1.0.0"], []]) assert.equal(pinnedPackage({ command: "npx", args }), null, args.join(" "));
    assert.equal(pinnedPackage({ command: "node", args: ["-y", "@a/b@1.0.0"] }), null);
  });

  test("installed once into the state directory with npm run in the empty install directory; nothing half-done is left", async () => {
    const f = fixture();
    const state = tmpdir("ai-state-");
    const store = new AdapterStore(adaptersDir(state), { autoInstall: true });
    const pkg = pinnedPackage({ command: "npx", args: ["-y", SPEC] })!;
    const lines: string[] = [];
    const bin = await store.install(pkg, { ...process.env, ...envFor(f) }, (l) => lines.push(l));
    assert.equal(bin, path.join(adaptersDir(state), "@claw-test+fake-acp@1.0.0", "node_modules", "@claw-test", "fake-acp", "bin.mjs"));
    const [call] = fs.readFileSync(f.log, "utf8").trim().split("\n");
    const [cwd, args] = call!.split("|");
    assert.match(cwd!, /\/adapters\/\.install-@claw-test\+fake-acp@1\.0\.0-/, "npm runs in the fresh install directory, never a session folder");
    assert.match(args!, /^install --prefix \S+ --no-save --no-package-lock --no-audit --no-fund --omit=dev --loglevel=error @claw-test\/fake-acp@1\.0\.0$/);
    assert.deepEqual(fs.readdirSync(adaptersDir(state)), ["@claw-test+fake-acp@1.0.0"]);
    assert.match(lines.join("\n"), /installing @claw-test\/fake-acp@1\.0\.0 into .*installed @claw-test\/fake-acp@1\.0\.0 in \d+ s/s);
    // Again: nothing to do, npm is not run.
    assert.equal(await store.install(pkg, { ...process.env, ...envFor(f) }), bin);
    assert.equal(fs.readFileSync(f.log, "utf8").trim().split("\n").length, 1);
  });

  test("a session in a folder whose .npmrc names a dead registry starts in about a second, through the installed copy", async () => {
    const f = fixture();
    const state = tmpdir("ai-state-");
    const work = tmpdir("ai-work-");
    fs.writeFileSync(path.join(work, ".npmrc"), "registry=http://127.0.0.1:9/\nfetch-retries=5\n");
    const env = envFor(f);
    const a = agent(work, env);
    const store = new AdapterStore(adaptersDir(state), { autoInstall: true });
    await store.install(pinnedPackage(a)!, { ...process.env, ...env });
    useAdapterStore(store);
    const reg = new ChildRegistry(path.join(state, "children.json"));
    const t0 = Date.now();
    const p = await AdapterProcess.start({ cfg: a, registry: reg, sessionId: "s1", cwd: work, hooks: noHooks, logFile: path.join(state, "a.log"), version: "t", initTimeoutMs: 20_000 });
    try {
      const res = await p.request("session/new", { cwd: work, mcpServers: [] }, 20_000);
      assert.equal(typeof res.sessionId, "string");
      const ms = Date.now() - t0;
      assert.ok(ms < 5_000, `took ${ms} ms`);
      // Started by this node from the installed copy, in the session's folder; npx never ran.
      assert.deepEqual(p.child.spawnargs.slice(0, 2), [process.execPath, path.join(adaptersDir(state), "@claw-test+fake-acp@1.0.0", "node_modules", "@claw-test", "fake-acp", "bin.mjs")]);
    } finally { await p.kill(); }
  });

  test("a session that opens while the install runs waits for it; the first session after a fresh start installs on demand", async () => {
    const f = fixture();
    const state = tmpdir("ai-state-");
    const work = tmpdir("ai-work-");
    const env = envFor(f, { FAKE_NPM_SLEEP: "1" });
    const a = agent(work, env);
    useAdapterStore(new AdapterStore(adaptersDir(state), { autoInstall: true }));
    const p = await AdapterProcess.start({ cfg: a, registry: new ChildRegistry(path.join(state, "children.json")), sessionId: "s1", cwd: work, hooks: noHooks, logFile: path.join(state, "a.log"), version: "t", initTimeoutMs: 20_000 });
    try {
      assert.equal(p.child.spawnargs[0], process.execPath);
      assert.equal(fs.readFileSync(f.log, "utf8").trim().split("\n").length, 1);
    } finally { await p.kill(); }
  });

  test("a failed install falls back to the agent's own npx command, run in the connector's directory, and is not waited for again", async () => {
    const f = fixture();
    const state = tmpdir("ai-state-");
    const work = tmpdir("ai-work-");
    const a = agent(work, envFor(f, { FAKE_NPM_FAIL: "1" }));
    let now = 1_000_000;
    const store = new AdapterStore(adaptersDir(state), { autoInstall: true, now: () => now });
    const env = { ...process.env, ...a.env };
    const first = await store.launch(a, work, env);
    assert.deepEqual(first, { command: "npx", args: ["-y", SPEC], cwd: adaptersDir(state), installed: false });
    assert.deepEqual(fs.readdirSync(adaptersDir(state)), [], "the failed install left nothing behind");
    await store.launch(a, work, env);
    assert.equal(fs.readFileSync(f.log, "utf8").trim().split("\n").length, 1, "no second attempt within the retry delay");
    now += 11 * 60_000;
    await store.launch(a, work, env);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(fs.readFileSync(f.log, "utf8").trim().split("\n").length, 2, "retried in the background later");
  });

  test("after a failed install, a session that opens while the background retry runs does not wait for it", async () => {
    const f = fixture();
    const state = tmpdir("ai-state-");
    const work = tmpdir("ai-work-");
    const a = agent(work, envFor(f, { FAKE_NPM_FAIL: "1" }));
    let now = 1_000_000;
    const store = new AdapterStore(adaptersDir(state), { autoInstall: true, now: () => now });
    assert.equal((await store.launch(a, work, { ...process.env, ...a.env })).installed, false);
    // The retry would now succeed, but slowly (the registry came back, the download takes a while).
    const slow = { ...process.env, ...envFor(f, { FAKE_NPM_SLEEP: "3" }) };
    now += 11 * 60_000;
    const t0 = Date.now();
    const second = await store.launch(a, work, slow);
    assert.ok(store.installing(pinnedPackage(a)!), "the retry started");
    const third = await store.launch(a, work, slow);
    const ms = Date.now() - t0;
    assert.ok(ms < 1_000, `sessions waited ${ms} ms for the background retry`);
    assert.deepEqual([second.installed, third.installed, third.cwd], [false, false, adaptersDir(state)]);
    // Once the retry is done, the next session uses the installed copy.
    const bin = await store.install(pinnedPackage(a)!, slow);
    assert.ok(bin);
    assert.equal((await store.launch(a, work, slow)).installed, true);
  });

  test("without auto-install (a test, or nothing installed yet) the configured command runs, never in the session folder", async () => {
    const state = tmpdir("ai-state-");
    const work = tmpdir("ai-work-");
    const a = agent(work, {});
    const store = new AdapterStore(adaptersDir(state), { autoInstall: false });
    assert.deepEqual(await store.launch(a, work, process.env), { command: "npx", args: ["-y", SPEC], cwd: adaptersDir(state), installed: false });
    const custom = { ...a, command: "my-acp", args: ["--x"] };
    assert.deepEqual(await store.launch(custom, work, process.env), { command: "my-acp", args: ["--x"], cwd: work, installed: false });
  });

  test("two connectors installing the same package at once both end with one complete copy", async () => {
    const f = fixture();
    const state = tmpdir("ai-state-");
    const env = { ...process.env, ...envFor(f, { FAKE_NPM_SLEEP: "1" }) };
    const pkg = pinnedPackage({ command: "npx", args: ["-y", SPEC] })!;
    const [x, y] = await Promise.all([new AdapterStore(adaptersDir(state), { autoInstall: true }).install(pkg, env), new AdapterStore(adaptersDir(state), { autoInstall: true }).install(pkg, env)]);
    assert.ok(x && y && x === y);
    assert.deepEqual(fs.readdirSync(adaptersDir(state)), ["@claw-test+fake-acp@1.0.0"]);
  });

  test("a copy of another version in the way is replaced", async () => {
    const f = fixture();
    const state = tmpdir("ai-state-");
    const final = path.join(adaptersDir(state), "@claw-test+fake-acp@1.0.0", "node_modules", "@claw-test", "fake-acp");
    fs.mkdirSync(final, { recursive: true });
    fs.writeFileSync(path.join(final, "package.json"), JSON.stringify({ name: "@claw-test/fake-acp", version: "0.9.0", bin: "x.js" }));
    const store = new AdapterStore(adaptersDir(state), { autoInstall: true });
    const pkg = pinnedPackage({ command: "npx", args: ["-y", SPEC] })!;
    assert.equal(store.installed(pkg), null);
    assert.ok(await store.install(pkg, { ...process.env, ...envFor(f) }));
    assert.equal(JSON.parse(fs.readFileSync(path.join(final, "package.json"), "utf8")).version, "1.0.0");
    assert.deepEqual(fs.readdirSync(adaptersDir(state)), ["@claw-test+fake-acp@1.0.0"]);
  });

  test("init installs the enabled agents' adapters when the command line allows it, and not otherwise", async () => {
    const f = fixture();
    const home = tmpdir("ai-home-");
    const work = tmpdir("ai-work-");
    const dirs = resolveDirs({ CLAW_CONNECTOR_HOME: home });
    fs.mkdirSync(dirs.config, { recursive: true });
    fs.writeFileSync(path.join(dirs.config, "agents.toml"), `[[agents]]\nid = "fake"\ncommand = "npx"\nargs = ["-y", "${SPEC}"]\nask_mode = "default"\nroots = [${JSON.stringify(work)}]\n`);
    const out: string[] = [];
    const ctx = { dirs, env: { ...process.env, ...envFor(f) }, out: (l: string) => out.push(l), err: (l: string) => out.push(l) };
    assert.equal(await main(["init", "--no-hooks"], ctx), 0);
    assert.ok(!fs.existsSync(f.log), "a test (no installAdapters) downloads nothing");
    assert.equal(await main(["init", "--no-hooks"], { ...ctx, installAdapters: true }), 0);
    assert.match(out.join("\n"), /adapters: installed @claw-test\/fake-acp@1\.0\.0/);
    assert.ok(fs.existsSync(path.join(adaptersDir(dirs.state), "@claw-test+fake-acp@1.0.0")));
  });
});

describe("what npm is given", () => {
  test("never the agents' sign-in variables, only npm's own settings and token", async () => {
    const { npmEnv } = await import("../src/adapter-install.js");
    const env = npmEnv({
      PATH: "/bin", HOME: "/h", HTTPS_PROXY: "http://p:3128", npm_config_registry: "https://r", NPM_TOKEN: "npm-t", NODE_AUTH_TOKEN: "n-t",
      ANTHROPIC_API_KEY: "sk-a", OPENAI_API_KEY: "sk-o", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_CUSTOM_HEADERS: "x-api-key: h", GW_TOKEN_X: "g",
      AWS_SECRET_ACCESS_KEY: "s", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000", ANTHROPIC_BASE_URL: "https://gw",
    });
    assert.deepEqual(Object.keys(env).sort(), ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "HOME", "HTTPS_PROXY", "NODE_AUTH_TOKEN", "NPM_TOKEN", "PATH", "npm_config_registry"]);
  });
});
