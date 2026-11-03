// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An image a tool answers with (`read` of a picture) reaches the model as an
 * image block inside the tool_result, the conversation keeps only the newest
 * images within a budget, and the OpenAI-shaped wire, which takes no image in a
 * tool message, names the image instead of pasting its base64 as text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import type { LlmSession, LlmTurnResult } from "../src/llm/provider.js";
import type { ToolRouter } from "../src/tools/router.js";
import { agentLoop, type LoopOptions } from "../src/agent/agent-loop.js";
import { toolImages } from "../src/clients/hands.js";
import { toOpenAiMessages } from "../src/llm/openai-provider.js";
import {
  boundHistoryImages, IMAGE_DROPPED_TEXT, toolResultContent, toolResultText,
} from "../src/llm/tool-images.js";

const usage = { input_tokens: 10, output_tokens: 1, cache_create: 0, cache_read: 0 };
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

function scripted(turns: Array<{ content: unknown[]; stopReason: string }>) {
  const sent: Message[][] = [];
  const session: LlmSession = {
    async streamTurn(messages) {
      sent.push(structuredClone(messages));
      const next = turns.shift();
      if (!next) throw new Error("the loop asked for more turns than the script has");
      return { ...next, usage, firstByteMs: 1, promptTokens: 10 } as unknown as LlmTurnResult;
    },
    async complete() { return "summary"; },
  };
  return { session, sent };
}

test("a tool's image is sent to the model inside its tool_result, after the text", async () => {
  const { session, sent } = scripted([
    { content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "/workspace/.uploads/a.png" } }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "a red square" }], stopReason: "end_turn" },
  ]);
  const router = {
    route: async (_name: string, _input: unknown, _signal: unknown, outcome?: { images?: unknown }) => {
      if (outcome) outcome.images = [{ mediaType: "image/png", data: PNG_B64 }];
      return "Image /workspace/.uploads/a.png (image/png, 70 bytes)";
    },
    setHands: () => {},
  } as unknown as ToolRouter;
  const options: LoopOptions = {
    model: "m", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 5, depth: 0, router,
    sessionId: "s-img", userId: "u", llmSession: session, onEvent: async () => {},
  };
  await agentLoop([{ role: "user", content: "what is in it?" }], [] as ToolSchema[], options);

  const last = sent[1][sent[1].length - 1];
  const result = (last.content as Array<Record<string, unknown>>)[0];
  assert.equal(result.type, "tool_result");
  assert.deepEqual(result.content, [
    { type: "text", text: "Image /workspace/.uploads/a.png (image/png, 70 bytes)" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
  ]);
});

test("a tool that answered with text only keeps a plain string result", () => {
  assert.equal(toolResultContent("ok", undefined), "ok");
  assert.equal(toolResultContent("ok", []), "ok");
});

test("the image blocks of a Hands result are read, and nothing else is", () => {
  assert.deepEqual(toolImages([
    { type: "text", text: "Image x.png" },
    { type: "image", data: PNG_B64, mimeType: "image/png" },
    { type: "image", data: "", mimeType: "image/png" },
    { type: "image", data: "AAAA", mimeType: "application/pdf" },
    { type: "resource", data: "AAAA", mimeType: "image/png" },
  ]), [{ mediaType: "image/png", data: PNG_B64 }]);
  assert.equal(toolImages([{ type: "text", text: "only text" }]), undefined);
  assert.equal(toolImages(undefined), undefined);
});

function imageResult(id: string, size: number): Message {
  return {
    role: "user",
    content: [{
      type: "tool_result", tool_use_id: id,
      content: toolResultContent(`Image ${id}`, [{ mediaType: "image/png", data: "A".repeat(size) }]),
    }],
  };
}

function imagesIn(messages: Message[]): string[] {
  return messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .flatMap((b: Record<string, unknown>) => (Array.isArray(b.content) ? b.content : []))
    .filter((b: Record<string, unknown>) => b.type === "image")
    .map((b: Record<string, unknown>) => String((b.source as { data: string }).data.length));
}

test("the history keeps the newest images within the budget and names the older ones", () => {
  const messages = [imageResult("old", 40), imageResult("middle", 40), imageResult("new", 40)];
  const dropped = boundHistoryImages(messages, 100);
  assert.equal(dropped, 1);
  assert.deepEqual(imagesIn(messages), ["40", "40"], "the two newest images stay");
  const oldest = (messages[0].content as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>;
  assert.deepEqual(oldest, [{ type: "text", text: "Image old" }, { type: "text", text: IMAGE_DROPPED_TEXT }]);
});

test("the history bound leaves a conversation within budget untouched", () => {
  const messages = [imageResult("a", 40), imageResult("b", 40)];
  const before = structuredClone(messages);
  assert.equal(boundHistoryImages(messages, 100), 0);
  assert.deepEqual(messages, before);
});

test("the OpenAI wire names an image in a tool result instead of sending its base64 as text", () => {
  const wire = toOpenAiMessages([imageResult("t1", 40)]);
  assert.equal(wire.length, 1);
  const content = String((wire[0] as { content: unknown }).content);
  assert.match(content, /^Image t1\n\[image not shown:/);
  assert.ok(!content.includes("A".repeat(40)), "no base64 in the text");
});

test("a tool result is read as text with its images named", () => {
  assert.equal(toolResultText("plain"), "plain");
  assert.equal(toolResultText(toolResultContent("Image a", [{ mediaType: "image/png", data: "AAAA" }])), "Image a\n[image]");
});

test("the router hands a sandbox tool's images to its caller", async () => {
  const { ToolRouter } = await import("../src/tools/router.js");
  const images = [{ mediaType: "image/png", data: PNG_B64 }];
  const hands = { callToolFull: async () => ({ text: "Image a.png", isError: false, images }) };
  const router = new ToolRouter(hands as never);
  const outcome: { isError: boolean; images?: unknown } = { isError: false };
  const text = await router.route("read", { path: "/workspace/a.png" }, undefined, outcome);
  assert.equal(text, "Image a.png");
  assert.deepEqual(outcome.images, images);
});

test("the loop keeps the history's images within the budget as images keep coming", async () => {
  const big = "A".repeat(4 * 1024 * 1024);
  const readCall = (id: string) => ({
    content: [{ type: "tool_use", id, name: "read", input: { path: `/workspace/${id}.png` } }], stopReason: "tool_use",
  });
  const { session, sent } = scripted([readCall("t1"), readCall("t2"), { content: [{ type: "text", text: "seen" }], stopReason: "end_turn" }]);
  const router = {
    route: async (_n: string, _i: unknown, _s: unknown, outcome?: { images?: unknown }) => {
      if (outcome) outcome.images = [{ mediaType: "image/png", data: big }];
      return "Image";
    },
    setHands: () => {},
  } as unknown as ToolRouter;
  await agentLoop([{ role: "user", content: "look" }], [] as ToolSchema[], {
    model: "m", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 5, depth: 0, router,
    sessionId: "s-img2", userId: "u", llmSession: session, onEvent: async () => {},
  });
  const third = sent[2];
  const blocksOf = (id: string) => third.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((b: Record<string, unknown>) => b.tool_use_id === id)!.content as Array<Record<string, unknown>>;
  assert.equal(blocksOf("t2")[1].type, "image", "the newest image is still shown");
  const older = blocksOf("t1")[1];
  assert.equal(older.type, "text", "the older image is no longer sent");
  assert.equal(older.text, IMAGE_DROPPED_TEXT, "it is named instead");
});
