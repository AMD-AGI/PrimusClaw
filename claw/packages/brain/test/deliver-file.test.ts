// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `deliver_file`: a sandbox file is copied to the session's delivery directory
 * and the tool's terminal event says what the user got.
 *
 * Hands is a stand-in that answers `stat` and `upload_to_s3` the way the real
 * tools do; the presigner is stubbed, so the object key the copy is PUT to is
 * what is asserted -- that key is what the API reads back.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DELIVERY_DIR, type ToolSchema } from "@claw/protocol";
import type { LlmContentBlock, LlmSession, LlmTurnResult } from "../src/llm/provider.js";
import { agentLoop, type LoopOptions } from "../src/agent/agent-loop.js";
import { ToolRouter } from "../src/tools/router.js";
import { DELIVER_FILE_TOOL, deliverFile, deliverPorts, workspaceFilePath } from "../src/tools/deliver-file.js";
import { isPruneExempt, isRestoreSkipped } from "../src/workspace/s3-uploader.js";
import { WORKSPACE_EXCLUDES } from "../src/workspace/excludes.js";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

/** `real`: where the path resolves (a link); `content`: the bytes, for an inline read; `root`: what /workspace resolves to. */
interface FakeFile { type?: string; size: number; real?: string; content?: Buffer }
const unquote = (w: string) => w.replace(/'\\''/g, "'");
function fakeHands(files: Record<string, FakeFile>, upload: "ok" | "fail" = "ok", root = "/workspace") {
  const calls: Array<{ name: string; args: Record<string, any> }> = [];
  const hands = {
    async callTool(name: string, args: Record<string, any>): Promise<string> {
      calls.push({ name, args });
      const command = args.command as string;
      if (name === "bash" && command.startsWith("stat ")) {
        const p = unquote(/^stat -L -c '[^']*' -- '((?:[^']|'\\'')*)' 2>&1 && /.exec(command)![1]);
        const f = files[p];
        if (!f) return `stat: cannot statx '${p}': No such file or directory\n\nExit code: 1`;
        const resolved = Buffer.from(`${root}\0${f.real ?? p.replace(/^\/workspace/, root)}\0`, "utf8").toString("base64");
        return `__claw_deliver_stat__${f.type ?? (f.size ? "regular file" : "regular empty file")}|${f.size}\n`
          + `__claw_deliver_real__${resolved}\n`;
      }
      if (name === "bash" && command.includes("base64 -w0")) {
        const p = unquote(/base64 -w0 -- '((?:[^']|'\\'')*)'/.exec(command)![1]);
        const f = Object.entries(files).find(([k, v]) => (v.real ?? k.replace(/^\/workspace/, root)) === p)?.[1];
        return `__claw_deliver_data__${f?.content?.toString("base64") ?? ""}\n`;
      }
      if (name === "upload_to_s3") {
        const local = args.files[0].local_path as string;
        return JSON.stringify(upload === "ok"
          ? { ok: [local], failed: [], total: 1 }
          : { ok: [], failed: [{ path: local, status: 403, error: "AccessDenied" }], total: 1 });
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };
  return { hands: hands as never, calls };
}

const presigned: string[] = [];
beforeEach(() => {
  presigned.length = 0;
  deliverPorts.presignPut = async (key: string) => { presigned.push(key); return `https://store.invalid/${key}?sig`; };
  deliverPorts.newId = () => ID;
});

const CTX = { userId: "u-1", sessionId: "s-1", maxBytes: 1000 };

test("a path is a file under /workspace, absolute or relative, and nothing else", () => {
  const rows: Array<[unknown, string | null]> = [
    ["out/chart.png", "/workspace/out/chart.png"],
    ["/workspace/report.xlsx", "/workspace/report.xlsx"],
    ["./a/../b.txt", "/workspace/b.txt"],
    ["/etc/passwd", null],
    ["../etc/passwd", null],
    ["/workspace", null],
    ["/workspace/", null],
    ["/workspacex/a", null],
    ["", null],
    ["a\0b", null],
    [42, null],
  ];
  for (const [input, want] of rows) assert.equal(workspaceFilePath(input), want, String(input));
});

test("a file is copied to <session prefix>.deliveries/<id>/<name> and described", async () => {
  const { hands, calls } = fakeHands({ "/workspace/out/chart.png": { size: 640 } });
  const r = await deliverFile(hands, { ...CTX, maxBytes: 100_000 }, { path: "out/chart.png", caption: "  CPU vs GPU\n  per node " });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.delivery, { id: ID, name: "chart.png", size: 640, content_type: "image/png", caption: "CPU vs GPU per node" },
    "an image whose bytes could not be read as its size carries none");
  assert.deepEqual(presigned, [`users/u-1/sessions/s-1/${DELIVERY_DIR}/${ID}/chart.png`]);
  const upload = calls.find((c) => c.name === "upload_to_s3")!;
  assert.deepEqual(upload.args.files, [{ local_path: "/workspace/out/chart.png", presigned_url: `https://store.invalid/${presigned[0]}?sig` }]);
});

test("refusals: outside /workspace, missing, a directory, too large, an upload that failed", async () => {
  const files = {
    "/workspace/dir": { type: "directory", size: 4096 }, "/workspace/big.bin": { size: 1001 }, "/workspace/a.txt": { size: 3 },
    "/workspace/link.txt": { size: 9, real: "/etc/passwd" }, "/workspace/dirlink/x.txt": { size: 9, real: "/root/x.txt" },
    "/workspace/lookalike.txt": { size: 9, real: "/workspace2/x.txt" },
    // A link target may hold a newline: the name is read whole, never cut at the line.
    "/workspace/nl.txt": { size: 9, real: "/workspace/report\n__claw_deliver_real__/workspace/notes.csv" },
    // An answer that is not exactly two names is no answer.
    "/workspace/three.txt": { size: 9, real: "/workspace/a\0/workspace/b" },
  };
  const rows: Array<[Record<string, unknown>, RegExp, "ok" | "fail"]> = [
    [{ path: "/etc/passwd" }, /under \/workspace/, "ok"],
    [{ path: "nope.txt" }, /does not exist/, "ok"],
    [{ path: "dir" }, /is a directory, not a file/, "ok"],
    [{ path: "big.bin" }, /1001 bytes; at most 1000/, "ok"],
    [{ path: "a.txt" }, /could not be copied for delivery: AccessDenied/, "fail"],
    [{ path: "link.txt" }, /resolves to a file outside \/workspace/, "ok"],
    [{ path: "dirlink/x.txt" }, /resolves to a file outside \/workspace/, "ok"],
    [{ path: "lookalike.txt" }, /resolves to a file outside \/workspace/, "ok"],
    [{ path: "a\nb.txt" }, /under \/workspace/, "ok"],
    [{ path: "three.txt" }, /resolves to a file outside \/workspace/, "ok"],
  ];
  // The newline target is a real file inside the workspace: it is delivered as itself, whole.
  const { hands: nlHands, calls: nlCalls } = fakeHands(files);
  const nl = await deliverFile(nlHands, CTX, { path: "nl.txt" });
  assert.ok(nl.ok, JSON.stringify(nl));
  assert.equal(nlCalls.find((c) => c.name === "upload_to_s3")!.args.files[0].local_path,
    "/workspace/report\n__claw_deliver_real__/workspace/notes.csv");
  for (const [input, want, upload] of rows) {
    const { hands, calls } = fakeHands(files, upload);
    const r = await deliverFile(hands, CTX, input);
    assert.ok(!r.ok, String(input.path));
    assert.match(r.error, want);
    if (upload === "ok") assert.ok(!calls.some((c) => c.name === "upload_to_s3"), `${input.path}: nothing is copied`);
  }
});

test("an empty file is a file; the path reaches the shell as one quoted word", async () => {
  const odd = "/workspace/it's $(rm -rf x) `y`.txt";
  const { hands, calls } = fakeHands({ [odd]: { size: 0 } });
  const r = await deliverFile(hands, CTX, { path: odd });
  assert.ok(r.ok, JSON.stringify(r));
  const quoted = `'/workspace/it'\\''s $(rm -rf x) \`y\`.txt'`;
  assert.equal(calls[0].args.command, `stat -L -c '__claw_deliver_stat__%F|%s' -- ${quoted} 2>&1`
    + ` && printf '__claw_deliver_real__%s\\n' "$(realpath -ez -- /workspace ${quoted} | base64 -w0)"`);
  assert.equal(r.delivery.content_type, "text/plain");
});

test("a link inside the workspace is delivered as the file it resolves to, also when /workspace itself is a link", async () => {
  const { hands, calls } = fakeHands({ "/workspace/latest.csv": { size: 5, real: "/data/ws/runs/7/out.csv" } }, "ok", "/data/ws");
  const r = await deliverFile(hands, CTX, { path: "latest.csv" });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.delivery.name, "latest.csv", "offered under the name the agent gave");
  assert.equal(calls.find((c) => c.name === "upload_to_s3")!.args.files[0].local_path, "/data/ws/runs/7/out.csv", "the resolved file is what is copied");
});

test("a small image carries its bytes for a client to show; a large one, or another type, does not", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 4]);
  const big = Buffer.alloc(15_001, 1);
  const { hands } = fakeHands({
    "/workspace/c.png": { size: png.length, content: png },
    "/workspace/big.png": { size: big.length, content: big },
    "/workspace/c.csv": { size: png.length, content: png },
    "/workspace/lies.png": { size: png.length + 1, content: png },
  });
  const ctx = { ...CTX, maxBytes: 100_000 };
  const small = await deliverFile(hands, ctx, { path: "c.png" });
  assert.ok(small.ok);
  assert.equal(small.delivery.data_base64, png.toString("base64"));
  for (const path of ["big.png", "c.csv", "lies.png"]) {
    const r = await deliverFile(hands, ctx, { path });
    assert.ok(r.ok, path);
    assert.ok(!("data_base64" in r.delivery), path);
  }
});

test("the delivered copies belong to Brain: never pruned, never restored into the sandbox, never uploaded from it", () => {
  assert.equal(isPruneExempt(`${DELIVERY_DIR}/${ID}/chart.png`), true);
  assert.equal(isRestoreSkipped(`${DELIVERY_DIR}/${ID}/chart.png`), true);
  assert.ok(WORKSPACE_EXCLUDES.includes(DELIVERY_DIR as never));
  assert.equal(isPruneExempt("deliveries/chart.png"), false, "only the reserved directory");
});

// --- through the router and the real loop ---------------------------------------------------

function scripted(turns: Array<Partial<LlmTurnResult>>): LlmSession {
  let i = 0;
  return {
    async streamTurn() {
      const turn = turns[i++];
      if (!turn) throw new Error("scripted session exhausted");
      return {
        content: turn.content ?? [], stopReason: turn.stopReason ?? "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 }, firstByteMs: 1,
      };
    },
    async complete() { return ""; },
  };
}
const toolUse = (id: string, name: string, input: Record<string, unknown>): LlmContentBlock => ({ type: "tool_use", id, name, input });

async function runDeliver(router: ToolRouter, input: Record<string, unknown>) {
  const events: Array<Record<string, any>> = [];
  const opts = {
    model: "m", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 3, router,
    onEvent: async (e: unknown) => { events.push(e as Record<string, any>); },
    sessionId: "s-1", userId: "u-1",
    llmSession: scripted([
      { content: [toolUse("t1", DELIVER_FILE_TOOL, input)], stopReason: "tool_use" },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
  } as unknown as LoopOptions;
  await agentLoop([{ role: "user", content: "send me the chart" }], router.getToolSchemas() as ToolSchema[], opts);
  return events.filter((e) => e.type === "toolUsed" && e.tool === DELIVER_FILE_TOOL && e.status !== "start");
}

test("the tool is offered, and its terminal event carries the delivery; a refused one carries none", async () => {
  const { hands } = fakeHands({ "/workspace/r.xlsx": { size: 10 } });
  const router = new ToolRouter(hands);
  router.a2aContext = { userId: "u-1", sessionId: "s-1" };
  assert.ok(router.getToolSchemas().some((t) => t.name === DELIVER_FILE_TOOL));
  const [done] = await runDeliver(router, { path: "r.xlsx" });
  assert.equal(done.status, "success");
  assert.deepEqual(done.delivery, {
    id: ID, name: "r.xlsx", size: 10, content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  assert.deepEqual(presigned, [`users/u-1/sessions/s-1/${DELIVERY_DIR}/${ID}/r.xlsx`]);

  const [refused] = await runDeliver(router, { path: "missing.txt" });
  assert.match(refused.description, /does not exist/);
  assert.ok(!("delivery" in refused));
});

test("the owner segment is the sync's: no user id is `default`, and no session is a refusal", async () => {
  const { hands } = fakeHands({ "/workspace/a.txt": { size: 1 } });
  const router = new ToolRouter(hands);
  router.a2aContext = { sessionId: "s-9" };
  const outcome: { isError: boolean; delivery?: unknown } = { isError: false };
  await router.route(DELIVER_FILE_TOOL, { path: "a.txt" }, undefined, outcome);
  assert.deepEqual(presigned, [`users/default/sessions/s-9/${DELIVERY_DIR}/${ID}/a.txt`]);
  assert.equal(outcome.isError, false);

  const none = new ToolRouter(hands);
  const refused = { isError: false };
  assert.match(await none.route(DELIVER_FILE_TOOL, { path: "a.txt" }, undefined, refused), /needs a session/);
  assert.equal(refused.isError, true);
});

test("a sub-agent is never offered the tool, even with every tool allowed: delivering is the main agent's", async () => {
  const { runSubagent } = await import("../src/agent/sub-agent.js");
  const { AnthropicProvider } = await import("../src/llm/anthropic-provider.js");
  const offered: string[][] = [];
  const original = AnthropicProvider.prototype.createSession;
  AnthropicProvider.prototype.createSession = (() => ({
    async streamTurn(_m: unknown, tools: ToolSchema[]) {
      offered.push(tools.map((t) => t.name));
      return { content: [{ type: "text", text: "done" }], stopReason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 }, firstByteMs: 1 };
    },
    async complete() { return ""; },
  })) as never;
  try {
    const { hands } = fakeHands({});
    const parentSchemas = new ToolRouter(hands).getToolSchemas();
    assert.ok(parentSchemas.some((t) => t.name === DELIVER_FILE_TOOL));
    await runSubagent({
      description: "d", prompt: "p", subagentType: "generalPurpose", parentSchemas, hands,
      onEvent: async () => {}, model: "claude-x", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 2, sessionId: "s", depth: 1,
    } as never);
  } finally {
    AnthropicProvider.prototype.createSession = original;
  }
  assert.equal(offered.length, 1);
  assert.ok(offered[0].includes("bash") && !offered[0].includes(DELIVER_FILE_TOOL), offered[0].join(","));
});
