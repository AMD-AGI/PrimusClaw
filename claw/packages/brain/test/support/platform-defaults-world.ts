// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A small world for engine-level platform-default tests: a fake marketplace
 * (tool list + ZIP download), a fake Anthropic streaming endpoint that replays
 * scripted turns and records every request body, and a recording Hands stand-in.
 * Env is set here, before the test imports the engine, because config.ts reads
 * it once at import.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import AdmZip from "adm-zip";

export type Turn = { text: string } | { tool: string; input: Record<string, unknown> };

export function skillZip(name: string, body: string, description: string, wrap = ""): Buffer {
  const zip = new AdmZip();
  const pre = wrap ? `${wrap}/` : "";
  zip.addFile(`${pre}SKILL.md`, Buffer.from(`---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`));
  zip.addFile(`${pre}references/extra.md`, Buffer.from("extra"));
  return zip.toBuffer();
}

export interface World {
  llmBodies: string[];
  downloads: number[];
  listCalls: number;
  setTools(t: Array<{ id: number; name: string; zip?: Buffer; fail?: boolean; type?: string; version?: string | null; hang?: boolean }>): void;
  byIdCalls: number[];
  script(turns: Turn[]): void;
  close(): Promise<void>;
}

function sse(res: http.ServerResponse, turn: Turn, n: number): void {
  const ev = (e: string, d: unknown) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
  res.writeHead(200, { "content-type": "text/event-stream" });
  ev("message_start", { type: "message_start", message: { id: `m${n}`, type: "message", role: "assistant", model: "m", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
  if ("text" in turn) {
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: turn.text } });
  } else {
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `tu${n}`, name: turn.tool, input: {} } });
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(turn.input) } });
  }
  ev("content_block_stop", { type: "content_block_stop", index: 0 });
  ev("message_delta", { type: "message_delta", delta: { stop_reason: "text" in turn ? "end_turn" : "tool_use" }, usage: { output_tokens: 1 } });
  ev("message_stop", { type: "message_stop" });
  res.end();
}

export async function startWorld(defaultsFile?: object): Promise<World> {
  let tools: Parameters<World["setTools"]>[0] = [];
  let turns: Turn[] = [];
  let turnN = 0;
  const world: World = {
    llmBodies: [], downloads: [], listCalls: 0, byIdCalls: [],
    setTools(t) { tools = t; },
    script(t) { turns = t; turnN = 0; },
    close: async () => { await new Promise<void>((r) => server.close(() => r())); },
  };
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    const byId = url.match(/^\/claw-api\/v1\/tools\/(\d+)$/);
    if (byId) {
      const id = Number(byId[1]);
      world.byIdCalls.push(id);
      const t = tools.find((x) => x.id === id);
      if (t?.hang) return;
      res.setHeader("content-type", "application/json");
      if (!t) { res.statusCode = 404; res.end(JSON.stringify({ ok: false })); return; }
      res.end(JSON.stringify({ ok: true, data: { id: t.id, name: t.name, type: t.type ?? "skill", ...(t.version === null ? {} : { updated_at: t.version ?? "v1" }) } }));
      return;
    }
    if (url.startsWith("/claw-api/v1/tools") && !url.includes("/download")) {
      world.listCalls++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: { tools: tools.map((t) => ({ id: t.id, name: t.name, type: t.type ?? "skill", updated_at: "v1" })) } }));
      return;
    }
    const dl = url.match(/\/tools\/(\d+)\/download/);
    if (dl) {
      const id = Number(dl[1]);
      world.downloads.push(id);
      const t = tools.find((x) => x.id === id);
      if (!t || t.fail) { res.statusCode = 500; res.end("boom"); return; }
      res.setHeader("content-type", "application/zip");
      res.end(t.zip);
      return;
    }
    if (url.includes("/v1/messages")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        world.llmBodies.push(body);
        sse(res, turns[turnN] ?? { text: "done" }, turnN);
        turnN++;
      });
      return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.SAFE_API_URL = base;
  process.env.ANTHROPIC_BASE_URL = base;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.WEB_SEARCH_PROVIDER = "disabled";
  if (defaultsFile) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-pd-test-"));
    const f = path.join(dir, "defaults.json");
    fs.writeFileSync(f, JSON.stringify(defaultsFile));
    process.env.PLATFORM_DEFAULTS_FILE = f;
  }
  return world;
}

/** Hands stand-in: records every call in order; `read` of a skill returns its body. */
export function fakeHands() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const hands = {
    calls,
    async callTool(name: string, args: Record<string, unknown>) { calls.push({ name, args }); return "ok"; },
    async callToolFull(name: string, args: Record<string, unknown>) { calls.push({ name, args }); return { text: "file contents", isError: false }; },
  };
  return hands;
}

export function baseRequest(over: Record<string, unknown> = {}) {
  return {
    session_id: "s1", user_id: "u1", prompt: "hello there", model: "m",
    platform_key: "ak-user-key", ...over,
  } as never;
}
