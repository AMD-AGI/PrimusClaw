// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `USER_DATA_PATH` for an app sandbox SaFE set none in.
 *
 * SaFE sets it only from a workspace volume with `enableUserDir`, as
 * `{mountPath}/users/{userId}`; a hostpath workspace without that flag gets
 * nothing. Claw then derives the same path from the workspace's hostpath volumes
 * and the `USER_ID` SaFE sets in every Pod, and creates the directory.
 *
 *   U1 a value SaFE injected wins: nothing is derived or created
 *   U2 absent: derived from the first mounted root, and created
 *   U3 underivable (no USER_ID that names a directory, no mounted root): the expansion refuses
 *   U4 a directory that cannot be created: its own exit status
 *   U5 a real run in such a sandbox: the application gets the derived path, its files land in it
 *   U6 the same run with nothing to derive from fails at once, saying so
 *   U7 the roots are the workspace's hostpath mount paths, from SaFE, in order
 *   U8 a workspace that cannot be read throws (retried); one that is not there has no roots
 *
 * The shell runs in a real `sh` whose environment has no USER_DATA_PATH unless a
 * test puts one there.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppManifestV1 } from "@claw/protocol";

process.env.SAFE_API_URL = "http://safe.test";
const { AppRunner, NO_USER_DATA_DIR_REASON } = await import("../src/apps/app-runner.js");
const { STATE_DIR_NO_USER_DATA, USER_DATA_DIR_NOT_CREATED, expandStateDirCommand, userDataPathPrelude } = await import("../src/apps/app-env.js");
const { hostpathMountPaths, workspaceUserDataRoots } = await import("../src/apps/app-sandbox.js");
const { World, MANIFEST, RUN_ID } = await import("./support/app-runner-world.js");

const dirs: string[] = [];
const fresh = (): string => { const d = mkdtempSync(join(tmpdir(), "claw-udp-")); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** `sh -c command` with exactly `env` (and PATH): no USER_DATA_PATH unless given. */
function sh(command: string, env: Record<string, string>, cwd = tmpdir()): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile("sh", ["-c", command], { cwd, env: { PATH: process.env.PATH ?? "", ...env }, timeout: 20_000 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ exitCode: code, stdout });
    });
  });
}

const TEMPLATE = "${USER_DATA_PATH}/.claw-apps/${run_id}";
const UID = "0123456789abcdef0123456789abcdef";

test("U1 a USER_DATA_PATH SaFE injected wins: nothing is derived or created", async () => {
  const injected = fresh();
  const root = fresh();
  const r = await sh(expandStateDirCommand(TEMPLATE, RUN_ID, [root]), { USER_DATA_PATH: injected, USER_ID: UID });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, `${injected}/.claw-apps/${RUN_ID}`);
  assert.equal(existsSync(join(root, "users")), false, "the derived directory is not made");
});

test("U2 absent: {mountPath}/users/{USER_ID} of the first mounted root, created", async () => {
  const root = fresh();
  const notMounted = join(fresh(), "not-mounted");
  const r = await sh(expandStateDirCommand(TEMPLATE, RUN_ID, [notMounted, root]), { USER_ID: UID });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, `${root}/users/${UID}/.claw-apps/${RUN_ID}`);
  assert.ok(statSync(join(root, "users", UID)).isDirectory());
  assert.equal(existsSync(notMounted), false);
  // An empty value is no value, as for the expansion's own guard.
  const empty = await sh(expandStateDirCommand(TEMPLATE, RUN_ID, [root]), { USER_DATA_PATH: "", USER_ID: UID });
  assert.equal(empty.stdout, `${root}/users/${UID}/.claw-apps/${RUN_ID}`);
});

test("U3 underivable: no USER_ID that names a directory, or no mounted root, and the expansion refuses", async () => {
  const root = fresh();
  for (const env of [{}, { USER_ID: "" }, { USER_ID: "." }, { USER_ID: ".." }, { USER_ID: "a/b" }] as Array<Record<string, string>>) {
    const r = await sh(expandStateDirCommand(TEMPLATE, RUN_ID, [root]), env);
    assert.equal(r.exitCode, STATE_DIR_NO_USER_DATA, JSON.stringify(env));
    assert.equal(r.stdout, "");
  }
  assert.equal(existsSync(join(root, "users")), false);
  const unmounted = await sh(expandStateDirCommand(TEMPLATE, RUN_ID, [join(root, "absent")]), { USER_ID: UID });
  assert.equal(unmounted.exitCode, STATE_DIR_NO_USER_DATA);
  const none = await sh(expandStateDirCommand(TEMPLATE, RUN_ID, []), { USER_ID: UID });
  assert.equal(none.exitCode, STATE_DIR_NO_USER_DATA);
  // A root a shell cannot carry plainly is not used at all.
  assert.equal(userDataPathPrelude(["relative", "/a/../b", "/x y", "/$(id)"]), "");
});

test("U4 a derived directory that cannot be created exits with its own status", async () => {
  const root = fresh();
  writeFileSync(join(root, "users"), "a file where the users directory would be");
  const r = await sh(expandStateDirCommand(TEMPLATE, RUN_ID, [root]), { USER_ID: UID });
  assert.equal(r.exitCode, USER_DATA_DIR_NOT_CREATED);
});

/** A runner whose every command runs in a real shell with `env` as the sandbox's own environment. */
function shellRunner(env: Record<string, string>, roots: string[] | ((ws: string | undefined) => Promise<string[]>), script: string) {
  const manifest: AppManifestV1 = {
    ...MANIFEST, command: ["sh", "-c", script], events: undefined, mcp: undefined, restart: { max_restarts: 3, backoff_sec: [30, 120, 900] },
  };
  const world = new World(manifest);
  const commands: string[] = [];
  world.sandbox = {
    ...world.sandbox,
    exec: async (_inst, command, _t, opts) => { commands.push(command); return { ...(await sh(command, { ...env, ...(opts?.env ?? {}) })), stderr: "" }; },
    stop: async () => undefined,
    userDataRoots: async (run) => (typeof roots === "function" ? roots(run.workspaceId) : roots),
  };
  const runner = new AppRunner(RUN_ID, "pk", { store: world.store, sandbox: world.sandbox, tickMs: 100 });
  return { world, runner, commands };
}

test("U5 a real run in a sandbox SaFE gave no USER_DATA_PATH: the application gets the derived one, its files land in it", async () => {
  const root = fresh();
  const asked: Array<string | undefined> = [];
  const { world, runner } = shellRunner({ USER_ID: UID }, async (ws) => { asked.push(ws); return [root]; },
    'printf %s "$USER_DATA_PATH" > "$APP_STATE_DIR/udp.txt"; printf \'{"final":true,"returncode":0}\' > "$APP_STATE_DIR/exit.json"');
  const result = await runner.run(AbortSignal.timeout(30_000));
  const userDir = `${root}/users/${UID}`;
  const stateDir = `${userDir}/.claw-apps/${RUN_ID}`;
  assert.deepEqual(result, { kind: "ended", outcome: { success: true, reason: "app finished", captures: { session_dir: stateDir } } });
  assert.equal(world.rec.state_dir, stateDir);
  assert.equal(readFileSync(`${stateDir}/udp.txt`, "utf8"), userDir, "the application sees the same USER_DATA_PATH");
  // Inside the user directory, so the user's other accounts may read what the runner wrote.
  assert.equal(statSync(`${stateDir}/input.json`).mode & 0o777, 0o640);
  assert.deepEqual(asked, ["ws-1"], "the run's workspace, read once");
});

test("U6 the same run with nothing to derive from fails at once, saying so, with nothing started", async () => {
  const { world, runner, commands } = shellRunner({ USER_ID: UID }, [], "echo never > never.txt");
  const result = await runner.run(AbortSignal.timeout(30_000));
  assert.equal(result.kind, "ended");
  assert.ok(result.kind === "ended" && !result.outcome.success);
  assert.ok(result.kind === "ended" && result.outcome.reason.includes(NO_USER_DATA_DIR_REASON));
  assert.equal(world.rec.restarts, 0);
  assert.equal(commands.some((c) => c.includes("setsid")), false);
});

test("U7 the roots are the workspace's hostpath mount paths, in its order, plain paths only", () => {
  assert.deepEqual(hostpathMountPaths({
    volumes: [
      { id: 1, type: "pfs", mountPath: "/pfs" },
      { id: 2, type: "hostpath", hostPath: "/shared_nfs", mountPath: "/shared_nfs", accessMode: "ReadWriteMany" },
      { id: 3, type: "hostpath", hostPath: "/x", mountPath: "relative" },
      { id: 4, type: "hostpath", hostPath: "/data", mountPath: "/data", enableUserDir: false },
      { id: 5, type: "hostpath", hostPath: "/dup", mountPath: "/shared_nfs" },
      null,
    ],
  }), ["/shared_nfs", "/data"]);
  assert.deepEqual(hostpathMountPaths({ workspaceId: "w" }), [], "SaFE omits volumes when there are none");
  assert.throws(() => hostpathMountPaths(null));
  assert.throws(() => hostpathMountPaths({ volumes: "x" }));
});

test("U8 the workspace is read with the owner's key; unreadable throws, absent or refused has no roots", async () => {
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const answer = (status: number, body: unknown) => (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const vols = { volumes: [{ type: "hostpath", mountPath: "/shared_nfs" }] };
  assert.deepEqual(await workspaceUserDataRoots("team-a", "key-1", answer(200, vols)), ["/shared_nfs"]);
  assert.deepEqual(seen[0], { url: "http://safe.test/api/v1/workspaces/team-a", auth: "Bearer key-1" });
  for (const status of [401, 403, 404]) assert.deepEqual(await workspaceUserDataRoots("w", "k", answer(status, {})), []);
  for (const status of [500, 502, 503]) await assert.rejects(workspaceUserDataRoots("w", "k", answer(status, {})), /HTTP/);
  await assert.rejects(workspaceUserDataRoots("w", "k", (async () => { throw new TypeError("fetch failed"); }) as typeof fetch));
});
