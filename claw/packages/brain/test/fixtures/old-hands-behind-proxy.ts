// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A HandsClient whose transport does what the sandbox Router's port proxy
 * does to a foreground `bash`: it holds the request for as long as the Hands
 * behind it lets the command run, and cuts it with a 502 at 120s.
 *
 * The Hands behind it is an older one, with the ceiling and default it was
 * handed when its sandbox started, because a reused sandbox keeps the Hands it
 * was started with -- so the number Brain sends has to be the one that applies.
 * The command it runs never ends on its own, so every call is answered by the
 * timeout, exactly as Hands words it.
 */
import { HandsClient } from "../../src/clients/hands.js";

export const PROXY_HEADER_LIMIT_SEC = 120;
/** Time the call spends outside the command itself, kill grace included. */
export const TRANSPORT_SEC = 6;

export interface Seen { args: Record<string, unknown>; deadlineMs: number }

export function oldHandsBehindProxy(
  seen: Seen[],
  old: { maxSec: number; defaultSec: number },
): HandsClient {
  const hands = new HandsClient("http://sandbox:9100/mcp", "tok", "sess-1", "ktsk_1");
  const raw = hands as unknown as { connected: boolean; recordsCapability: boolean; client: unknown };
  raw.connected = true;
  raw.recordsCapability = true;
  raw.client = {
    callTool: async (req: { arguments: Record<string, unknown> }, _schema: unknown, opts: { timeout: number }) => {
      seen.push({ args: req.arguments, deadlineMs: opts.timeout });
      const asked = req.arguments.timeout;
      const requested = typeof asked === "number" ? asked : old.defaultSec;
      const granted = Math.min(requested, old.maxSec);
      if (granted + TRANSPORT_SEC >= PROXY_HEADER_LIMIT_SEC) {
        throw new Error("Streamable HTTP error: Error POSTing to endpoint: sandbox service unreachable on port 9100");
      }
      return {
        content: [{
          type: "text",
          text: `timeout after ${granted}s (killed the whole process group, so nothing survived).`
            + `\nstdout: epoch 7 loss 0.31\nstderr: `,
        }],
        isError: true,
        structuredContent: { outcome: "foreground_timeout", granted_sec: granted, clamped: granted < requested },
      };
    },
  };
  return hands;
}
