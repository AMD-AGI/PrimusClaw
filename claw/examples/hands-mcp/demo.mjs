// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Drives the Hands MCP server over HTTP with the same client transport Brain
// uses, exercising the tools an agent would call. No Kubernetes, no GPU, no LLM
// key: Hands is a self-contained MCP server whose only inputs are a workspace
// directory, a port and a shared token.
//
// Paths below are relative because Hands resolves every path against the
// workspace root (see workspace/path-guard.ts).
//
// Started by run.sh, which supplies HANDS_URL and HANDS_TOKEN.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const HANDS_URL = process.env.HANDS_URL;
const HANDS_TOKEN = process.env.HANDS_TOKEN;

if (!HANDS_URL || !HANDS_TOKEN) {
  console.error("HANDS_URL and HANDS_TOKEN must be set (run via run.sh)");
  process.exit(2);
}

let failures = 0;

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Tool results arrive as a content array; join the text parts. */
function text(result) {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

const client = new Client({ name: "hands-demo", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(HANDS_URL), {
    requestInit: { headers: { Authorization: `Bearer ${HANDS_TOKEN}` } },
  }),
);

const call = (name, args) => client.callTool({ name, arguments: args });

const { tools } = await client.listTools();
console.log(`\nConnected. Hands advertises ${tools.length} tools:`);
console.log(`  ${tools.map((t) => t.name).join(", ")}\n`);

console.log("write / read — create a file and read it back");
await call("write", { path: "greeting.txt", contents: "hello\nworld\n" });
check("file created", text(await call("read", { path: "greeting.txt" })).includes("hello"));

console.log("\nedit — replace a unique string");
await call("edit", { path: "greeting.txt", old_string: "world", new_string: "sandbox" });
const edited = text(await call("read", { path: "greeting.txt" }));
check("edit applied", edited.includes("sandbox"));
check("untouched line kept", edited.includes("hello"));

console.log("\nedit — a non-unique old_string is refused rather than applied blindly");
await call("write", { path: "dup.txt", contents: "x\nx\n" });
const ambiguous = await call("edit", { path: "dup.txt", old_string: "x", new_string: "y" });
// Hands reports tool failures in-band, as text beginning with "Error:", rather
// than by setting the MCP `isError` flag. The agent reads that string.
check("ambiguous edit refused", /Error: old_string found 2 times/.test(text(ambiguous)), text(ambiguous));
check("file left unmodified", !text(await call("read", { path: "dup.txt" })).includes("y"));

console.log("\nedit — `$&` in the replacement is inserted literally, not expanded");
await call("write", { path: "dollar.txt", contents: "PLACEHOLDER\n" });
await call("edit", {
  path: "dollar.txt",
  old_string: "PLACEHOLDER",
  new_string: "cost: $& and $1",
});
const dollar = text(await call("read", { path: "dollar.txt" }));
check("`$&` and `$1` written literally", dollar.includes("cost: $& and $1"), dollar.trim());

console.log("\ngrep / glob / ls — search the workspace");
check(
  "grep finds the edited text",
  text(await call("grep", { pattern: "sandbox" })).includes("greeting.txt"),
);
check(
  "glob matches *.txt",
  text(await call("glob", { pattern: "*.txt" })).includes("greeting.txt"),
);
check("ls lists the workspace", text(await call("ls", {})).includes("greeting.txt"));

console.log("\nbash — run a command in the workspace");
check(
  "bash output returned",
  text(await call("bash", { command: "wc -l < greeting.txt" })).includes("2"),
);

console.log("\nauth — a wrong token must be rejected");
try {
  const bad = new Client({ name: "hands-demo-bad", version: "1.0.0" });
  await bad.connect(
    new StreamableHTTPClientTransport(new URL(HANDS_URL), {
      requestInit: { headers: { Authorization: "Bearer wrong-token" } },
    }),
  );
  check("unauthenticated request refused", false, "connect unexpectedly succeeded");
} catch {
  check("unauthenticated request refused", true);
}

await client.close();

console.log(
  `\n${failures === 0 ? "demo: all checks passed" : `demo: ${failures} check(s) failed`}`,
);
process.exit(failures === 0 ? 0 : 1);
