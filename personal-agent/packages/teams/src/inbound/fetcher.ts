// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Fetches the files `inboundFiles` found: a pasted image from the Bot Connector with the bot's token (and only from a
 * Bot Connector host), a sent file's download link without one (https only). Files off the allowlist are never fetched,
 * a pasted image whose bytes are no PNG, JPEG, GIF or WebP is not passed on, and each fetched file gets a name that is
 * one safe path component. File names, URLs and bytes are never logged.
 */
import {
  err,
  ok,
  silentLogger,
  type Clock,
  type FetchedFile,
  type FileRefused,
  type InboundFile,
  type Logger,
  type Result,
} from "@primusclaw/personal-agent";
import { DEFAULT_CONNECTOR_HOSTS, type ServiceUrlPolicy } from "../connector/hosts.js";
import { teamsFileHandle, type TeamsFileHandle } from "./attachments.js";
import { download, NotFetched, type FetchLike } from "./download.js";
import { safeName } from "./names.js";
import { imageType, PASTED_IMAGE_TYPES, refusedType } from "./types.js";

/** Per message; the rest are named back to the user. */
export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** The bot's Bot Connector token source (the one direct delivery uses). */
export interface BotTokens {
  get(): Promise<string>;
}

export interface TeamsFileFetcherOptions {
  readonly fetch: FetchLike;
  readonly clock: Clock;
  /** Without one (the worker is on the queue path) a pasted image cannot be fetched and is reported as such. */
  readonly tokens?: BotTokens | undefined;
  /** Where the bot's token may go (the Bot Connector hosts; the release gate's recording connector in its test entry). */
  readonly hosts?: ServiceUrlPolicy;
  /**
   * The release gate's test entry only: a plain-http prefix (the gate's own files on 127.0.0.1) a download link may
   * start with. "" (production): a link that needs no token must be https.
   */
  readonly plainPrefix?: string;
  readonly maxFileBytes?: number;
  readonly logger?: Logger;
}

/** A file that did not get through: the name it is shown by (`shownFileName`) and why, in words for the user. */
export interface FailedFile {
  readonly name: string;
  readonly reason: string;
}

export interface FetchedFiles {
  readonly fetched: FetchedFile[];
  readonly failed: FailedFile[];
}

/** The name a file is called by when it is said back: its own, or "image <n>" for a pasted image (1-based). */
export function shownFileName(file: InboundFile, index: number): string {
  return file.name || `image ${String(index)}`;
}

export class TeamsFileFetcher {
  private readonly fetchImpl: FetchLike;
  private readonly clock: Clock;
  private readonly tokens: BotTokens | undefined;
  private readonly hosts: ServiceUrlPolicy;
  private readonly plainPrefix: string;
  private readonly maxFileBytes: number;
  private readonly logger: Logger;

  constructor(options: TeamsFileFetcherOptions) {
    this.fetchImpl = options.fetch;
    this.clock = options.clock;
    this.tokens = options.tokens;
    this.hosts = options.hosts ?? DEFAULT_CONNECTOR_HOSTS;
    this.plainPrefix = options.plainPrefix ?? "";
    this.maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
    this.logger = options.logger ?? silentLogger;
  }

  /**
   * The files of one message: those fetched, and the rest with why not. Never fails for one file: the others still go.
   * Two files with one name do not overwrite each other (the later one is prefixed with its place).
   */
  async fetchAll(files: readonly InboundFile[]): Promise<FetchedFiles> {
    const fetched: FetchedFile[] = [];
    const failed: FailedFile[] = [];
    const names = new Set<string>();
    for (const [at, file] of files.entries()) {
      const index = at + 1;
      const got = await this.fetchOne(file, index);
      if (typeof got === "string") {
        failed.push({ name: shownFileName(file, index), reason: got });
        continue;
      }
      let name = got.name;
      while (names.has(name)) name = `${String(index)}-${name}`;
      names.add(name);
      fetched.push({ ...got, name });
    }
    return { fetched, failed };
  }

  /** `Surface.fetchFile`: one file, numbered by its place in its message (`handle.index`). */
  async fetchFile(file: InboundFile): Promise<Result<FetchedFile, FileRefused>> {
    const handle = teamsFileHandle.safeParse(file.handle);
    const got = await this.fetchOne(file, handle.success ? handle.data.index : 1);
    return typeof got === "string" ? err({ kind: "file_refused", reason: got }) : ok(got);
  }

  /** The file, or why it was not fetched. */
  private async fetchOne(file: InboundFile, index: number): Promise<FetchedFile | string> {
    if (index > MAX_FILES) return `only ${String(MAX_FILES)} files are taken from one message`;
    const why = refusedType(file);
    if (why) return why; // never fetched
    const handle = teamsFileHandle.safeParse(file.handle);
    if (!handle.success) return "it is not a file this worker can fetch";
    try {
      const got = await download(handle.data.url, await this.headers(handle.data), {
        fetch: this.fetchImpl,
        clock: this.clock,
        logger: this.logger,
        maxBytes: this.maxFileBytes,
      });
      if (handle.data.kind === "pasted" && !PASTED_IMAGE_TYPES.includes(imageType(got.bytes))) {
        return "it is not a PNG, JPEG, GIF or WebP image";
      }
      return { name: safeName(file.name, got.bytes, index), mediaType: got.mediaType, bytes: got.bytes };
    } catch (error) {
      if (error instanceof NotFetched) return error.message;
      throw error;
    }
  }

  /** The request headers for `handle`; throws NotFetched when the file may not be fetched at all. */
  private async headers(handle: TeamsFileHandle): Promise<Record<string, string>> {
    if (handle.kind === "download") {
      const plain = this.plainPrefix !== "" && handle.url.startsWith(this.plainPrefix);
      if (!handle.url.startsWith("https://") && !plain) throw new NotFetched("its link is not https");
      return {};
    }
    try {
      this.hosts.check(handle.url); // the bot's token goes to a Bot Connector host and nowhere else
    } catch {
      throw new NotFetched("it is not on a Teams address");
    }
    if (this.tokens === undefined) throw new NotFetched("this worker has no Teams token to fetch it with");
    try {
      return { Authorization: `Bearer ${await this.tokens.get()}` };
    } catch (error) {
      // the token source's own error says nothing the user can act on
      this.logger.warn("no bot token for an attachment", {
        errorName: error instanceof Error ? error.name : "unknown",
      });
      throw new NotFetched("Teams did not give me a token to fetch it with");
    }
  }
}
