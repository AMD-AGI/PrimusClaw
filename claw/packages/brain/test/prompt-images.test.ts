// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The images a person sent with a message, shown to the model with the prompt (`request.prompt_images`,
 * `agent/prompt-images.ts`): what an assistant's router turn sees of a screenshot, since it has no sandbox to `read` it in.
 *
 *   PI1 through the real engine: the first request to the model carries the prompt's text and then the image, as an Anthropic
 *       image block with the bytes the session's upload holds, read at `users/<owner>/sessions/<id>/.uploads/<path>`
 *   PI2 only the session's own `.uploads/`: a path outside it (absolute, `..`, another directory, a backslash) is never read
 *   PI3 an image that cannot be shown is a line, never a block: missing, too large, not an image, a damaged PNG, a failed read
 *   PI4 at most PROMPT_IMAGES_MAX images go with one prompt; the rest are named
 *   PI5 the OpenAI wire sends the picture as an image part, never its base64 as text
 *   PI6 no prompt_images: the prompt is the same text it always was
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Message } from "@claw/protocol";
import { startWorld, fakeHands, baseRequest } from "./support/platform-defaults-world.js";

// The fake model endpoint first: Brain reads where the model is when its config is first imported.
const world = await startWorld();
const { AgentEngine } = await import("../src/agent/engine.js");
const { loadPromptImages, promptContent, promptImagePath, PROMPT_IMAGES_MAX } = await import("../src/agent/prompt-images.js");
const { toOpenAiMessages } = await import("../src/llm/openai-provider.js");

/** A whole 1x1 PNG: IHDR, IDAT and IEND with good CRCs. */
function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.from([0, 255, 0, 0]))), chunk("IEND", Buffer.alloc(0)),
  ]);
}
const PNG = png();

test("PI2 only the session's own uploads are read", async () => {
  for (const bad of ["/etc/passwd", ".uploads/../secret.png", "other/a.png", ".uploads/a\\b.png", ".uploads//a.png", ".uploads/", ".uploads/./a.png", "", 3]) {
    assert.equal(promptImagePath(bad), null, String(bad));
  }
  assert.equal(promptImagePath(".uploads/teams/m1/a.png"), ".uploads/teams/m1/a.png");
  const asked: string[] = [];
  const out = await loadPromptImages(["/etc/passwd", ".uploads/../x.png", ".uploads/teams/m1/a.png"], "users/u1/sessions/s1/", async (key) => {
    asked.push(key);
    return PNG;
  });
  assert.deepEqual(asked, ["users/u1/sessions/s1/.uploads/teams/m1/a.png"]);
  assert.equal(out.images.length, 1);
  assert.equal(out.images[0].mediaType, "image/png");
  assert.equal(out.images[0].data, PNG.toString("base64"));
});

test("PI3 an image that cannot be shown is a line, never a block", async () => {
  const damaged = Buffer.from(PNG);
  damaged[damaged.length - 1] ^= 0xff;   // IEND's CRC
  const files: Record<string, Buffer | null | "too_large"> = {
    "missing.png": null, "big.png": "too_large", "text.png": Buffer.from("not an image at all"), "damaged.png": damaged,
  };
  const out = await loadPromptImages(
    [...Object.keys(files), "boom.png"].map((n) => `.uploads/t/${n}`), "users/u1/sessions/s1/",
    async (key) => {
      const name = key.slice(key.lastIndexOf("/") + 1);
      if (name === "boom.png") throw new Error("store down");
      return files[name]!;
    },
  );
  assert.equal(out.images.length, 0);
  assert.equal(out.notes.length, 5);
  for (const name of ["missing.png", "big.png", "text.png", "damaged.png", "boom.png"]) {
    assert.ok(out.notes.some((n) => n.includes(name)), name);
  }
  assert.equal(promptContent("hi", out), `hi\n\n${out.notes.join("\n")}`, "only text when nothing could be shown");
});

test("PI4 at most PROMPT_IMAGES_MAX images go with one prompt", async () => {
  const paths = Array.from({ length: PROMPT_IMAGES_MAX + 2 }, (_, i) => `.uploads/t/p${i}.png`);
  const out = await loadPromptImages(paths, "users/u1/sessions/s1/", async () => PNG);
  assert.equal(out.images.length, PROMPT_IMAGES_MAX);
  assert.equal(out.notes.length, 2);
  const content = promptContent("look", out) as Array<Record<string, unknown>>;
  assert.equal(content[0].type, "text");
  assert.equal(content.filter((b) => b.type === "image").length, PROMPT_IMAGES_MAX);
});

test("PI5 the OpenAI wire sends the picture as an image part, never its base64 as text", () => {
  const messages: Message[] = [{
    role: "user",
    content: [{ type: "text", text: "what is red here?" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } }],
  }];
  const out = toOpenAiMessages(messages) as Array<{ role: string; content: unknown }>;
  assert.equal(out.length, 1);
  const parts = out[0].content as Array<Record<string, any>>;
  assert.ok(Array.isArray(parts), "a content array, not one text");
  assert.deepEqual(parts[0], { type: "text", text: "what is red here?" });
  assert.equal(parts[1].type, "image_url");
  assert.equal(parts[1].image_url.url, `data:image/png;base64,${PNG.toString("base64")}`);
  // A user message without a picture is unchanged: one text.
  const plain = toOpenAiMessages([{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }]) as Array<{ content: unknown }>;
  assert.equal(plain[0].content, "a\nb");
});

// --- through the engine ------------------------------------------------------------------------------------------------

const objects = new Map<string, Buffer>();
const asked: string[] = [];
const originalSend = S3Client.prototype.send;
S3Client.prototype.send = (async function (command: unknown) {
  if (command instanceof GetObjectCommand) {
    const key = command.input.Key ?? "";
    asked.push(key);
    const body = objects.get(key);
    if (!body) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
    return { Body: Readable.from([body]), ContentLength: body.length };
  }
  throw new Error(`unexpected S3 call ${(command as object).constructor.name}`);
}) as typeof S3Client.prototype.send;
test.after(async () => {
  S3Client.prototype.send = originalSend;
  await world.close();
});

async function firstUserContent(request: Record<string, unknown>): Promise<unknown> {
  world.script([{ text: "a red square" }]);
  world.llmBodies.length = 0;
  await new AgentEngine().execute(
    baseRequest(request) as never, (async () => {}) as never, undefined, null as never,
    { attachHands: async () => fakeHands() as never } as never,
  );
  const body = JSON.parse(world.llmBodies[0]) as { messages: Array<{ role: string; content: unknown }> };
  return body.messages.filter((m) => m.role === "user")[0].content;
}

test("PI1 through the engine: the model is sent the prompt's text and then the image the upload holds", async () => {
  asked.length = 0;
  objects.set("users/u1/sessions/s-img/.uploads/teams/m1/screen.png", PNG);
  const content = await firstUserContent({
    session_id: "s-img", user_id: "u1", prompt: "what colour is this?", prompt_images: [".uploads/teams/m1/screen.png", "/etc/passwd"],
  }) as Array<Record<string, any>>;
  assert.deepEqual(asked, ["users/u1/sessions/s-img/.uploads/teams/m1/screen.png"], "only the session's own upload is read");
  assert.ok(Array.isArray(content), "the prompt is text and an image");
  const text = content.filter((b) => b.type === "text").map((b) => String(b.text)).join("\n");
  assert.ok(text.includes("what colour is this?"));
  const images = content.filter((b) => b.type === "image");
  assert.equal(images.length, 1);
  assert.deepEqual(images[0].source, { type: "base64", media_type: "image/png", data: PNG.toString("base64") });
});

test("PI6 no prompt_images: the prompt is the text it always was, and nothing is read", async () => {
  asked.length = 0;
  const content = await firstUserContent({ session_id: "s-plain", user_id: "u1", prompt: "hello there" });
  assert.deepEqual(asked, []);
  const text = typeof content === "string" ? content : JSON.stringify(content);
  assert.ok(text.includes("hello there"));
  assert.ok(!text.includes("\"image\""));
});
