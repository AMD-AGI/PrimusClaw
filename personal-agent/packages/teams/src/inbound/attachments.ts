// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The files a message brings, read from `activity.attachments`, next to the `text/html` copy of the message and any
 * cards:
 *  - an image pasted into the message: `contentType` "image/*" (or a concrete image type) and a `contentUrl` on the Bot
 *    Connector, fetched with the bot's own token;
 *  - a file sent in a 1:1 chat: `contentType` FILE_DOWNLOAD_INFO, whose `content.downloadUrl` is a short-lived link
 *    that needs no token (Teams sends these only to a bot whose manifest says `supportsFiles: true`);
 *  - anything else that names a file (a file shared into a group chat is a link to SharePoint, which the bot has no
 *    right to read): reported back to the user by name, never fetched.
 */
import { z } from "zod";
import { cpHead, pyStr, type InboundFile } from "@primusclaw/personal-agent";

export const FILE_DOWNLOAD_INFO = "application/vnd.microsoft.teams.file.download.info";

/** How a file is fetched: a pasted image from the Bot Connector with the bot's token, or a download link without one. */
export type TeamsFileKind = "pasted" | "download";

/** What `InboundFile.handle` holds for a Teams file: where it is, how to fetch it, its 1-based place among the files. */
export interface TeamsFileHandle {
  readonly kind: TeamsFileKind;
  readonly url: string;
  readonly index: number;
}

export const teamsFileHandle = z.object({
  kind: z.enum(["pasted", "download"]),
  url: z.string(),
  index: z.number().int().positive(),
});

/** The files of a message the worker can fetch, and the names of those it cannot. */
export interface MessageFiles {
  readonly files: InboundFile[];
  readonly unreadable: string[];
}

const record = z.record(z.string(), z.unknown());
const activitySchema = z.object({ attachments: z.unknown().optional() });

/** `x if isinstance(x, dict) else {}`. */
function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  const parsed = record.safeParse(value);
  return parsed.success ? parsed.data : {};
}

/** `activity.get("attachments") or []`, the entries that are objects. */
function attachmentsOf(activity: unknown): Readonly<Record<string, unknown>>[] {
  const parsed = activitySchema.safeParse(activity);
  const list = parsed.success ? parsed.data.attachments : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    const entry = record.safeParse(item);
    return entry.success ? [entry.data] : [];
  });
}

function teamsFile(name: string, type: string, handle: TeamsFileHandle): InboundFile {
  return { name, type, handle: { ...handle } };
}

/** The type Teams gives a sent file (`content.fileType`): lower case, without a leading dot, at most 20 characters. */
function sentFileType(value: unknown): string {
  return cpHead(pyStr(value).toLowerCase().replace(/^\.+/, ""), 20);
}

/** (the files of `activity` the worker can fetch, the names of those it cannot). */
export function inboundFiles(activity: unknown): MessageFiles {
  const files: InboundFile[] = [];
  const unreadable: string[] = [];
  for (const attachment of attachmentsOf(activity)) {
    const kind = pyStr(attachment["contentType"]).toLowerCase();
    const name = pyStr(attachment["name"]);
    const content = asRecord(attachment["content"]);
    const contentUrl = attachment["contentUrl"];
    const downloadUrl = content["downloadUrl"];
    const index = files.length + 1;
    if (kind.startsWith("image/") && typeof contentUrl === "string") {
      files.push(teamsFile(name, "", { kind: "pasted", url: contentUrl, index }));
    } else if (kind === FILE_DOWNLOAD_INFO && typeof downloadUrl === "string") {
      files.push(teamsFile(name, sentFileType(content["fileType"]), { kind: "download", url: downloadUrl, index }));
    } else if (name && kind !== "text/html" && !kind.startsWith("application/vnd.microsoft.card.")) {
      unreadable.push(name);
    }
  }
  return { files, unreadable };
}
