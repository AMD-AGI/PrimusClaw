// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The files a person sends with a message to the assistant (teams_agent/assistant.py `_hand_over`): fetched through the channel,
 * put in the assistant's session (`.uploads/<folder>/`), and named in the message's `channel_context.files`. A file that could not
 * be fetched or that Claw did not take is named to the person (and counted); the message still goes.
 */
import { errorName } from "../errors.js";
import type { JsonObject } from "../json.js";
import { assistantChatText } from "../locales/assistant-chat.js";
import type { ClawSessionsPort } from "../ports/claw/index.js";
import type { Logger } from "../ports/logger.js";
import type { Conversation, InboundFile } from "../ports/surface.js";
import { refusal, unreachable } from "./failures.js";

/** Where `ClawPort.sessions.uploadFiles` says an upload is; Claw names it by the rest. */
export const UPLOADS_ROOT = "/workspace/.uploads/";

export interface FetchedUpload {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

/** The channel's side of a message's files (W3's inbound): fetching them, and how a failure and a folder are worded. */
export interface MessageFiles {
  fetch(files: readonly InboundFile[]): Promise<{ fetched: FetchedUpload[]; failed: [name: string, why: string][] }>;
  /** The folder under .uploads/ one message's files go to. */
  uploadFolder(messageId: string): string;
  /** What the person is told about files that did not reach the agent. */
  failedLine(failed: readonly (readonly [string, string])[]): string;
}

export interface HandOverDeps {
  readonly claw: Pick<ClawSessionsPort, "uploadFiles">;
  /** Undefined where this worker takes no files: they are named back. */
  readonly files: MessageFiles | undefined;
  readonly logger: Logger;
  /** (path, how many) of a message's files did not reach Claw: counted for /metrics. */
  readonly onDropped: (path: string, count: number) => void;
}

export async function handOver(
  deps: HandOverDeps,
  call: {
    credential: string;
    sessionId: string;
    folder: string;
    files: readonly InboundFile[];
    conversation: Conversation;
  },
): Promise<JsonObject[]> {
  const t = assistantChatText.in("en");
  const got = deps.files
    ? await deps.files.fetch(call.files)
    : { fetched: [], failed: call.files.map((f): [string, string] => [f.name || t.anImage, t.notTaken]) };
  const named: JsonObject[] = [];
  const failed = [...got.failed];
  if (got.fetched.length) {
    let paths: string[];
    let refused: string[];
    try {
      const uploads = got.fetched.map((f) => ({ name: f.name, content: f.bytes, mediaType: f.mediaType }));
      ({ paths, refused } = await deps.claw.uploadFiles(call.credential, call.sessionId, call.folder, uploads));
    } catch (error) {
      if (!(refusal(error) || unreachable(error))) throw error;
      deps.logger.warn("the files of a message to the assistant were not taken", { error: errorName(error) });
      paths = [];
      refused = got.fetched.map((f) => f.name);
    }
    const byName = new Map(paths.map((p) => [p.slice(p.lastIndexOf("/") + 1), p]));
    for (const f of got.fetched) {
      const path = byName.get(f.name) ?? "";
      if (path.startsWith(UPLOADS_ROOT)) {
        named.push({
          path: path.slice(UPLOADS_ROOT.length),
          name: f.name,
          media_type: f.mediaType,
          size: f.bytes.length,
        });
      }
    }
    failed.push(...refused.map((name): [string, string] => [name, t.clawRefused]));
  }
  if (failed.length) {
    deps.onDropped("assistant", failed.length);
    await call.conversation.send({ body: { type: "text", text: (deps.files ?? fallbackWording).failedLine(failed) } });
  }
  return named;
}

/** The wording where no channel file support is given (the Python `inbound.failed_line`, names in code spans). */
const fallbackWording: Pick<MessageFiles, "failedLine"> = {
  failedLine: (failed) =>
    `I could not pass on ${failed.map(([name, why]) => `\`${name.replaceAll("`", "'")}\` (${why})`).join("; ")}.`,
};
