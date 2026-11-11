// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A stand-in for the Bot Connector, for trying the worker without Teams (see ../../docs/quickstart.md). It listens on
// 127.0.0.1 only, prints each message the worker would have posted to Teams, and answers with a made-up activity id.
// Run it with Node 22 or newer: node stand-in-connector.mjs
import { createServer } from "node:http";

const port = Number(process.env.CONNECTOR_PORT ?? "3978");
let sent = 0;

/** `text` with every control character written as a \u escape, so nothing in it can steer the terminal. */
const printable = (text) =>
  Array.from(text, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? `\\u${code.toString(16).padStart(4, "0")}` : char;
  }).join("");

createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks);
    let line = `(not JSON, ${String(body.length)} bytes)`;
    try {
      const activity = JSON.parse(body.toString("utf8"));
      const cards = (activity.attachments ?? []).map((attachment) => attachment.contentType);
      line = JSON.stringify({ type: activity.type, text: activity.text, cards: cards.length ? cards : undefined });
    } catch {
      // (not JSON: only its size is printed)
    }
    // One line per request, with no control character in it.
    const shown = printable(`${request.method ?? ""} ${request.url ?? ""} ${line}`).replace(/\n|\r/g, "");
    console.log(shown);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: `stand-in-${String(++sent)}` }));
  });
}).listen(port, "127.0.0.1", () => {
  console.log(`stand-in Bot Connector on http://127.0.0.1:${String(port)}`);
});
