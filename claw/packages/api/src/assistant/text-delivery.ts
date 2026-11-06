// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `deliver_text`: hand the user a file the model wrote, with no sandbox.
 *
 * `deliver_file` copies a file out of a sandbox, so a document a person asks for ("write me a 1500-word introduction, as a markdown
 * file") needed a worker, a sandbox and its workspace, and with no sandbox (a workspace the user may not create workloads in) the
 * text was written and then lost: the worker's file could not be saved and the router only read its one-line report. A text file
 * needs none of that. Its content is the model's own words, so it is stored here, in the object store, as a delivery of the
 * calling turn's session (`<session prefix>.deliveries/<id>/<name>`, the layout Brain's `deliver_file` writes and the download route
 * serves to the session's owner only), and:
 *
 *  - a router's file is announced at once, as one message of the system's own words carrying the file (`AssistantFile`), which a
 *    channel shows as a download, as it shows a worker's;
 *  - a worker's file is announced as every worker delivery is (`deliveries.ts`): after its next report, or at its run's end.
 *
 * The content is redacted as a message is (a key the model copied from what it read is masked), its name is one plain file name with
 * an extension a text file has, and it is at most `TEXT_DELIVERY_MAX_BYTES`. The file reaches the user only, like `say`: it changes
 * nothing anyone else sees, which is why a router may call it after a lookup (`AFTER_READ_TOOLS`).
 */
import { randomUUID } from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { deliveryContentType, deliveryKeyPrefix } from "@claw/protocol";
import pino from "pino";
import { S3_BUCKET } from "../config.js";
import { redactPublicJson } from "../events/redaction.js";
import { db } from "../infra/db.js";
import { getS3Client } from "../infra/s3-client.js";
import type { AssistantFile } from "../notifications/assistant-events.js";
import { sessionWorkspacePrefix } from "../workspace/prefix.js";
import { detectLanguage } from "./language.js";
import { recordSystemNotice, type SayDeps } from "./outbound.js";
import type { AssistantTokenClaims } from "./token.js";
import { assertLiveRun, ToolRefused } from "./tools.js";

const logger = pino({ name: "assistant-text-delivery" });

/** The largest text file delivered: a long document is tens of kilobytes; more is data, which a worker produces. */
export const TEXT_DELIVERY_MAX_BYTES = 256 * 1024;
/** The longest file name. */
export const TEXT_DELIVERY_NAME_MAX = 120;
/** The extensions of a text file a model writes whole: documents, tables, data, configuration and code. */
export const TEXT_DELIVERY_EXTENSIONS = [
  "md", "markdown", "txt", "csv", "tsv", "json", "yaml", "yml", "xml", "toml", "ini", "log", "sql",
  "py", "js", "ts", "sh", "go", "rs", "java", "c", "h", "cpp", "hpp", "rb", "kt", "swift",
] as const;
const CAPTION_MAX = 300;

/** The store, behind a seam so a test can stand in for it. */
export const textDeliveryPorts = {
  put: async (key: string, body: Buffer, contentType: string): Promise<void> => {
    await getS3Client().send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
  },
  newId: (): string => randomUUID(),
  sayDeps: {} as SayDeps,
};

/** The name a text file is stored and offered under, or a refusal that says what a name must be. */
export function textFileName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (
    !name || name.length > TEXT_DELIVERY_NAME_MAX || /[\x00-\x1f\x7f"\\/:*?<>|`]/.test(name) || name.startsWith(".")
    || !(TEXT_DELIVERY_EXTENSIONS as readonly string[]).includes(ext)
  ) {
    throw new ToolRefused(
      "invalid_name",
      `name must be one file name of at most ${TEXT_DELIVERY_NAME_MAX} characters, no folders, ending in a text file's extension (.md, .txt, .csv, .json, .yaml, a code file's): for example k8s-scheduler.md`,
    );
  }
  return name;
}

function sizeText(size: number): string {
  return size < 1024 ? `${size} B` : `${Math.round(size / 1024)} KB`;
}

/** The system's line that carries a router's file, in the language the file (or its caption) is written in. */
export function textDeliveryLine(name: string, size: number, language: string | null): string {
  const shown = `\`${name.replace(/`/g, "'")}\``;
  return language === "Chinese" ? `文件：${shown}（${sizeText(size)}）` : `File: ${shown} (${sizeText(size)})`;
}

export interface TextDeliveryOutcome {
  ok: true;
  delivered: { name: string; size: number };
  /** What the caller does next, in words the model reads. */
  note: string;
}

/**
 * Store `text` as the file `name` in the calling turn's session and hand it to the user: at once for a router, with the worker's next
 * report for a worker. Refused for a turn that is not live, a name that is not a text file's, an empty or too large text.
 */
export async function deliverText(
  claims: AssistantTokenClaims, args: { name?: unknown; text?: unknown; caption?: unknown }, deps: SayDeps = textDeliveryPorts.sayDeps,
): Promise<TextDeliveryOutcome> {
  if (claims.role !== "router" && claims.role !== "worker") {
    throw new ToolRefused("not_allowed", `this tool is for the router or a worker, not the ${claims.role}`);
  }
  const name = textFileName(args.name);
  const raw = typeof args.text === "string" ? args.text : "";
  if (!raw.trim()) throw new ToolRefused("empty", "text is the whole content of the file, and it is empty");
  // Masked as a message is: what the model copied from a page or a tool may hold a key.
  const text = String(redactPublicJson(raw) ?? "");
  const body = Buffer.from(text, "utf8");
  if (body.length > TEXT_DELIVERY_MAX_BYTES) {
    throw new ToolRefused(
      "too_large",
      `the file is ${body.length} bytes; at most ${TEXT_DELIVERY_MAX_BYTES} are delivered this way. Split it into several files, or start a work item for data this large`,
    );
  }
  const caption = typeof args.caption === "string" ? args.caption.replace(/\s+/g, " ").trim().slice(0, CAPTION_MAX) : "";
  const { userId } = await assertLiveRun((t, p) => db.query(t, p), claims);
  const id = textDeliveryPorts.newId();
  const contentType = deliveryContentType(name);
  await textDeliveryPorts.put(`${deliveryKeyPrefix(sessionWorkspacePrefix(userId, claims.sid), id)}${name}`, body, contentType);
  logger.info({ sid: claims.sid, role: claims.role, bytes: body.length }, "assistant.text_delivered");

  if (claims.role === "worker") {
    return {
      ok: true, delivered: { name, size: body.length },
      note: "stored: the user gets it as a download together with your next report. Report now; do not paste the text into the report.",
    };
  }
  const file: AssistantFile = {
    session_id: claims.sid, id, name: String(redactPublicJson(name) ?? name), size: body.length, content_type: contentType,
  };
  const language = detectLanguage(caption || text.slice(0, 2000));
  const line = textDeliveryLine(name, body.length, language);
  const told = await recordSystemNotice({
    userId, sessionId: claims.sid, key: `text_delivery:${id}`, text: caption ? `${line}\n${caption}` : line, files: [file],
  }, deps);
  if (!told) throw new ToolRefused("not_delivered", "the file was stored but its message could not be recorded; call deliver_text once more");
  return {
    ok: true, delivered: { name, size: body.length },
    note: "the user has the file as a download now. Say one short line about it (what it is); never paste its text into say.",
  };
}
