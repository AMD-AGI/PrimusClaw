// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The connector trusts the CAs this machine trusts without NODE_USE_SYSTEM_CA (system-ca.ts). The real checks run the CLI
 * in a clean environment against a local HTTPS server signed by a throwaway CA that only the "system" store holds:
 * SSL_CERT_FILE / SSL_CERT_DIR are where Node.js reads that store on Linux, so the machine's own store is never touched.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";
import { checkAll, defaultDeps } from "../src/doctor.js";
import { resolveDirs } from "../src/paths.js";
import { inheritSystemCa, trustSystemCAs, type SystemCaOutcome, type TlsCaApi } from "../src/system-ca.js";
import { ADAPTER, tmpdir } from "./support/harness.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_TS = path.join(ROOT, "src", "cli.ts");
const SYSTEM_CA_TS = path.join(ROOT, "src", "system-ca.ts");

/** A fake node:tls that records what the connector set as the default CAs. */
function fakeTls(stores: Partial<Record<"default" | "system", string[]>>, throws?: Error) {
  const calls: string[][] = [];
  const api: TlsCaApi = {
    getCACertificates: (type = "default") => { if (throws) throw throws; return stores[type as "default" | "system"] ?? []; },
    setDefaultCACertificates: (certs) => { calls.push(certs); },
  };
  return { api, calls };
}

describe("the machine's CA store", () => {
  test("the default CAs become Node's own (bundled + NODE_EXTRA_CA_CERTS) plus the system store; =0 turns it off", () => {
    const flags = new Set(["--use-system-ca"]);
    const t = fakeTls({ default: ["BUNDLED", "EXTRA"], system: ["SYSTEM-1", "SYSTEM-2"] });
    assert.deepEqual(trustSystemCAs({}, t.api, flags), { kind: "applied", count: 2 });
    assert.deepEqual(t.calls, [["BUNDLED", "EXTRA", "SYSTEM-1", "SYSTEM-2"]]);
    // An explicit NODE_USE_SYSTEM_CA=1 changes nothing: still added (Node.js removes duplicates).
    const one = fakeTls({ default: ["BUNDLED", "SYSTEM-1"], system: ["SYSTEM-1"] });
    assert.equal(trustSystemCAs({ NODE_USE_SYSTEM_CA: "1" }, one.api, flags).kind, "applied");
    assert.equal(one.calls.length, 1);

    const off = fakeTls({ default: ["BUNDLED"], system: ["SYSTEM-1"] });
    assert.deepEqual(trustSystemCAs({ NODE_USE_SYSTEM_CA: "0" }, off.api, flags), { kind: "disabled" });
    assert.equal(off.calls.length, 0, "the defaults are left as Node.js has them");

    const none = fakeTls({ default: ["BUNDLED"], system: [] });
    assert.deepEqual(trustSystemCAs({}, none.api, flags), { kind: "empty" });
    assert.equal(none.calls.length, 0);
    const broken = fakeTls({}, new Error("boom"));
    assert.deepEqual(trustSystemCAs({}, broken.api, flags), { kind: "empty", error: "boom" });

    // Node.js before 22.19 / 24.5: no setDefaultCACertificates. Whether --use-system-ca exists decides the advice.
    assert.deepEqual(trustSystemCAs({}, { getCACertificates: () => ["X"] }, flags), { kind: "unsupported", flag: true });
    assert.deepEqual(trustSystemCAs({}, {}, new Set()), { kind: "unsupported", flag: false });
  });

  test("the processes it starts inherit NODE_USE_SYSTEM_CA=1 only when it added the store, never over the user's value", () => {
    const env: NodeJS.ProcessEnv = {};
    inheritSystemCa(env, { kind: "applied", count: 3 });
    assert.equal(env.NODE_USE_SYSTEM_CA, "1");
    const mine: NodeJS.ProcessEnv = { NODE_USE_SYSTEM_CA: "0" };
    inheritSystemCa(mine, { kind: "disabled" });
    assert.equal(mine.NODE_USE_SYSTEM_CA, "0");
    for (const o of [{ kind: "unsupported", flag: true }, { kind: "empty" }] as SystemCaOutcome[]) {
      const e: NodeJS.ProcessEnv = {};
      inheritSystemCa(e, o);
      assert.equal(e.NODE_USE_SYSTEM_CA, undefined);
    }
  });

  test("doctor says what the connector did about the store when Claw's certificate is still not trusted", async () => {
    const dirs = resolveDirs({ CLAW_CONNECTOR_HOME: tmpdir("ca-doc-") } as NodeJS.ProcessEnv);
    const advice = async (systemCa: SystemCaOutcome | null, nodeVersion = "26.12.1") => {
      const r = await checkAll({ dirs, agents: [], by: "doctor", server: "https://claw.test/api" }, defaultDeps({ PATH: "" }, {
        platform: "linux", home: tmpdir("ca-home-"), nodeVersion, systemCa, crontab: async () => null, exec: async () => ({ code: 1, out: "" }),
        get: async () => ({ error: "fetch failed (unable to get local issuer certificate)" }),
      }));
      const p = r.problems.find((x) => x.code === "claw_tls_untrusted");
      assert.ok(p, JSON.stringify(r.problems));
      return { ...p, ok: r.ok };
    };
    const applied = await advice({ kind: "applied", count: 140 });
    assert.match(applied.detail, /although the connector trusts this machine's CA store \(140 certificates\)/);
    assert.match(applied.fix ?? "", /^add the CA that signed Claw's certificate to this machine's trusted CAs/);
    assert.doesNotMatch(applied.fix ?? "", /NODE_USE_SYSTEM_CA=1/, "not the advice the connector already follows");
    assert.ok(applied.ok.includes("Node.js trusts this machine's CA store (140 certificates) as well as its own list"), JSON.stringify(applied.ok));
    assert.match((await advice({ kind: "disabled" })).fix ?? "", /^unset NODE_USE_SYSTEM_CA /);
    const old = await advice({ kind: "unsupported", flag: true }, "22.15.0");
    assert.match(old.detail, /Node\.js 22\.15\.0 cannot add this machine's CA store/);
    assert.match(old.fix ?? "", /^install Node\.js 22\.19\+ or 24\.5\+ .*NODE_OPTIONS=--use-system-ca/);
    assert.doesNotMatch((await advice({ kind: "unsupported", flag: false }, "22.12.0")).fix ?? "", /--use-system-ca/);
    assert.match((await advice({ kind: "empty" })).detail, /CA store is empty/);
  });
});

// --- the real store, through the real CLI -----------------------------------------------------

const hasOpenssl = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = process.platform !== "linux" ? "the system store is read from SSL_CERT_FILE only on Linux" : !hasOpenssl ? "needs openssl" : false;

/** A throwaway CA and a certificate it signed for 127.0.0.1. */
function makeCa(dir: string, name: string): { ca: string; key: string; cert: string } {
  const f = (n: string) => path.join(dir, `${name}-${n}`);
  const run = (args: string[]) => execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", f("ca.key"), "-out", f("ca.pem"), "-days", "2", "-subj", `/CN=claw-connector test CA ${name}`,
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", f("srv.key"), "-out", f("srv.csr"), "-subj", "/CN=127.0.0.1"]);
  fs.writeFileSync(f("ext.cnf"), "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n");
  run(["x509", "-req", "-in", f("srv.csr"), "-CA", f("ca.pem"), "-CAkey", f("ca.key"), "-CAcreateserial", "-out", f("srv.pem"), "-days", "2", "-extfile", f("ext.cnf")]);
  return { ca: f("ca.pem"), key: fs.readFileSync(f("srv.key"), "utf8"), cert: fs.readFileSync(f("srv.pem"), "utf8") };
}

async function healthServer(key: string, cert: string): Promise<{ url: string; close: () => Promise<void> }> {
  const srv = https.createServer({ key, cert }, (req, res) => { res.writeHead(req.url?.endsWith("/health") ? 200 : 404).end("ok"); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `https://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}

/** A process with only the variables named: no NODE_USE_SYSTEM_CA, NODE_EXTRA_CA_CERTS or NODE_OPTIONS from the test's own environment. */
function runClean(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, out, err }));
  });
}

describe("a Claw signed by a CA only this machine trusts", { skip }, () => {
  test("the connector's own TLS defaults carry the system store, and NODE_EXTRA_CA_CERTS stays trusted", { timeout: 60_000 }, async () => {
    const dir = tmpdir("ca-real-");
    const system = makeCa(dir, "system");
    const extra = makeCa(dir, "extra");
    const empty = path.join(dir, "empty");
    fs.mkdirSync(empty);
    const a = await healthServer(system.key, system.cert);
    const b = await healthServer(extra.key, extra.cert);
    try {
      // The module the CLI calls first, then a fetch (what ClawClient, login and doctor use) to each server.
      const script = path.join(dir, "probe.mts");
      fs.writeFileSync(script, `
import tls from "node:tls";
import { trustSystemCAs } from ${JSON.stringify(SYSTEM_CA_TS)};
const fetchAll = async () => Promise.all(process.argv.slice(2).map((u) => fetch(u + "/health").then((r) => r.status, (e) => String(e.cause?.code ?? e))));
const before = await fetchAll();
const outcome = trustSystemCAs(process.env);
const after = await fetchAll();
console.log(JSON.stringify({ outcome, before, after, defaults: tls.getCACertificates("default") }));
`);
      const env = { HOME: dir, SSL_CERT_FILE: system.ca, SSL_CERT_DIR: empty, NODE_EXTRA_CA_CERTS: extra.ca };
      const r = await runClean([script, a.url, b.url], env);
      assert.equal(r.code, 0, r.err);
      const j = JSON.parse(r.out);
      assert.deepEqual(j.outcome, { kind: "applied", count: 1 });
      const caPem = (f: string) => fs.readFileSync(f, "utf8").trim();
      assert.ok(j.defaults.some((c: string) => c.trim() === caPem(system.ca)), "the system store's CA is a default");
      assert.ok(j.defaults.some((c: string) => c.trim() === caPem(extra.ca)), "NODE_EXTRA_CA_CERTS's CA is still a default");
      assert.ok(j.defaults.length > 100, `Node's bundled list is kept (${j.defaults.length})`);
      // Before: the system-signed server is refused (what a fresh install met), the extra one was always trusted.
      assert.match(String(j.before[0]), /^UNABLE_TO_(GET_ISSUER_CERT_LOCALLY|VERIFY_LEAF_SIGNATURE)$/);
      assert.equal(j.before[1], 200);
      assert.deepEqual(j.after, [200, 200]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  test("doctor through the CLI, in a clean environment without NODE_USE_SYSTEM_CA: Claw answers; with NODE_USE_SYSTEM_CA=0 it is untrusted", { timeout: 120_000 }, async () => {
    const dir = tmpdir("ca-cli-");
    const system = makeCa(dir, "system");
    const empty = path.join(dir, "empty");
    fs.mkdirSync(empty);
    const s = await healthServer(system.key, system.cert);
    try {
      const home = path.join(dir, "cc");
      const work = path.join(dir, "work");
      fs.mkdirSync(path.join(home, "config"), { recursive: true });
      fs.mkdirSync(work);
      fs.writeFileSync(path.join(home, "config", "agents.toml"), `name = "ca-test"\nserver = ${JSON.stringify(s.url)}\n[[agents]]\nid = "fake"\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(ADAPTER)}]\nask_mode = "default"\nroots = [${JSON.stringify(work)}]\n`);
      const env = { HOME: dir, CLAW_CONNECTOR_HOME: home, SSL_CERT_FILE: system.ca, SSL_CERT_DIR: empty };
      const doctor = async (extra: Record<string, string> = {}) => {
        const r = await runClean([CLI_TS, "doctor", "--json"], { ...env, ...extra });
        try { return JSON.parse(r.out).environment as { ok: string[]; problems: Array<{ code: string; fix?: string }> }; } catch { assert.fail(`doctor printed no JSON (rc ${r.code}): ${r.out}\n${r.err}`); }
      };
      const on = await doctor();
      assert.ok(on.ok.includes(`Claw answers at ${s.url}`), JSON.stringify(on));
      assert.ok(on.ok.includes("Node.js trusts this machine's CA store (1 certificate) as well as its own list"), JSON.stringify(on.ok));
      assert.ok(!on.problems.some((p) => p.code === "claw_tls_untrusted" || p.code === "claw_unreachable"), JSON.stringify(on.problems));

      const off = await doctor({ NODE_USE_SYSTEM_CA: "0" });
      const t = off.problems.find((p) => p.code === "claw_tls_untrusted");
      assert.ok(t, JSON.stringify(off.problems));
      assert.match(t.fix ?? "", /^unset NODE_USE_SYSTEM_CA /);
      assert.ok(!off.ok.some((l) => l.startsWith("Claw answers")));
    } finally {
      await s.close();
    }
  });
});
