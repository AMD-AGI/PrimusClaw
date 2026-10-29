// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One command in a session's EXISTING sandbox, through Hands' `bash` tool.
 *
 * What this does not do is as important as what it does: it never creates a
 * sandbox, never wakes one, never touches the registry. The caller read a Hands
 * address and token for the session out of the registry (the entry Brain wrote
 * when the sandbox became ready); this connects to that address with that token,
 * runs one foreground command with a short timeout, and disconnects. A sandbox
 * that is gone answers nothing, which is a {@link SandboxUnreachableError}, and the
 * route turns that into "not running" instead of starting a new one.
 *
 * The call carries no owner and no run, so nothing a run owns is reaped or
 * disturbed by it, and what it starts is a short foreground command that Hands
 * stops itself at the timeout.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handsCredentialHeaders } from "@claw/protocol";

/** Where a session's sandbox can be reached, as the registry holds it. */
export interface HandsTarget {
  url: string;
  token: string;
}

/** The sandbox did not answer: gone, reclaimed, restarting, or not the one the entry describes. */
export class SandboxUnreachableError extends Error {
  constructor(readonly reason: string) {
    super(`sandbox unreachable: ${reason}`);
    this.name = "SandboxUnreachableError";
  }
}

const CONNECT_TIMEOUT_MS = 10_000;
/** What the connection may take beyond the command's own timeout. */
const CALL_SLACK_MS = 10_000;

export interface ExecResult {
  text: string;
  /** The command exited non-zero or timed out (Hands' own flag). */
  isError: boolean;
}

export async function execInSandbox(target: HandsTarget, command: string, timeoutSec: number): Promise<ExecResult> {
  const client = new Client({ name: "claw-api", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(target.url), {
    requestInit: { headers: handsCredentialHeaders(target.url, target.token) },
  });
  try {
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    } catch (err) {
      throw new SandboxUnreachableError(`connect: ${(err as Error)?.message ?? err}`);
    }
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      result = await client.callTool(
        { name: "bash", arguments: { command, timeout: timeoutSec } },
        undefined,
        { timeout: timeoutSec * 1000 + CALL_SLACK_MS },
      );
    } catch (err) {
      throw new SandboxUnreachableError(`call: ${(err as Error)?.message ?? err}`);
    }
    const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
    const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    return { text, isError: (result as { isError?: boolean }).isError === true };
  } finally {
    await client.close().catch(() => { /* the connection is gone either way */ });
  }
}
