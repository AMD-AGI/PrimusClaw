// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A stand-in for the `claude` command, for `claude agents --json` only: prints the file FAKE_CLAUDE_LIVE names
// (a JSON array of {pid, sessionId, cwd, kind, status}) and records the config directory it was run with.
// FAKE_CLAUDE_MODE: ok | garbage (not JSON) | fail (exit 2) | hang (never answers) | notlist (a JSON object).
import fs from "node:fs";

const args = process.argv.slice(2).join(" ");
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, config: process.env.CLAUDE_CONFIG_DIR ?? null }) + "\n");
const mode = process.env.FAKE_CLAUDE_MODE || "ok";
if (args !== "agents --json") { process.stderr.write("unknown command\n"); process.exit(1); }
if (mode === "fail") { process.stderr.write("boom\n"); process.exit(2); }
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "garbage") process.stdout.write("this is not json\n");
else if (mode === "notlist") process.stdout.write("{}\n");
else process.stdout.write((process.env.FAKE_CLAUDE_LIVE && fs.existsSync(process.env.FAKE_CLAUDE_LIVE) ? fs.readFileSync(process.env.FAKE_CLAUDE_LIVE, "utf8") : "[]") + "\n");
