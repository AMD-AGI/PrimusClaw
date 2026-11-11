// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Runs the deployable Teams ingress (the zip scripts/build-ingress.ts builds) in a real Azure Functions host, Core
 * Tools' `func start`, and checks its answers on the product path, with tokens signed by a throwaway key that a local
 * OpenID/JWKS server publishes (BOT_OPENID_CONFIG_URL):
 *
 *   no token                               401, and one token_rejected event (missing_token) in the invocation's log
 *   a valid token, a message-extension     200 with the empty composeExtension result (nothing queued)
 *   a valid token, a body that is not JSON 400
 *   a valid token, a message               500: the inbound queue is an unresolvable namespace, so the send fails,
 *                                          and Teams would retry
 *
 * The zip is unpacked by Python's zipfile, not by this repository's code.
 *
 * The host's Node worker runs the `node` on PATH. With `--node <major>`, the smoke first checks that this `node` is that
 * major version, so a run meant for Node 24 cannot pass on another.
 *
 *   node --import tsx scripts/ingress-host-smoke.ts --zip <zip> --func <path to func> [--port 7072] [--node 24]
 */
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const APP_ID = "00000000-0000-0000-0000-0000000000a1";
const ISSUER = "https://api.botframework.com";
const SERVICE_URL = "https://smba.trafficmanager.net/teams/";

const b64url = (data: Buffer | string): string => Buffer.from(data).toString("base64url");

interface Signer {
  jwks: unknown;
  token(): string;
}

function signer(): Signer {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    jwks: { keys: [{ ...jwk, kid: "smoke", use: "sig", alg: "RS256" }] },
    token: () => {
      const now = Math.trunc(Date.now() / 1000);
      const claims = { iss: ISSUER, aud: APP_ID, exp: now + 600, nbf: now - 60, serviceurl: SERVICE_URL };
      const input = `${b64url(JSON.stringify({ alg: "RS256", kid: "smoke", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
      return `${input}.${b64url(sign("RSA-SHA256", Buffer.from(input), privateKey))}`;
    },
  };
}

/** The local OpenID metadata and JWKS; its base URL. */
async function keyServer(keys: Signer): Promise<{ base: string; close: () => void }> {
  const server = createServer((req, res) => {
    const body =
      req.url === "/openid"
        ? { jwks_uri: `http://127.0.0.1:${String(port())}/jwks` }
        : req.url === "/jwks"
          ? keys.jwks
          : null;
    res.writeHead(body === null ? 404 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body ?? {}));
  });
  const port = (): number => (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${String(port())}`, close: () => server.close() };
}

interface Case {
  readonly name: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly status: number;
  readonly answer?: unknown;
}

function cases(token: string): Case[] {
  const bearer = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const activity = (extra: Record<string, unknown>): string =>
    JSON.stringify({ id: "a1", serviceUrl: SERVICE_URL, conversation: { id: "19:smoke@thread.v2" }, ...extra });
  return [
    {
      name: "no token",
      headers: { "Content-Type": "application/json" },
      body: activity({ type: "message" }),
      status: 401,
    },
    {
      name: "a message-extension query",
      headers: bearer,
      body: activity({ type: "invoke", name: "composeExtension/query" }),
      status: 200,
      answer: { composeExtension: { type: "result", attachments: [] } },
    },
    { name: "a body that is not JSON", headers: bearer, body: "not json", status: 400 },
    { name: "a message, the queue unreachable", headers: bearer, body: activity({ type: "message" }), status: 500 },
  ];
}

async function waitFor(file: string, pattern: RegExp, seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds * 2; i++) {
    if (pattern.test(fs.readFileSync(file, "utf8"))) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function run(zip: string, func: string, port: number): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ingress-host-smoke-"));
  const keys = signer();
  const server = await keyServer(keys);
  const log = path.join(dir, "func.log");
  const problems: string[] = [];
  let host: ReturnType<typeof spawn> | undefined;
  try {
    const app = path.join(dir, "app");
    const unzip = spawnSync("python3", ["-m", "zipfile", "-e", zip, app], { encoding: "utf8" });
    if (unzip.status !== 0) return [`could not unpack ${zip}: ${unzip.stderr}`];
    const values = {
      FUNCTIONS_WORKER_RUNTIME: "node",
      PRIMUSCLAW_BOT_APP_ID: APP_ID,
      BOT_OPENID_CONFIG_URL: `${server.base}/openid`,
      // A namespace that cannot resolve: the send fails, and the request is a 500.
      PRIMUSCLAW_SERVICEBUS_CONNECTION_STRING:
        "Endpoint=sb://ingress-smoke.invalid/;SharedAccessKeyName=send;SharedAccessKey=not-a-key",
    };
    fs.writeFileSync(path.join(app, "local.settings.json"), JSON.stringify({ IsEncrypted: false, Values: values }));
    const out = fs.openSync(log, "w");
    host = spawn(func, ["start", "--port", String(port)], {
      cwd: app,
      stdio: ["ignore", out, out],
      detached: true,
      env: { ...process.env, FUNCTIONS_CORE_TOOLS_TELEMETRY_OPTOUT: "1", NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
    });
    if (!(await waitFor(log, /messages: \[POST\]/, 120)))
      return [`the host did not list the messages function:\n${tail(log)}`];
    for (const c of cases(keys.token())) {
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/messages`, {
        method: "POST",
        headers: c.headers,
        body: c.body,
        signal: AbortSignal.timeout(60_000),
      });
      const text = await response.text();
      if (response.status !== c.status)
        problems.push(`${c.name}: ${String(response.status)}, expected ${String(c.status)}`);
      if (c.answer !== undefined && JSON.stringify(JSON.parse(text || "null")) !== JSON.stringify(c.answer)) {
        problems.push(`${c.name}: answered ${text}`);
      }
    }
    if (!(await waitFor(log, /\{"event":"token_rejected","reason":"missing_token"/, 10))) {
      problems.push("no token_rejected event (missing_token) in the host's log");
    }
    if (!(await waitFor(log, /failed to enqueue activity/, 10)))
      problems.push("no 'failed to enqueue activity' in the log");
    if (problems.length > 0) problems.push(`the host's log:\n${tail(log)}`);
    return problems;
  } finally {
    // The host and its Node worker: the process group this script started.
    if (host?.pid !== undefined) process.kill(-host.pid, "SIGTERM");
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function tail(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !line.startsWith('{"EventType"'))
    .slice(-40)
    .join("\n");
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      zip: { type: "string" },
      func: { type: "string" },
      port: { type: "string", default: "7072" },
      node: { type: "string" },
    },
  });
  if (values.zip === undefined || values.func === undefined) {
    console.error("usage: ingress-host-smoke.ts --zip <zip> --func <func> [--port N] [--node MAJOR]");
    process.exit(2);
  }
  // The `node` the host's worker will run: the first on PATH.
  const nodeVersion = spawnSync("node", ["--version"], { encoding: "utf8" }).stdout.trim();
  if (values.node !== undefined && !nodeVersion.startsWith(`v${values.node}.`)) {
    console.error(`ingress-host-smoke: the node on PATH is ${nodeVersion || "missing"}, not Node ${values.node}`);
    process.exit(1);
  }
  const problems = await run(path.resolve(values.zip), values.func, Number(values.port));
  for (const p of problems) console.error(`ingress-host-smoke: ${p}`);
  if (problems.length > 0) process.exit(1);
  console.log(
    `ingress-host-smoke: the Function package answers 401, 200, 400 and 500 in a Functions host on Node ${nodeVersion} as expected`,
  );
}
