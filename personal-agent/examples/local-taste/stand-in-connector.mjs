// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A stand-in for the Bot Connector, for trying the worker without Teams (see ../../docs/quickstart.md). It listens on
// 127.0.0.1 only, prints each message the worker would have posted to Teams, and answers with a made-up activity id.
// Run it with Node 22 or newer: node stand-in-connector.mjs
import { createServer } from "node:http";

const port = Number(process.env.CONNECTOR_PORT ?? "3978");
let sent = 0;

createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    let line = body;
    try {
      const activity = JSON.parse(body);
      const cards = (activity.attachments ?? []).map((attachment) => attachment.contentType);
      line = JSON.stringify({ type: activity.type, text: activity.text, cards: cards.length ? cards : undefined });
    } catch {
      // (not JSON: printed as it came, without its line breaks)
    }
    // One line per request: line breaks in what was sent are dropped, so none can start a line of its own here.
    const path = (request.url ?? "").replace(/\n|\r/g, "");
    console.log(`${request.method ?? ""} ${path} ${line.replace(/\n|\r/g, "")}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: `stand-in-${++sent}` }));
  });
}).listen(port, "127.0.0.1", () => {
  console.log(`stand-in Bot Connector on http://127.0.0.1:${port}`);
});
